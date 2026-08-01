import { open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { loadConfig, type BaseMode } from "./config.js";
import { GitError, runGit } from "./git.js";
import { listRecords, readRecord, recordPath, removeRecord, writeRecordAtomic, type WorktreeRecord } from "./metadata.js";
import { createLeaseUnlocked, listLiveLeasesUnlocked, withWorktreeLock } from "./leases.js";
import { canonicalExisting, canonicalPlanned, ensureRealDirectory, isContained, assertNotSymlink } from "./paths.js";
import { parseWorktreePorcelain, type WorktreePorcelainEntry } from "./porcelain.js";

const SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const EXCLUDE_LINE = "/.pi/worktrees/";

export interface RepositoryContext {
  sourceRoot: string;
  primaryRoot: string;
  commonDir: string;
  worktrees: WorktreePorcelainEntry[];
}

export interface PreparedWorktree {
  repo: RepositoryContext;
  record: WorktreeRecord;
  created: boolean;
  warning?: string;
}

export interface ManagedStatus {
  record: WorktreeRecord;
  clean: boolean;
  head: string;
}

export function validateSlug(name: string): void {
  if (!SLUG.test(name)) {
    throw new Error("Worktree name must match [a-z0-9][a-z0-9-]{0,47}");
  }
}

export async function validateName(name: string, cwd: string): Promise<void> {
  validateSlug(name);
  await runGit(["check-ref-format", "--branch", `worktree-${name}`], cwd);
}

export async function resolveRepository(cwd: string): Promise<RepositoryContext> {
  let bare: string;
  try { bare = (await runGit(["rev-parse", "--is-bare-repository"], cwd)).stdout.trim(); }
  catch (error) { throw new Error(`Not inside a Git repository: ${error instanceof Error ? error.message : String(error)}`); }
  if (bare === "true") throw new Error("Bare repositories are not supported");

  const sourceRoot = await canonicalExisting((await runGit(["rev-parse", "--show-toplevel"], cwd)).stdout.trim());
  await runGit(["rev-parse", "--verify", "HEAD^{commit}"], sourceRoot).catch((error: unknown) => {
    throw new Error(`Repository has no committed HEAD (unborn HEAD is unsupported): ${error instanceof Error ? error.message : String(error)}`);
  });
  const commonOutput = (await runGit(["rev-parse", "--git-common-dir"], sourceRoot)).stdout.trim();
  const commonDir = await canonicalExisting(resolve(sourceRoot, commonOutput));
  const worktrees = parseWorktreePorcelain((await runGit(["worktree", "list", "--porcelain", "-z"], sourceRoot)).stdout);
  const first = worktrees[0];
  if (!first || first.bare) throw new Error("Could not resolve the primary non-bare checkout");
  const primaryRoot = await canonicalExisting(first.path);
  return { sourceRoot, primaryRoot, commonDir, worktrees };
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      return async () => { await handle.close(); await rm(path, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error(`Could not acquire lock ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
}

export async function ensureManagedExclude(repo: RepositoryContext): Promise<void> {
  const infoDir = join(repo.commonDir, "info");
  await ensureRealDirectory(infoDir, "Git info directory");
  const exclude = join(infoDir, "exclude");
  await assertNotSymlink(exclude, "Git info/exclude");
  const release = await acquireLock(`${exclude}.pi-worktree.lock`);
  try {
    let contents = "";
    try { contents = await readFile(exclude, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (contents.split(/\r?\n/).includes(EXCLUDE_LINE)) return;
    const next = `${contents}${contents.length > 0 && !contents.endsWith("\n") ? "\n" : ""}${EXCLUDE_LINE}\n`;
    const temporary = `${exclude}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
    try { await rename(temporary, exclude); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
  } finally {
    await release();
  }
}

async function assertManagedPathsSafe(repo: RepositoryContext): Promise<string> {
  const piDir = join(repo.primaryRoot, ".pi");
  await assertNotSymlink(piDir, "Project .pi directory");
  await ensureRealDirectory(piDir, "Project .pi directory");
  const root = join(piDir, "worktrees");
  await assertNotSymlink(root, "Managed worktree root");
  await ensureRealDirectory(root, "Managed worktree root");
  const canonicalRoot = await canonicalExisting(root);
  if (canonicalRoot !== root) throw new Error(`Managed worktree root is not canonical: ${root}`);

  const tracked = (await runGit(["ls-files", "-z", "--", ".pi/worktrees"], repo.primaryRoot)).stdout;
  if (tracked.length > 0) throw new Error("Refusing to use .pi/worktrees because it contains tracked paths");
  return canonicalRoot;
}

async function assertNoCaseCollision(root: string, name: string): Promise<void> {
  for (const entry of await readdir(root)) {
    if (entry !== name && entry.toLowerCase() === name.toLowerCase()) {
      throw new Error(`Worktree name has a case-insensitive path collision with ${JSON.stringify(entry)}`);
    }
  }
}

async function resolveBase(mode: BaseMode, repo: RepositoryContext): Promise<{ oid: string; warning?: string }> {
  if (mode === "head") {
    return { oid: (await runGit(["rev-parse", "--verify", "HEAD^{commit}"], repo.sourceRoot)).stdout.trim() };
  }
  try {
    return { oid: (await runGit(["rev-parse", "--verify", "refs/remotes/origin/HEAD^{commit}"], repo.sourceRoot)).stdout.trim() };
  } catch (error) {
    if (error instanceof GitError && error.killed) throw error;
    const oid = (await runGit(["rev-parse", "--verify", "HEAD^{commit}"], repo.sourceRoot)).stdout.trim();
    return { oid, warning: "Fresh base origin/HEAD is unavailable locally; using current HEAD. No network fetch was attempted." };
  }
}

export async function validateRecord(repo: RepositoryContext, record: WorktreeRecord): Promise<WorktreeRecord> {
  validateSlug(record.name);
  const expectedPath = join(repo.primaryRoot, ".pi", "worktrees", record.name);
  if (record.primaryRoot !== repo.primaryRoot || record.path !== expectedPath || record.branch !== `worktree-${record.name}`) {
    throw new Error(`Metadata for ${record.name} does not match this repository's managed layout`);
  }
  const canonicalPath = await canonicalExisting(record.path);
  const canonicalRoot = await canonicalExisting(join(repo.primaryRoot, ".pi", "worktrees"));
  if (canonicalPath !== record.path || !isContained(canonicalRoot, canonicalPath)) {
    throw new Error(`Metadata path for ${record.name} escapes the canonical managed root`);
  }
  const entry = repo.worktrees.find((item) => {
    try { return resolve(item.path) === canonicalPath; } catch { return false; }
  });
  if (!entry || entry.branch !== `refs/heads/${record.branch}`) {
    throw new Error(`Git does not list ${record.name} at its recorded path and branch`);
  }
  return record;
}

async function trackedStatusClean(cwd: string): Promise<boolean> {
  return (await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd)).stdout.length === 0;
}

/** Destructive cleanup must also preserve ignored, untracked files. */
async function cleanStatus(cwd: string): Promise<boolean> {
  if (!(await trackedStatusClean(cwd))) return false;
  return (await runGit(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], cwd)).stdout.length === 0;
}

export interface PrepareOptions {
  trustProject: boolean;
  home?: string;
  /** Create a lease atomically with preparation (launcher shell PID or transition process PID). */
  leasePid?: number;
}

export async function prepareWorktree(cwd: string, name: string, options: PrepareOptions = { trustProject: false }): Promise<PreparedWorktree> {
  const initialRepo = await resolveRepository(cwd);
  await validateName(name, initialRepo.sourceRoot);
  const managedRoot = await assertManagedPathsSafe(initialRepo);
  await ensureManagedExclude(initialRepo);

  return withWorktreeLock(initialRepo.commonDir, name, async () => {
    // Refresh porcelain after taking the name lock so decisions cannot use a concurrent snapshot.
    const repo = await resolveRepository(cwd);
    await assertNoCaseCollision(managedRoot, name);
    const target = join(managedRoot, name);
    const branch = `worktree-${name}`;
    const existingRecord = await readRecord(repo.commonDir, name);
    if (existingRecord) {
      const record = await validateRecord(repo, existingRecord);
      if (options.leasePid !== undefined) await createLeaseUnlocked(repo.commonDir, name, options.leasePid);
      return { repo, record, created: false };
    }
    try {
      await stat(target);
      throw new Error(`Target exists without extension metadata: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const planned = await canonicalPlanned(target);
    if (planned !== target || !isContained(managedRoot, planned)) throw new Error("Managed worktree target failed canonical containment validation");
    const localBranches = (await runGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"], repo.sourceRoot)).stdout.split("\n").filter(Boolean);
    const collidingBranch = localBranches.find((candidate) => candidate.toLowerCase() === branch.toLowerCase());
    if (collidingBranch) throw new Error(`Branch ${collidingBranch} collides with ${branch} without a validated managed worktree`);
    if (!(await trackedStatusClean(repo.sourceRoot))) {
      throw new Error(`Source checkout has tracked or untracked changes: ${repo.sourceRoot}`);
    }

    const config = await loadConfig(repo.primaryRoot, options.trustProject, options.home ?? homedir());
    const base = await resolveBase(config.base, repo);
    let worktreeAdded = false;
    try {
      await runGit(["worktree", "add", "-b", branch, "--", target, base.oid], repo.sourceRoot, 60_000);
      worktreeAdded = true;
      const record: WorktreeRecord = {
        version: 1,
        name,
        primaryRoot: repo.primaryRoot,
        path: target,
        branch,
        baseOid: base.oid,
        createdAt: new Date().toISOString(),
      };
      await writeRecordAtomic(repo.commonDir, record);
      if (options.leasePid !== undefined) await createLeaseUnlocked(repo.commonDir, name, options.leasePid);
      return { repo: await resolveRepository(target), record, created: true, ...(base.warning ? { warning: base.warning } : {}) };
    } catch (originalError) {
      if (!worktreeAdded) throw originalError;
      let removalError: unknown;
      try {
        if (!(await cleanStatus(target))) throw new Error("checkout contains changes or ignored files");
        await runGit(["worktree", "remove", target], repo.primaryRoot, 60_000);
      } catch (error) {
        removalError = error;
      }
      if (removalError) {
        throw new Error(
          `${originalError instanceof Error ? originalError.message : String(originalError)} Cleanup could not safely remove the new checkout (${removalError instanceof Error ? removalError.message : String(removalError)}). ` +
          `Preserved checkout ${target} and branch ${branch}; inspect and recover them manually.`,
          { cause: originalError },
        );
      }
      // The branch is deleted only after Git confirmed that checkout removal succeeded.
      try {
        await runGit(["update-ref", "-d", `refs/heads/${branch}`, base.oid], repo.primaryRoot);
      } catch (branchError) {
        throw new Error(
          `${originalError instanceof Error ? originalError.message : String(originalError)} The checkout was removed, but cleanup retained branch ${branch}: ${branchError instanceof Error ? branchError.message : String(branchError)}. Metadata may remain at ${recordPath(repo.commonDir, name)}.`,
          { cause: originalError },
        );
      }
      try {
        await removeRecord(repo.commonDir, name);
      } catch (recordError) {
        if ((recordError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(
            `${originalError instanceof Error ? originalError.message : String(originalError)} The checkout and branch were removed, but metadata cleanup failed at ${recordPath(repo.commonDir, name)}: ${recordError instanceof Error ? recordError.message : String(recordError)}`,
            { cause: originalError },
          );
        }
      }
      throw originalError;
    }
  });
}

export async function getManagedStatus(record: WorktreeRecord): Promise<ManagedStatus> {
  return {
    record,
    clean: await cleanStatus(record.path),
    head: (await runGit(["rev-parse", "--verify", "HEAD^{commit}"], record.path)).stdout.trim(),
  };
}

export async function findCurrentManaged(repo: RepositoryContext): Promise<WorktreeRecord | undefined> {
  const source = repo.sourceRoot;
  for (const item of await listRecords(repo.commonDir)) {
    if (!item.record) continue;
    if (item.record.path === source) return validateRecord(repo, item.record);
  }
  return undefined;
}

export async function listManaged(repo: RepositoryContext): Promise<{ valid: ManagedStatus[]; invalid: string[] }> {
  const valid: ManagedStatus[] = [];
  const invalid: string[] = [];
  for (const item of await listRecords(repo.commonDir)) {
    if (!item.record) { invalid.push(`${item.file}: ${item.error ?? "invalid metadata"}`); continue; }
    try { valid.push(await getManagedStatus(await validateRecord(repo, item.record))); }
    catch (error) { invalid.push(`${item.file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { valid, invalid };
}

export async function removeManaged(repo: RepositoryContext, name: string, activeCwd: string): Promise<WorktreeRecord> {
  await validateName(name, repo.sourceRoot);
  return withWorktreeLock(repo.commonDir, name, async () => {
    const currentRepo = await resolveRepository(activeCwd);
    const record = await readRecord(currentRepo.commonDir, name);
    if (!record) throw new Error(`No extension-managed worktree named ${name}`);
    await validateRecord(currentRepo, record);
    const active = await canonicalExisting(activeCwd);
    if (active === record.path || isContained(record.path, active)) throw new Error("Cannot remove the active worktree");
    const leases = await listLiveLeasesUnlocked(currentRepo.commonDir, name);
    if (leases.length > 0) {
      const owners = leases.map((lease) => lease.pid === undefined ? `${lease.path} (${lease.detail ?? "ambiguous owner"})` : `PID ${lease.pid}`).join(", ");
      throw new Error(`Worktree ${name} is leased by a live or ambiguous Pi process: ${owners}`);
    }
    if (!(await cleanStatus(record.path))) throw new Error(`Worktree ${name} has changes or ignored files; refusing removal`);
    await runGit(["worktree", "remove", record.path], currentRepo.primaryRoot, 60_000);
    await removeRecord(currentRepo.commonDir, name);
    return record;
  });
}

/** Roll back a just-created checkout only if it is still clean, unleased, and at its original commit. */
export interface RollbackResult {
  removed: boolean;
  checkoutRemoved?: boolean;
  reason?: string;
}

export async function rollbackCreated(prepared: PreparedWorktree): Promise<RollbackResult> {
  if (!prepared.created) return { removed: false, reason: "worktree was reused" };
  try {
    return await withWorktreeLock(prepared.repo.commonDir, prepared.record.name, async () => {
      const leases = await listLiveLeasesUnlocked(prepared.repo.commonDir, prepared.record.name);
      if (leases.length > 0) return { removed: false, reason: `worktree has a live or ambiguous process lease (${leases.map((lease) => lease.pid ?? lease.path).join(", ")})` };
      const status = await getManagedStatus(prepared.record);
      if (!status.clean || status.head !== prepared.record.baseOid) return { removed: false, reason: "worktree changed after creation (ignored files count as changes)" };
      await runGit(["worktree", "remove", prepared.record.path], prepared.repo.primaryRoot, 60_000);
      // Never delete the branch unless checkout removal completed successfully.
      try {
        await runGit(["update-ref", "-d", `refs/heads/${prepared.record.branch}`, prepared.record.baseOid], prepared.repo.primaryRoot);
        await removeRecord(prepared.repo.commonDir, prepared.record.name);
        return { removed: true, checkoutRemoved: true };
      } catch (error) {
        return {
          removed: false,
          checkoutRemoved: true,
          reason: `checkout removal succeeded but branch/metadata cleanup did not: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  } catch (error) {
    return { removed: false, checkoutRemoved: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
