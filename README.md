# Pi Worktree Extension

Managed Git worktrees for Pi 0.83.0, with cwd-safe session transitions and a startup launcher for `pi -w <name>` / `pi --worktree <name>`.

A managed worktree named `task` has:

- checkout: `<primary-checkout>/.pi/worktrees/task`
- branch: `worktree-task`
- metadata: `<git-common-dir>/pi-worktree/records/task.json`

The extension registers commands only; it does not expose LLM-callable tools.

## Requirements

- Pi 0.83.0 from `@earendil-works/pi-coding-agent`
- Node.js 22.19 or newer for Pi 0.83.0
- Git with worktree support
- a non-bare repository with at least one commit

## Build and install

Review the package first: Pi extensions execute with the user's permissions. Then:

```bash
cd /absolute/path/to/pi-worktree-extension
npm ci
npm run typecheck
npm test
pi install /absolute/path/to/pi-worktree-extension
```

`npm test` builds `dist/`, which the launcher needs. Pi loads `src/extension.ts` through its jiti TypeScript loader. Shared worktree logic lives in `src/`; the launcher uses the compiled copy in `dist/src/`, so both entry points follow the same validation and creation path.

For a one-off extension test without package installation:

```bash
pi --extension /absolute/path/to/pi-worktree-extension/src/extension.ts
```

## Shell dispatcher

Pi extension flags are processed after startup cwd is established. Therefore `-w` must be handled before Pi starts. Record the real Pi executable path **before** defining a shell function, then add a dispatcher like this to your shell configuration:

```bash
export PI_WORKTREE_REAL_PI="/absolute/path/to/the/real/pi"
export PI_WORKTREE_LAUNCHER="/absolute/path/to/pi-worktree-extension/bin/pi-worktree"

pi() {
  case "${1-}" in
    -w|--worktree)
      if (($# < 2)); then
        echo "usage: pi -w <name> [Pi args...]" >&2
        return 2
      fi
      shift
      command "$PI_WORKTREE_LAUNCHER" "$@"
      ;;
    *)
      command "$PI_WORKTREE_REAL_PI" "$@"
      ;;
  esac
}
```

For example, obtain the path before adding the function with `command -v pi`, then place the resulting absolute path in `PI_WORKTREE_REAL_PI`. Do not point it at the launcher or dispatcher; the launcher rejects direct recursion.

The dispatcher recognizes `-w` / `--worktree` only as Pi's first argument. The launcher treats its first argument as the worktree name and forwards every remaining argument unchanged. It resolves `PI_WORKTREE_REAL_PI` (including a relative path or executable symlink) to an absolute executable before changing cwd, safely prepares or validates the worktree, changes to its canonical path, and executes the real Pi as:

```text
REAL_PI --continue [remaining Pi arguments]
```

This resumes the newest session belonging to that worktree, or creates one if none exists. Because the launcher always supplies `--continue`, do not pass a competing startup session selector such as another continue/resume flag in the remaining arguments.

## Usage

Inside Pi:

```text
/worktree task             create or enter task
/worktree-list             list validated managed worktrees and clean/dirty status
/worktree-exit             clone this session back to the primary checkout
/worktree-remove task      remove an inactive, clean checkout; retain its branch
```

At shell startup:

```bash
pi -w task
pi --worktree task --model provider/model
```

Names must match `[a-z0-9][a-z0-9-]{0,47}` and must also produce a branch accepted by `git check-ref-format --branch`. Names are always passed to Git as argument-array values, not shell commands.

## Base configuration

The default mode is `fresh`. Configuration is a JSON object:

```json
{
  "base": "fresh"
}
```

Supported values:

- `fresh`: use the local symbolic `origin/HEAD` commit. If it is unavailable, use the current `HEAD` and display a warning. Version 1 never fetches.
- `head`: use the source checkout's current `HEAD`.

Configuration is layered in this order:

1. `~/.pi/agent/worktree.json`
2. `<primary-checkout>/.pi/worktree.json`, only when the project is trusted

For in-session commands, Pi's current project-trust decision controls project config. Before startup, the launcher can use only a persisted decision from `~/.pi/agent/trust.json`; a session-only trust decision is intentionally not treated as persisted startup trust. Unknown keys and invalid base values are rejected.

## Session transitions

`/worktree` and `/worktree-exit` require an existing persisted session file and wait for Pi to become idle. The extension uses `SessionManager.forkFrom(sourceSessionFile, targetCwd)`, then explicitly resets the clone to the source session's exact active `/tree` leaf before appending transition metadata. This preserves a selected branch even when its leaf is not the physically last JSONL entry.

`ctx.switchSession(..., { withSession })` rebuilds cwd-bound runtime resources and tools. The replacement session receives a visible context message with old/new cwd and an instruction to revalidate filesystem and repository assumptions. The old context is not used after a successful switch.

