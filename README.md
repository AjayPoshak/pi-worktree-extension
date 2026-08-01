# Pi Worktree

**Give every task its own checkout and its own Pi session.**

AI coding sessions are most useful when they can stay focused on one task. But real work is rarely that tidy: a bug interrupts a feature, two changes need to proceed in parallel, or you want to experiment without disturbing the repository you already have open.

A normal branch switch does not isolate files. You have to stash or commit unfinished work, dependencies and generated files remain shared, and two Pi processes can overwrite the same checkout. A second clone provides isolation, but adds setup and disconnects the new directory from the conversation already in progress.

Git worktrees solve the filesystem problem. Pi Worktree connects them to Pi:

```bash
cd my-project
pi -w fix-auth
```

That command creates an isolated checkout, creates the `worktree-fix-auth` branch, starts Pi inside it, and resumes that worktree's previous Pi session the next time you run it.

You can also move an active conversation into a worktree without losing its selected `/tree` branch:

```text
/worktree fix-auth
```

Now the task has its own files, branch, working state, and conversation. Your primary checkout stays available for reviews, urgent fixes, or another Pi session.

## What it gives you

- **One checkout per task** — parallel agents do not edit the same files.
- **One Pi history per worktree** — `pi -w <name>` returns to the task where you left it.
- **Conversation-preserving transitions** — `/worktree` and `/worktree-exit` carry the active session leaf across directories.
- **Safe, explicit cleanup** — worktrees are never deleted when Pi exits, and branches are never force-deleted.
- **Guardrails around Git** — removal is refused for dirty, active, unrecognized, or ambiguously owned worktrees.

Pi Worktree does not ask the model to manage worktrees. It provides explicit shell and slash commands, so you decide when a task moves or is removed.

## Requirements

- Pi 0.83.0 (the currently tested version)
- Node.js 22.19 or newer
- Git with worktree support
- A non-bare Git repository with at least one commit

## Installation

### Install from npm

```bash
pi install npm:pi-worktree-extension
```

This installs the Pi extension and makes these in-session commands available:

```text
/worktree
/worktree-list
/worktree-exit
/worktree-remove
```

Pi packages execute with your user permissions. Review the source before installing if you do not trust the package.

### Enable `pi -w`

The extension can switch worktrees after Pi starts, but Pi chooses its initial working directory before extensions load. The `pi -w` startup form therefore needs a small shell dispatcher.

First, record the real Pi executable **before** defining the dispatcher:

```bash
command -v pi
```

Add the following to `~/.zshrc` or `~/.bashrc`, replacing `PI_WORKTREE_REAL_PI` with that command's absolute output:

```bash
export PI_WORKTREE_REAL_PI="/absolute/path/to/pi"
export PI_WORKTREE_LAUNCHER="$HOME/.pi/agent/npm/node_modules/.bin/pi-worktree"

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

Reload your shell:

```bash
source ~/.zshrc # or ~/.bashrc
```

Confirm that normal Pi commands still work:

```bash
pi --version
```

### Install from source

```bash
git clone https://github.com/AjayPoshak/pi-worktree-extension.git
cd pi-worktree-extension
npm ci
npm run typecheck
npm test
pi install "$PWD"
```

For a source installation, point `PI_WORKTREE_LAUNCHER` at the cloned package:

```bash
export PI_WORKTREE_LAUNCHER="/absolute/path/to/pi-worktree-extension/bin/pi-worktree"
```

## Quick start

Start a task from your shell:

```bash
cd /path/to/a/clean/git-repository
pi -w fix-auth
```

Or move an existing Pi conversation into a task worktree:

```text
/worktree fix-auth
```

List managed worktrees:

```text
/worktree-list
```

Move the conversation back to the primary checkout:

```text
/worktree-exit
```

Remove the checkout when the task is finished:

```text
/worktree-remove fix-auth
```

Removal keeps the `worktree-fix-auth` branch. Delete it separately when it is merged or no longer needed:

```bash
git branch -d worktree-fix-auth
```

## Commands

| Command | Purpose |
| --- | --- |
| `pi -w <name> [Pi args...]` | Create or reopen a task worktree and continue its latest Pi session |
| `pi --worktree <name> [Pi args...]` | Long form of `pi -w` |
| `/worktree <name>` | Move the active conversation into a new or existing worktree |
| `/worktree-list` | Show managed worktrees and their clean/dirty state |
| `/worktree-exit` | Move the active conversation back to the primary checkout |
| `/worktree-remove <name>` | Remove an inactive, clean checkout while retaining its branch |

Names must match `[a-z0-9][a-z0-9-]{0,47}`. For example: `fix-auth`, `issue-123`, or `prototype2`.

## What gets created

For a worktree named `fix-auth`:

```text
checkout   <repository>/.pi/worktrees/fix-auth
branch     worktree-fix-auth
```

The checkout path is added to the repository's private Git exclude file. Pi Worktree does not modify the project's committed `.gitignore`.

By default, a new worktree starts from the local `origin/HEAD`. No network fetch is performed. If `origin/HEAD` is unavailable, it falls back to the current `HEAD` and displays a warning.

To always base new worktrees on the source checkout's current `HEAD`, create `~/.pi/agent/worktree.json`:

```json
{
  "base": "head"
}
```

A trusted project can override this at `<repository>/.pi/worktree.json`.

## Safety behavior

Creating a new worktree requires the source checkout to have no tracked or non-ignored untracked changes. Ignored source files, such as dependencies or local environment files, do not block creation and are not copied into the new checkout.

Existing worktrees may be reopened while dirty—unfinished work should never become inaccessible. Destructive cleanup is stricter: `/worktree-remove` refuses to proceed when the target contains tracked, untracked, **or ignored** files.

Pi Worktree also refuses removal when:

- another live Pi process is using the worktree;
- the checkout or metadata does not match what the extension created;
- the target is outside the managed worktree directory;
- Git itself considers the worktree locked or unsafe to remove.

There is no force-removal mode. Quitting Pi never removes a checkout, and `/worktree-remove` never deletes its branch.

## Current limitations

- No automatic fetch or remote branch management
- No automatic branch deletion
- No worktree rename or prune command
- Ignored files are not copied from the source checkout
- A hard crash can leave a conservative lock or lease that requires inspection after confirming no Pi process is using it

Worktrees are isolated checkouts, not security sandboxes. Pi processes still run with your normal user permissions and share the same Git repository.

## Uninstall

First inspect and intentionally retain or remove your managed worktrees:

```text
/worktree-list
```

Remove the npm package:

```bash
pi remove npm:pi-worktree-extension
```

Then remove the dispatcher function and the `PI_WORKTREE_REAL_PI` / `PI_WORKTREE_LAUNCHER` variables from your shell configuration.

Uninstalling the extension does not delete worktrees or `worktree-*` branches.

## Development

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

The launcher uses the compiled output in `dist/`; `npm test` and the package `prepack` lifecycle build it.

## License

MIT
