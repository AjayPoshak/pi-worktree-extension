import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import piWorktreeExtension from "../src/extension.js";
import { runGit } from "../src/git.js";
import { listLiveLeases } from "../src/leases.js";
import { resolveRepository } from "../src/worktrees.js";

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
    assert.deepEqual([...commands.keys()].sort(), ["worktree", "worktree-exit", "worktree-list", "worktree-remove"]);
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
