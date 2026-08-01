# Pi Worktree

[![npm](https://img.shields.io/npm/v/pi-worktree-extension?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/pi-worktree-extension)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/AjayPoshak/pi-worktree-extension?style=for-the-badge&logo=github)](https://github.com/AjayPoshak/pi-worktree-extension/stargazers)

**Run parallel Pi sessions without sharing a checkout.**

Pi Worktree is a Git worktree extension for [Pi](https://github.com/earendil-works/pi). It gives each task an isolated working directory and branch, then keeps that task connected to its own Pi conversation.

```bash
pi -w fix-auth
```

Run that from a repository and Pi Worktree creates `worktree-fix-auth`, opens it under `.pi/worktrees/fix-auth`, and starts or resumes Pi there.

## Context: why worktrees?

Coding agents can work on several tasks at once. A Git checkout cannot.

Branches change the commit you are viewing, but they still share one working directory. Two Pi sessions in that directory can edit the same files, overwrite generated output, or force you to stash unfinished changes whenever priorities change.

A second clone isolates the files, but also duplicates repository setup and starts with no connection to the Pi conversation already doing the work.

Git worktrees are the right primitive: each task gets its own checkout while all tasks share one repository. The native workflow is just cumbersome. You have to choose a path, create a branch and worktree, move into it, launch Pi, remember which session belongs there, and clean everything up safely later.

## Worktrees that understand Pi sessions

Pi Worktree turns that workflow into one command and preserves context when you move between checkouts.

| Task | Pi Worktree | Manual workflow |
| --- | --- | --- |
| Start an isolated task | `pi -w fix-auth` | `git worktree add -b worktree-fix-auth .pi/worktrees/fix-auth && cd .pi/worktrees/fix-auth && pi` |
| Move the current conversation | `/worktree fix-auth` | Create the worktree, launch another Pi session, and re-establish context |
| Return to the primary checkout | `/worktree-exit` | Leave the session, find the primary checkout, and launch or resume Pi there |
| See every managed task | `/worktree-list` | Combine `git worktree list`, status checks, and manual bookkeeping |
| Remove a finished checkout | `/worktree-remove fix-auth` | Verify it is inactive and clean, then run `git worktree remove` |

The branch is deliberately retained after removal. Pi Worktree never force-removes a checkout or force-deletes a branch.

## Install

**Requirements:** Pi (tested with 0.83.0), Node.js 22.19+, Git worktree support, and a non-bare repository with at least one commit.

Install the package:

```bash
pi install npm:pi-worktree-extension
```

This immediately adds the in-session `/worktree` commands. Try it without any shell setup:

```bash
cd ~/code/my-project
pi
```

Then, inside Pi:

```text
/worktree feature-auth
```

Pi extensions execute with your user permissions; review the source before installing packages you do not trust.

### Optional: set up `pi -w`

The extension works without this step. Add the dispatcher only if you want to create or resume a worktree directly from the shell with `pi -w feature-auth`.

Pi chooses its startup directory before extensions load, so the `-w` flag needs a small shell dispatcher.

First, record the real Pi executable before defining a function with the same name:

```bash
command -v pi
```

Then add this to `~/.zshrc` or `~/.bashrc`, replacing `/absolute/path/to/pi` with that command's output:

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

Reload the shell and verify the dispatcher:

```bash
source ~/.zshrc # or ~/.bashrc
pi --version
```

<details>
<summary><strong>Install from source</strong></summary>

```bash
git clone https://github.com/AjayPoshak/pi-worktree-extension.git
cd pi-worktree-extension
npm ci
npm run typecheck
npm test
pi install "$PWD"
```

For a source installation, point the launcher at the cloned package instead:

```bash
export PI_WORKTREE_LAUNCHER="/absolute/path/to/pi-worktree-extension/bin/pi-worktree"
```

</details>

## Quick start

From an ordinary Pi session in a clean Git checkout, move the current conversation into an isolated task:

```text
/worktree feature-auth
```

If you enabled the optional shell dispatcher, you can start or resume the task directly instead:

```bash
cd ~/code/my-project
pi -w feature-auth
```

You are now working in:

```text
~/code/my-project/.pi/worktrees/feature-auth
└── branch: worktree-feature-auth
```

The next time you run `pi -w feature-auth`, Pi reopens that checkout and continues its latest session.

Start more tasks from separate terminals:

```bash
pi -w fix-pagination
pi -w add-api-tests
```

Each Pi process gets separate files, a separate branch, and separate session history:

```text
my-project/
├── primary checkout                 main
└── .pi/worktrees/
    ├── feature-auth/                worktree-feature-auth
    ├── fix-pagination/              worktree-fix-pagination
    └── add-api-tests/               worktree-add-api-tests
```

List their state from Pi:

```text
/worktree-list
```

When a task is done, leave its checkout and remove it:

```text
/worktree-exit
/worktree-remove feature-auth
```

The branch remains available for review, merge, or manual deletion:

```bash
git branch -d worktree-feature-auth
```

## Move a conversation already in progress

You do not have to decide on a worktree before starting Pi. From an active session:

```text
/worktree feature-auth
```

Pi Worktree clones the current session into the task checkout and preserves the exact active `/tree` leaf. Pi rebuilds its cwd-bound tools and project context for the new directory, so the conversation continues without treating the old checkout as current.

Use `/worktree-exit` to carry the conversation back to the primary checkout.

## Core commands

| Command | Description |
| --- | --- |
| `pi -w <name> [Pi args...]` | Create or reopen a task worktree and continue its latest Pi session |
| `pi --worktree <name> [Pi args...]` | Long form of `pi -w` |
| `/worktree <name>` | Move the active conversation into a new or existing worktree |
| `/worktree-list` | List managed worktrees with their clean or dirty state |
| `/worktree-exit` | Move the active conversation back to the primary checkout |
| `/worktree-remove <name>` | Remove an inactive, clean checkout and retain its branch |

Names must match `[a-z0-9][a-z0-9-]{0,47}`. Examples: `fix-auth`, `issue-123`, `prototype2`.

`pi -w` supplies `--continue` itself. Other Pi arguments are forwarded unchanged, but do not pass another startup resume or continue selector.

## Base for new worktrees

The default mode is `fresh`: new worktrees start from the local `origin/HEAD`. Pi Worktree never fetches from the network. If `origin/HEAD` is unavailable, it uses the current `HEAD` and displays a warning.

To create new worktrees from the source checkout's current `HEAD`, add this to `~/.pi/agent/worktree.json`:

```json
{
  "base": "head"
}
```

A trusted repository can override the setting at `<repository>/.pi/worktree.json`.

## Safety by default

Worktree creation and removal are intentionally conservative:

- Creating a new worktree requires a source checkout with no tracked or non-ignored untracked changes.
- Ignored source files such as `node_modules` or local environment files do not block creation, but they are not copied.
- Dirty existing worktrees can always be reopened, so unfinished work is not stranded.
- Removal is blocked by tracked, untracked, **or ignored** files in the target checkout.
- Removal is blocked while another live Pi process is using the worktree.
- Unknown paths, mismatched metadata, symlinked managed roots, and ambiguous ownership are rejected.
- Quitting Pi never removes a checkout.
- `/worktree-remove` retains the branch.
- There is no force-removal mode.

The managed checkout path is added to Git's private `info/exclude`; the extension does not modify the repository's committed `.gitignore`.

Worktrees isolate working directories, not permissions. Every Pi process still has your normal user access and shares the same underlying Git repository.

## Limitations

- No automatic fetch or remote branch management
- No automatic branch deletion
- No worktree rename or prune command
- No copying of ignored files or dependency directories
- A hard crash can leave a conservative lease or operation lock that may require inspection after confirming no Pi process is using it

## Uninstall

Inspect and intentionally retain or remove managed worktrees first:

```text
/worktree-list
```

Then remove the package:

```bash
pi remove npm:pi-worktree-extension
```

Remove the dispatcher function and the `PI_WORKTREE_REAL_PI` / `PI_WORKTREE_LAUNCHER` variables from your shell configuration. Uninstalling never deletes worktrees or `worktree-*` branches.

## Contributing

Issues and small friction reports are welcome: [open an issue](https://github.com/AjayPoshak/pi-worktree-extension/issues/new).

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

## License

[MIT](LICENSE)
