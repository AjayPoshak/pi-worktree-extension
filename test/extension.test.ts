import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import piWorktreeExtension from "../src/extension.js";
import { runGit } from "../src/git.js";
import { listLiveLeases } from "../src/leases.js";
import { prepareWorktree, resolveRepository } from "../src/worktrees.js";

interface RegisteredCommand {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

type EventHandler = (event: unknown, ctx: ExtensionCommandContext) => Promise<void>;

function registerExtension(): { commands: Map<string, RegisteredCommand>; events: Map<string, EventHandler> } {
  const commands = new Map<string, RegisteredCommand>();
  const events = new Map<string, EventHandler>();
  const api = {
    registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
    on(name: string, handler: EventHandler) { events.set(name, handler); },
  };
  piWorktreeExtension(api as unknown as ExtensionAPI);
  return { commands, events };
}

async function makeRepository(): Promise<{ root: string; repo: string; home: string; sessions: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-worktree-extension-")));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const sessions = join(root, "sessions");
  await mkdir(repo);
  await mkdir(home);
  await mkdir(sessions);
  await runGit(["init", "-b", "main"], repo);
  await runGit(["config", "user.name", "Test User"], repo);
  await runGit(["config", "user.email", "test@example.invalid"], repo);
  await writeFile(join(repo, "README.md"), "fixture\n");
  await runGit(["add", "README.md"], repo);
  await runGit(["commit", "-m", "initial"], repo);
  return { root, repo, home, sessions };
}

function makeContext(
  cwd: string,
  manager: SessionManager,
  notifications: Array<{ message: string; level: string }>,
  switchSession: ExtensionCommandContext["switchSession"],
  confirms: string[],
): ExtensionCommandContext {
  const ui = {
    notify(message: string, level: string) { notifications.push({ message, level }); },
    setStatus() {},
    confirm(title: string) { confirms.push(title); return Promise.resolve(false); },
  };
  return {
    cwd,
    sessionManager: manager,
    ui,
    hasUI: true,
    mode: "tui",
    waitForIdle: async () => {},
    switchSession,
    isProjectTrusted: () => false,
  } as unknown as ExtensionCommandContext;
}

function replacementContext(cwd: string, manager: SessionManager, messages: unknown[]): ExtensionCommandContext & { sendMessage: (message: unknown) => Promise<void> } {
  return {
    cwd,
    sessionManager: manager,
    ui: { setStatus() {}, notify() {} },
    sendMessage: async (message: unknown) => { messages.push(message); },
  } as unknown as ExtensionCommandContext & { sendMessage: (message: unknown) => Promise<void> };
}

test("registers commands and switches from the exact non-final active leaf using only replacement context", { concurrency: false }, async () => {
  const fixture = await makeRepository();
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = fixture.sessions;
  try {
    const { commands, events } = registerExtension();
    assert.deepEqual([...commands.keys()].sort(), ["worktree", "worktree-exit", "worktree-list", "worktree-remove", "worktree-switch"]);
    assert.ok(events.has("session_start"));
    assert.ok(events.has("session_shutdown"));

    const source = SessionManager.create(fixture.repo, fixture.sessions);
    source.appendMessage({ role: "assistant", content: [] } as never); // Assistant persistence flushes the real JSONL fixture.
    const selectedLeaf = source.appendCustomEntry("selected", { value: 1 });
    source.appendCustomEntry("physically-last", { value: 2 });
    source.branch(selectedLeaf); // Active leaf is deliberately not the last JSONL entry.
    const notifications: Array<{ message: string; level: string }> = [];
    const confirms: string[] = [];
    const replacementMessages: unknown[] = [];
    let switchedFile = "";
    const switchSession: ExtensionCommandContext["switchSession"] = async (targetFile, options) => {
      switchedFile = targetFile;
      const target = SessionManager.open(targetFile);
      await options?.withSession?.(replacementContext(target.getCwd(), target, replacementMessages) as never);
      return { cancelled: false };
    };
    const ctx = makeContext(fixture.repo, source, notifications, switchSession, confirms);
    await commands.get("worktree")?.handler("exact-leaf", ctx);

    assert.ok(switchedFile, JSON.stringify(notifications));
    const target = SessionManager.open(switchedFile);
    const transition = target.getEntries().at(-1);
    assert.equal(transition?.type, "custom");
    assert.equal(transition?.parentId, selectedLeaf);
    assert.equal(target.getCwd(), join(fixture.repo, ".pi", "worktrees", "exact-leaf"));
    // The clone stays in the custom session directory so `pi -w` (pi --continue) resumes it.
    assert.equal(join(switchedFile, ".."), fixture.sessions);
    assert.equal(SessionManager.continueRecent(target.getCwd(), fixture.sessions).getSessionFile(), switchedFile);
    assert.equal(replacementMessages.length, 1);
    assert.match(JSON.stringify(replacementMessages[0]), /Revalidate all filesystem paths/);
    assert.equal(confirms.length, 0);

    // session_start adopts the transition lease. Shutdown keeps it continuously held
    // so replacement cannot expose a lease-free removal window.
    const shutdownCtx = makeContext(target.getCwd(), target, notifications, switchSession, confirms);
    await events.get("session_start")?.({ type: "session_start", reason: "resume" }, shutdownCtx);
    const targetRepo = await resolveRepository(target.getCwd());
    assert.deepEqual((await listLiveLeases(targetRepo.commonDir, "exact-leaf")).map((lease) => lease.pid), [process.pid]);
    await events.get("session_shutdown")?.({ type: "session_shutdown", reason: "resume" }, shutdownCtx);
    assert.equal(confirms.length, 0);
    assert.equal((await stat(target.getCwd())).isDirectory(), true);
    assert.deepEqual((await listLiveLeases(targetRepo.commonDir, "exact-leaf")).map((lease) => lease.pid), [process.pid]);

    // Native cross-cwd replacement establishes the destination first, then releases
    // the prior managed lease after the new session_start is live.
    const primaryManager = SessionManager.create(fixture.repo, fixture.sessions);
    const primaryCtx = makeContext(fixture.repo, primaryManager, notifications, switchSession, confirms);
    await events.get("session_start")?.({ type: "session_start", reason: "resume" }, primaryCtx);
    assert.deepEqual(await listLiveLeases(targetRepo.commonDir, "exact-leaf"), []);

    // Re-enter the managed runtime, then verify extension-managed exit also releases
    // the source lease only after replacement is live.
    await events.get("session_start")?.({ type: "session_start", reason: "resume" }, shutdownCtx);
    assert.deepEqual((await listLiveLeases(targetRepo.commonDir, "exact-leaf")).map((lease) => lease.pid), [process.pid]);
    let exitCwd = "";
    const exitSwitch: ExtensionCommandContext["switchSession"] = async (path, options) => {
      const replacementManager = SessionManager.open(path);
      exitCwd = replacementManager.getCwd();
      const replacement = makeContext(exitCwd, replacementManager, notifications, switchSession, confirms);
      await events.get("session_start")?.({ type: "session_start", reason: "resume" }, replacement);
      await options?.withSession?.(replacementContext(exitCwd, replacementManager, replacementMessages) as never);
      return { cancelled: false };
    };
    const exitCtx = makeContext(target.getCwd(), target, notifications, exitSwitch, confirms);
    await commands.get("worktree-exit")?.handler("", exitCtx);
    assert.equal(exitCwd, fixture.repo);
    assert.deepEqual(await listLiveLeases(targetRepo.commonDir, "exact-leaf"), []);
  } finally {
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("worktree-switch enters only an existing managed worktree", { concurrency: false }, async () => {
  const fixture = await makeRepository();
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = fixture.sessions;
  try {
    const target = await prepareWorktree(fixture.repo, "existing", { trustProject: false, home: fixture.home });
    const { commands } = registerExtension();
    const source = SessionManager.create(fixture.repo, fixture.sessions);
    source.appendMessage({ role: "assistant", content: [] } as never);
    const notifications: Array<{ message: string; level: string }> = [];
    const replacementMessages: unknown[] = [];
    let switchedFile = "";
    const switchSession: ExtensionCommandContext["switchSession"] = async (path, options) => {
      switchedFile = path;
      const replacement = SessionManager.open(path);
      await options?.withSession?.(replacementContext(replacement.getCwd(), replacement, replacementMessages) as never);
      return { cancelled: false };
    };
    const ctx = makeContext(fixture.repo, source, notifications, switchSession, []);

    await commands.get("worktree-switch")?.handler("existing", ctx);
    assert.equal(SessionManager.open(switchedFile).getCwd(), target.record.path);
    assert.equal(replacementMessages.length, 1);
    assert.deepEqual(notifications, []);

    // Corrupted metadata: foo.json holds the valid record for "existing". Never enter it as foo.
    const records = join(fixture.repo, ".git", "pi-worktree", "records");
    await writeFile(join(records, "foo.json"), await readFile(join(records, "existing.json"), "utf8"));
    switchedFile = "";
    await commands.get("worktree-switch")?.handler("foo", ctx);
    assert.equal(switchedFile, "");
    const mismatch = (notifications as Array<{ message: string; level: string }>).at(-1);
    assert.equal(mismatch?.level, "error");
    assert.match(mismatch?.message ?? "", /record name "existing" does not match "foo"/);
    assert.deepEqual(await listLiveLeases((await resolveRepository(fixture.repo)).commonDir, "foo"), []);
    await unlink(join(records, "foo.json"));

    await commands.get("worktree-switch")?.handler("missing", ctx);
    assert.deepEqual(notifications.at(-1), { message: "No extension-managed worktree named missing", level: "error" });
    assert.equal((await runGit(["worktree", "list", "--porcelain", "-z"], fixture.repo)).stdout.includes("/missing"), false);
  } finally {
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("worktree list hides invalid metadata records", { concurrency: false }, async () => {
  const fixture = await makeRepository();
  try {
    const records = join(fixture.repo, ".git", "pi-worktree", "records");
    await mkdir(records, { recursive: true });
    await writeFile(join(records, "stale.json"), `${JSON.stringify({
      version: 1,
      name: "stale",
      primaryRoot: fixture.repo,
      path: join(fixture.repo, ".pi", "worktrees", "stale"),
      branch: "worktree-stale",
      baseOid: (await runGit(["rev-parse", "HEAD"], fixture.repo)).stdout.trim(),
      createdAt: new Date().toISOString(),
    })}\n`);

    await prepareWorktree(fixture.repo, "listed", { trustProject: false, home: fixture.home });

    const { commands } = registerExtension();
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = makeContext(
      fixture.repo,
      SessionManager.create(fixture.repo, fixture.sessions),
      notifications,
      async () => ({ cancelled: false }),
      [],
    );
    await commands.get("worktree-list")?.handler("", ctx);

    assert.deepEqual(notifications, [{ message: "worktree: listed, branch: worktree-listed", level: "info" }]);

    await commands.get("worktree-remove")?.handler("listed", ctx);
    assert.deepEqual(notifications.at(-1), { message: "Removed worktree: listed, branch: worktree-listed. Branch was retained.", level: "info" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancelled switch reports the exact target session deletion failure and Git rollback separately", { concurrency: false }, async () => {
  const fixture = await makeRepository();
  const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = fixture.sessions;
  try {
    const { commands } = registerExtension();
    const source = SessionManager.create(fixture.repo, fixture.sessions);
    source.appendMessage({ role: "assistant", content: [] } as never);
    source.appendCustomEntry("source", {});
    const notifications: Array<{ message: string; level: string }> = [];
    const confirms: string[] = [];
    let targetFile = "";
    const switchSession: ExtensionCommandContext["switchSession"] = async (path) => {
      targetFile = path;
      await unlink(path);
      await mkdir(path);
      await writeFile(join(path, "blocks-removal"), "x");
      return { cancelled: true };
    };
    const ctx = makeContext(fixture.repo, source, notifications, switchSession, confirms);
    await commands.get("worktree")?.handler("cancelled", ctx);

    assert.ok(targetFile, JSON.stringify(notifications));
    const notice = notifications.at(-1);
    assert.equal(notice?.level, "warning");
    assert.match(notice?.message ?? "", new RegExp(`Target session cleanup failed for ${targetFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(notice?.message ?? "", /Full rollback completed/);
    assert.match(notice?.message ?? "", /checkout, branch, and metadata were rolled back/);
    await assert.rejects(stat(join(fixture.repo, ".pi", "worktrees", "cancelled")), /ENOENT/);
    await assert.rejects(runGit(["show-ref", "--verify", "refs/heads/worktree-cancelled"], fixture.repo));
    assert.equal(await readFile(join(targetFile, "blocks-removal"), "utf8"), "x");

    let cleanTargetFile = "";
    const cleanCancellation: ExtensionCommandContext["switchSession"] = async (path) => {
      cleanTargetFile = path;
      return { cancelled: true };
    };
    const cleanCtx = makeContext(fixture.repo, source, notifications, cleanCancellation, confirms);
    await commands.get("worktree")?.handler("cancelled-clean", cleanCtx);
    assert.match(notifications.at(-1)?.message ?? "", /Full rollback completed/);
    await assert.rejects(stat(cleanTargetFile), /ENOENT/);
    await assert.rejects(stat(join(fixture.repo, ".pi", "worktrees", "cancelled-clean")), /ENOENT/);
  } finally {
    if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("worktree works from a brand-new session before Pi writes its file", { concurrency: false }, async () => {
  const fixture = await makeRepository();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(fixture.home, "agent");
  try {
    const { commands } = registerExtension();
    const switchTo = (switched: string[]): ExtensionCommandContext["switchSession"] => async (path, options) => {
      switched.push(path);
      const replacement = SessionManager.open(path);
      await options?.withSession?.(replacementContext(replacement.getCwd(), replacement, []) as never);
      return { cancelled: false };
    };

    // Custom session directory: only a user message exists, so nothing is on disk yet.
    const custom = SessionManager.create(fixture.repo, fixture.sessions);
    const userEntry = custom.appendMessage({ role: "user", content: "hello", timestamp: 0 } as never);
    await assert.rejects(stat(custom.getSessionFile()!), /ENOENT/);
    const notifications: Array<{ message: string; level: string }> = [];
    const customSwitched: string[] = [];
    await commands.get("worktree")?.handler("fresh", makeContext(fixture.repo, custom, notifications, switchTo(customSwitched), []));
    assert.deepEqual(notifications.filter((n) => n.level === "error"), []);
    const [customFile] = customSwitched;
    assert.ok(customFile);
    assert.equal(join(customFile, ".."), fixture.sessions);
    const customTarget = SessionManager.continueRecent(join(fixture.repo, ".pi", "worktrees", "fresh"), fixture.sessions);
    assert.equal(customTarget.getSessionFile(), customFile);
    assert.equal(customTarget.getEntry(userEntry)?.type, "message");
    assert.equal(customTarget.getEntries().at(-1)?.parentId, userEntry);

    // Default per-cwd session directory: an empty brand-new session.
    const fresh = SessionManager.create(fixture.repo);
    const defaultSwitched: string[] = [];
    await commands.get("worktree")?.handler("fresh-default", makeContext(fixture.repo, fresh, notifications, switchTo(defaultSwitched), []));
    assert.deepEqual(notifications.filter((n) => n.level === "error"), []);
    const defaultCwd = join(fixture.repo, ".pi", "worktrees", "fresh-default");
    assert.equal(SessionManager.continueRecent(defaultCwd).getSessionFile(), defaultSwitched[0]);
    assert.ok(defaultSwitched[0]?.startsWith(join(fixture.home, "agent", "sessions")));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(fixture.root, { recursive: true, force: true });
  }
});