If Pi cancels a switch into a newly created worktree, the extension reports target-session cleanup independently and rolls back the checkout, branch, and metadata only when the checkout is still clean at its original base commit. Ignored files count as changes. It claims full rollback only when both target-session cleanup and Git rollback succeeded; otherwise it prints the exact session path/error and checkout recovery information.

## Safety model

Creation rejects:

- traversal, invalid slugs, case-insensitive name/path collisions, and invalid Git branch names
- bare repositories and unborn `HEAD`
- symlinked `.pi` or managed worktree roots
- any tracked path below `.pi/worktrees`
- an existing target or branch without matching extension-owned metadata
- non-canonical paths or paths outside the canonical managed root
- a source checkout with tracked or non-ignored untracked changes (new creation only)

Ignored source files such as dependencies and local environment files do not block creation; they are not copied in version 1. Existing worktrees may be entered only when their atomic metadata record agrees with the canonical primary root, canonical checkout path, branch, and `git worktree list --porcelain -z`. Reuse is allowed when the managed checkout itself is dirty so work is never stranded. Destructive target cleanliness combines porcelain status with ignored-file discovery, so ignored files inside a managed checkout prevent removal or rollback.

The extension idempotently adds `/.pi/worktrees/` to the shared Git `info/exclude`; it never changes the repository's committed `.gitignore`. Git is invoked without a shell, always with an explicit cwd and timeout. Killed, timed-out, and nonzero Git processes are errors.

Removal is conservative and explicit. `/worktree-remove` accepts only an inactive, clean, extension-managed checkout with no live process lease and uses ordinary `git worktree remove`; its branch is retained. Pi shutdown never prompts and never removes a checkout. All worktrees are preserved on quit until `/worktree-remove <name>` is run intentionally. No force-removal mode is used.

Each managed checkout has per-process lease records under `<git-common-dir>/pi-worktree/leases/<name>/`. Multiple Pi processes may lease the same checkout. The launcher installs a lease owned by its shell PID before `exec` (which preserves that PID), closing the prepare-to-session-start race; `session_start` adopts or creates the runtime lease, and transitions lease their target before switching. Leases remain continuously held across Pi runtime replacement. After any native or extension-managed cwd replacement, `session_start` establishes the destination lease before releasing a different source lease; process-exit leases are removed later by dead-PID pruning. Prepare, lease, and remove decisions are serialized by atomic per-name locks under `<git-common-dir>/pi-worktree/locks/`.

## Limitations

- No network fetch, remote branch management, pruning, worktree rename, or automatic branch deletion.
- “Inactive” means not the checkout hosting the current Pi process. A live or ambiguous lease refuses removal; Git may also independently refuse when another process or worktree lock uses it.
- Startup project config requires persisted Pi trust; session-only trust cannot be known before Pi starts.
- A hard crash can leave a lease. Dead-PID lease files are pruned during a later locked lease/removal decision. PID reuse is deliberately conservative: a reused live PID can false-block removal, but it is never treated as proof that removal is safe. Inspect ambiguous records rather than deleting them while Pi may be live.
- A hard crash can also leave an operation lock or the short-lived `info/exclude` lock. Stale locks are never broken automatically; inspect `<git-common-dir>/pi-worktree/locks/` and `<git-common-dir>/info/exclude.pi-worktree.lock`, and remove a lock only after confirming no launcher or command is running.
- Metadata is extension-owned. Manually moving a checkout, branch, record, or lease makes validation fail or removal conservatively block rather than silently adopting unsafe state.

## Recovery and manual inspection

```bash
git worktree list --porcelain
find "$(git rev-parse --git-common-dir)/pi-worktree/records" -type f -maxdepth 1 -print
```

A preserved branch remains `worktree-<name>`. Resolve changes normally, then use `/worktree-remove <name>` from another checkout after all Pi processes using it have exited. Do not manually delete a checkout directory; use Git worktree operations so shared administration remains consistent. If a crashed process left a lease whose PID is now live for an unrelated process, removal may remain conservatively blocked until that PID exits; inspect the lease before any manual cleanup.

## Uninstall

1. Run `/worktree-list` and retain or remove each managed checkout intentionally.
2. Remove the Pi package:

   ```bash
   pi remove /absolute/path/to/pi-worktree-extension
   ```

3. Remove the dispatcher function and `PI_WORKTREE_REAL_PI` / `PI_WORKTREE_LAUNCHER` variables from shell configuration.
4. If no managed records remain, optionally delete `<git-common-dir>/pi-worktree` and remove the single `/.pi/worktrees/` line from `<git-common-dir>/info/exclude`.
5. Delete this package checkout if desired.

Uninstall never deletes retained `worktree-<name>` branches automatically.
