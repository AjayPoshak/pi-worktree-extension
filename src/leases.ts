import { lstat, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureRealDirectory } from "./paths.js";

interface LeaseRecord {
  version: 1;
  name: string;
  pid: number;
  createdAt: string;
}

export interface LiveLease {
  pid?: number;
  path: string;
  detail?: string;
}

function ownerRoot(commonDir: string): string {
  return join(commonDir, "pi-worktree");
}

function locksDirectory(commonDir: string): string {
  return join(ownerRoot(commonDir), "locks");
}

function leasesDirectory(commonDir: string, name: string): string {
  return join(ownerRoot(commonDir), "leases", name);
}

function assertName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name)) throw new Error(`Invalid worktree lease name: ${JSON.stringify(name)}`);
}

function assertPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid lease owner PID: ${pid}`);
}

function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence. EPERM and every ambiguous failure must false-block.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Serialize all prepare/remove/lease decisions for one managed name. */
export async function withWorktreeLock<T>(commonDir: string, name: string, action: () => Promise<T>): Promise<T> {
  assertName(name);
  await ensureRealDirectory(ownerRoot(commonDir), "metadata root");
  const directory = locksDirectory(commonDir);
  await ensureRealDirectory(directory, "worktree operation locks directory");
  const lockPath = join(directory, `${name}.lock`);
  const deadline = Date.now() + 5_000;
  let handle;
  while (true) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error(`Could not acquire worktree operation lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

/** Caller must hold the per-name operation lock. */
export async function createLeaseUnlocked(commonDir: string, name: string, pid: number): Promise<void> {
  assertName(name);
  assertPid(pid);
  const leasesRoot = join(ownerRoot(commonDir), "leases");
  await ensureRealDirectory(leasesRoot, "worktree leases directory");
  const directory = leasesDirectory(commonDir, name);
  await ensureRealDirectory(directory, `lease directory for ${name}`);
  const destination = join(directory, `${pid}.json`);
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`Lease path is not a regular file: ${destination}`);
    const parsed = JSON.parse(await readFile(destination, "utf8")) as Partial<LeaseRecord>;
    if (parsed.version !== 1 || parsed.name !== name || parsed.pid !== pid) throw new Error(`Existing lease is malformed: ${destination}`);
    return; // Adopt a launcher-created lease owned by the same exec-preserved PID.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const record: LeaseRecord = { version: 1, name, pid, createdAt: new Date().toISOString() };
  const temporary = join(directory, `.${pid}.${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  try { await rename(temporary, destination); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

export async function createLease(commonDir: string, name: string, pid = process.pid): Promise<void> {
  await withWorktreeLock(commonDir, name, () => createLeaseUnlocked(commonDir, name, pid));
}

/** Caller must hold the per-name operation lock. Dead owners are pruned; ambiguity blocks removal. */
export async function listLiveLeasesUnlocked(commonDir: string, name: string): Promise<LiveLease[]> {
  assertName(name);
  const directory = leasesDirectory(commonDir, name);
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const live: LiveLease[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      live.push({ path: join(directory, file), detail: "unrecognized lease file" });
      continue;
    }
    const path = join(directory, file);
    let pid: number | undefined;
    try {
      const fileStat = await lstat(path);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error("not a regular file");
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LeaseRecord>;
      if (parsed.version !== 1 || parsed.name !== name || typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
        throw new Error("malformed lease record");
      }
      pid = parsed.pid;
    } catch (error) {
      live.push({ path, detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (pid === undefined) throw new Error(`Internal error: validated lease has no PID: ${path}`);
    if (pidIsLive(pid)) live.push({ pid, path });
    else await rm(path); // It was dead while the operation lock was held.
  }
  return live;
}

export async function removeLease(commonDir: string, name: string, pid = process.pid): Promise<void> {
  assertName(name);
  assertPid(pid);
  await withWorktreeLock(commonDir, name, async () => {
    await rm(join(leasesDirectory(commonDir, name), `${pid}.json`), { force: true });
  });
}

export async function listLiveLeases(commonDir: string, name: string): Promise<LiveLease[]> {
  return withWorktreeLock(commonDir, name, () => listLiveLeasesUnlocked(commonDir, name));
}
