import { rm, stat } from "node:fs/promises";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createLease, removeLease } from "./leases.js";
import { reportCmuxCwd, reportTerminalCwd } from "./terminal.js";
import {
  findCurrentManaged,
  listManaged,
  prepareWorktree,
  removeManaged,
  resolveRepository,
  rollbackCreated,
  type PreparedWorktree,
} from "./worktrees.js";

const STATUS_KEY = "pi-worktree";
const TRANSITION_TYPE = "pi-worktree-transition";
const ACTIVE_LEASE_STATE = Symbol.for("pi-worktree-extension.active-lease");

interface ActiveLeaseState {
  commonDir: string;
  name: string;
}

function getActiveLeaseState(): ActiveLeaseState | undefined {
  return (globalThis as Record<symbol, unknown>)[ACTIVE_LEASE_STATE] as ActiveLeaseState | undefined;
}

function setActiveLeaseState(state: ActiveLeaseState | undefined): void {
  if (state) (globalThis as Record<symbol, unknown>)[ACTIVE_LEASE_STATE] = state;
  else delete (globalThis as Record<symbol, unknown>)[ACTIVE_LEASE_STATE];
}

interface SourceState {
  file: string;
  leaf: string | null;
  cwd: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Capture the source exactly once after the runtime is idle. */
async function captureSource(ctx: ExtensionCommandContext): Promise<SourceState> {
  await ctx.waitForIdle();
  const file = ctx.sessionManager.getSessionFile();
  if (!file) throw new Error("A persisted session is required; save or start a persistent Pi session first");
  const fileStat = await stat(file).catch(() => undefined);
  if (!fileStat?.isFile()) throw new Error(`The current session file does not exist: ${file}`);
  return { file, leaf: ctx.sessionManager.getLeafId(), cwd: ctx.cwd };
}

async function removeTargetSession(targetFile: string): Promise<string | undefined> {
  try {
    await rm(targetFile);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return errorMessage(error);
  }
}

async function buildSessionTransition(
  ctx: ExtensionCommandContext,
  source: SourceState,
  targetCwd: string,
  kind: "enter" | "exit",
  options: { prepared?: PreparedWorktree; sourceLeaseName?: string; targetLeaseName?: string } = {},
): Promise<() => Promise<void>> {
  const targetManager = SessionManager.forkFrom(source.file, targetCwd);
  if (source.leaf === null) targetManager.resetLeaf();
  else targetManager.branch(source.leaf);
  targetManager.appendCustomEntry(TRANSITION_TYPE, {
    kind,
    from: source.cwd,
    to: targetCwd,
    sourceLeafId: source.leaf,
    transitionedAt: new Date().toISOString(),
  });
  const targetFile = targetManager.getSessionFile();
  if (!targetFile) throw new Error("Pi did not persist the forked target session");

  // Only immutable strings and prepared repository data cross the runtime replacement.
  const oldCwd = source.cwd;
  const newCwd = targetCwd;
  return async () => {
    const result = await ctx.switchSession(targetFile, {
      withSession: async (replacement) => {
        replacement.ui.setStatus(STATUS_KEY, kind === "enter" ? `worktree: ${newCwd.split("/").at(-1) ?? newCwd}` : undefined);
        await replacement.sendMessage(
          {
            customType: TRANSITION_TYPE,
            content: `Pi worktree transition: cwd changed from ${oldCwd} to ${newCwd}. Revalidate all filesystem paths, repository state, and cwd-dependent assumptions before continuing.`,
            display: true,
            details: { kind, from: oldCwd, to: newCwd },
          },
          { triggerTurn: false },
        );
      },
    });

    if (result.cancelled) {
      const sessionError = await removeTargetSession(targetFile);
      let leaseError: string | undefined;
      if (options.targetLeaseName && options.targetLeaseName !== options.sourceLeaseName) {
        try { await removeLease(options.prepared?.repo.commonDir ?? (await resolveRepository(source.cwd)).commonDir, options.targetLeaseName); }
        catch (error) { leaseError = errorMessage(error); }
      }

      let gitRollbackSucceeded = !options.prepared?.created;
      let gitRecovery = "No newly-created Git checkout required rollback.";
      if (options.prepared?.created) {
        const rolledBack = await rollbackCreated(options.prepared);
        gitRollbackSucceeded = rolledBack.removed;
        gitRecovery = rolledBack.removed
          ? "The newly-created checkout, branch, and metadata were rolled back."
          : rolledBack.checkoutRemoved
            ? `Git rollback was partial: the checkout was removed, but branch or metadata cleanup failed (${rolledBack.reason ?? "unknown reason"}). Inspect branch ${options.prepared.record.branch} and metadata for ${options.prepared.record.name}.`
            : `The checkout was preserved because safe rollback could not be proven (${rolledBack.reason ?? "unknown reason"}). Recover it at ${options.prepared.record.path} on branch ${options.prepared.record.branch}.`;
      }

      const sessionRecovery = sessionError
        ? `Target session cleanup failed for ${targetFile}: ${sessionError}.`
        : `Target session clone ${targetFile} was removed.`;
      const leaseRecovery = leaseError ? ` Transition lease cleanup failed: ${leaseError}.` : "";
      const cleanupSucceeded = !sessionError && !leaseError && gitRollbackSucceeded;
      const fullRollback = cleanupSucceeded && Boolean(options.prepared?.created);
      ctx.ui.notify(
        `Session switch was cancelled. ${fullRollback ? "Full rollback completed. " : ""}${sessionRecovery} ${gitRecovery}${leaseRecovery}`,
        cleanupSucceeded ? "info" : "warning",
      );
      return;
    }

    // The target transition lease is now the runtime lease. Release only a different source lease.
    if (options.sourceLeaseName && options.sourceLeaseName !== options.targetLeaseName) {
      const commonDir = options.prepared?.repo.commonDir ?? (await resolveRepository(source.cwd)).commonDir;
      await removeLease(commonDir, options.sourceLeaseName).catch(() => undefined);
    }
    // On success the old ctx/runtime is stale. Intentionally do not use it again.
  };
}

async function runCommand(ctx: ExtensionCommandContext, action: () => Promise<void>): Promise<void> {
  try { await action(); }
  catch (error) { ctx.ui.notify(errorMessage(error), "error"); }
}

export default function piWorktreeExtension(pi: ExtensionAPI): void {
  pi.registerCommand("worktree", {
    description: "Create or enter a managed Git worktree",
    handler: async (args, ctx) => {
      let execute: (() => Promise<void>);
      let prepared: PreparedWorktree | undefined;
      let sourceLeaseName: string | undefined;
      try {
        const name = args.trim();
        if (!name) throw new Error("Usage: /worktree <name>");
        const source = await captureSource(ctx);
        const sourceRepo = await resolveRepository(source.cwd);
        sourceLeaseName = (await findCurrentManaged(sourceRepo))?.name;
        prepared = await prepareWorktree(source.cwd, name, { trustProject: ctx.isProjectTrusted(), leasePid: process.pid });
        if (prepared.warning) ctx.ui.notify(prepared.warning, "warning");
        execute = await buildSessionTransition(ctx, source, prepared.record.path, "enter", {
          prepared,
          ...(sourceLeaseName ? { sourceLeaseName } : {}),
          targetLeaseName: prepared.record.name,
        });
      } catch (error) {
        if (prepared) {
          if (prepared.record.name !== sourceLeaseName) await removeLease(prepared.repo.commonDir, prepared.record.name).catch(() => undefined);
          if (prepared.created) await rollbackCreated(prepared);
        }
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }
      await execute();
    },
  });

  pi.registerCommand("worktree-list", {
    description: "List extension-managed Git worktrees",
    handler: async (_args, ctx) => runCommand(ctx, async () => {
      const listed = await listManaged(await resolveRepository(ctx.cwd));
      const lines = listed.valid.map(({ record, clean, head }) =>
        `${record.name}: ${clean ? "clean" : "dirty"}, HEAD ${head.slice(0, 12)}, branch ${record.branch}, path ${record.path}`,
      );
      lines.push(...listed.invalid.map((message) => `INVALID: ${message}`));
      ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No extension-managed worktrees.", listed.invalid.length > 0 ? "warning" : "info");
    }),
  });

  pi.registerCommand("worktree-exit", {
    description: "Clone this session back to the primary checkout",
    handler: async (_args, ctx) => {
      let execute: (() => Promise<void>);
      try {
        const source = await captureSource(ctx);
        const repo = await resolveRepository(source.cwd);
        const current = await findCurrentManaged(repo);
        if (!current) throw new Error("The current checkout is not an extension-managed worktree");
        execute = await buildSessionTransition(ctx, source, current.primaryRoot, "exit", { sourceLeaseName: current.name });
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }
      await execute();
    },
  });

  pi.registerCommand("worktree-remove", {
    description: "Remove an inactive clean managed worktree (branch is retained)",
    handler: async (args, ctx) => runCommand(ctx, async () => {
      const name = args.trim();
      if (!name) throw new Error("Usage: /worktree-remove <name>");
      const removed = await removeManaged(await resolveRepository(ctx.cwd), name, ctx.cwd);
      ctx.ui.notify(`Removed ${removed.path}. Branch ${removed.branch} was retained.`, "info");
    }),
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const repo = await resolveRepository(ctx.cwd);
      const current = await findCurrentManaged(repo);
      const previous = getActiveLeaseState();
      const next = current ? { commonDir: repo.commonDir, name: current.name } : undefined;

      // Establish the destination lease first, then release a different source lease.
      // This closes the shutdown→replacement-start gap for native /resume, /new,
      // /fork, and /reload flows as well as extension-managed transitions.
      if (next) await createLease(next.commonDir, next.name);
      setActiveLeaseState(next);
      if (previous && (!next || previous.commonDir !== next.commonDir || previous.name !== next.name)) {
        await removeLease(previous.commonDir, previous.name);
      }

      ctx.ui.setStatus(STATUS_KEY, current ? `worktree: ${current.name}` : undefined);
      // Pi keeps its process alive when sessions change cwd. Tell cmux about every
      // replacement session, not only worktrees launched through `pi -w`.
      if (ctx.mode === "tui") {
        reportTerminalCwd(ctx.cwd);
        void reportCmuxCwd(ctx.cwd);
      }
    } catch (error) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.notify(`Worktree lease/status setup failed: ${errorMessage(error)}`, "warning");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Keep the lease continuously held across reload/resume replacement. Removing it
    // here would open a race before the replacement session_start recreates it.
    // Extension-managed enter/exit transitions release a different source lease only
    // after the replacement runtime is live. On process exit, dead-PID pruning safely
    // removes the stale lease during the next locked lease/removal decision.
    try { ctx.ui.setStatus(STATUS_KEY, undefined); }
    catch { /* The TUI may already be stopped in Pi 0.83. */ }
  });
}
