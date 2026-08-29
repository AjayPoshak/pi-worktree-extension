# 🌳 Pi Worktree

[![npm](https://img.shields.io/npm/v/pi-worktree-extension?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/pi-worktree-extension)
[![npm weekly downloads](https://img.shields.io/npm/dw/pi-worktree-extension?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/pi-worktree-extension)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/AjayPoshak/pi-worktree-extension?style=for-the-badge&logo=github)](https://github.com/AjayPoshak/pi-worktree-extension/stargazers)

**Stop making your agents wait in line.**

```bash
pi -w fix-auth
```

One command. A dedicated branch, a dedicated checkout, a dedicated Pi conversation. Fire off `fix-auth`, `fix-pagination`, and `add-api-tests` in parallel from the same repo — no stashing, no collisions, no waiting your turn.

## 🤔 Why worktrees

A single checkout can't hold two tasks at once — two Pi sessions in the same directory step on each other's edits. Git worktrees fix that natively, but the raw workflow (branch, create, `cd`, launch, track, clean up) is tedious. Pi Worktree collapses it into one command:

| Task | Pi Worktree | Manual workflow |
| --- | --- | --- |
| Start an isolated task | `pi -w fix-auth` | `git worktree add -b worktree-fix-auth .pi/worktrees/fix-auth && cd .pi/worktrees/fix-auth && pi` |
| Move the active conversation | `/worktree fix-auth` | Create the worktree, launch a new session, re-establish context by hand |
| Return to the primary checkout | `/worktree-exit` | Find the primary checkout and relaunch or resume Pi there |
| See every managed task | `/worktree-list` | Combine `git worktree list` with manual status checks |
| Remove a finished checkout | `/worktree-remove fix-auth` | Verify it's inactive and clean, then `git worktree remove` |

Branches are always kept, even after removal — Pi Worktree never force-removes a checkout or force-deletes a branch.

## 🚀 Install

**Requirements:** Pi (tested with 0.83.0), Node.js 22.19+, Git worktree support, a non-bare repo with at least one commit.

```bash
pi install npm:pi-worktree-extension
```

That immediately adds the `/worktree` commands to your session:

```bash
cd ~/code/my-project
pi
```

```text
/worktree feature-auth
```

Pi extensions run with your user permissions — review the source before installing packages you don't trust.

### Optional: enable `pi -w` from the shell

`/worktree` works out of the box. For the `pi -w feature-auth` shortcut, add a small dispatcher (Pi picks its startup directory before extensions load, so this can't be done from inside the extension):

```bash
command -v pi   # copy this path for the next step
```

Add to `~/.zshrc` or `~/.bashrc`:

```bash
export PI_WORKTREE_REAL_PI="/absolute/path/to/pi"   # from `command -v pi` above
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

```bash
source ~/.zshrc   # or ~/.bashrc
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

Point the launcher at the cloned package instead:

```bash
export PI_WORKTREE_LAUNCHER="/absolute/path/to/pi-worktree-extension/bin/pi-worktree"
```

</details>

## ⚡ Quick start

Start isolated tasks from separate terminals:

```bash
pi -w feature-auth
pi -w fix-pagination
pi -w add-api-tests
```

Each one gets its own files, branch, and session history:

```text
my-project/
├── primary checkout                 main
└── .pi/worktrees/
    ├── feature-auth/                worktree-feature-auth
    ├── fix-pagination/              worktree-fix-pagination
    └── add-api-tests/               worktree-add-api-tests
```

Running `pi -w feature-auth` again reopens that checkout and resumes its latest session.

Already mid-conversation? `/worktree feature-auth` moves it — full history included — into an isolated checkout instead of making you start over. `/worktree-exit` brings it back.

## 🎛️ Core commands

| Command | Description |
| --- | --- |
| `pi -w <name> [Pi args...]` | Create or reopen a task worktree and continue its latest session |
| `pi --worktree <name> [Pi args...]` | Long form of `pi -w` |
| `/worktree <name>` | Move the active conversation into a new or existing worktree |
| `/worktree-list` | List managed worktrees with their clean or dirty state |
| `/worktree-exit` | Move the active conversation back to the primary checkout |
| `/worktree-remove <name>` | Remove an inactive, clean checkout and keep its branch |

Names match `[a-z0-9][a-z0-9-]{0,47}` — e.g. `fix-auth`, `issue-123`, `prototype2`. `pi -w` supplies `--continue` itself; forward other Pi arguments freely, but not another resume/continue selector.

Ships with four Pi skills — create, switch, list, and remove worktree — that guide safe commands and recency-sorted selection.

## 🛡️ Safety by default

- New worktrees branch from local `origin/HEAD` (never fetched — falls back to `HEAD` with a warning if `origin/HEAD` isn't available). Prefer `HEAD` instead? Set `{ "base": "head" }` in `~/.pi/agent/worktree.json` or `<repository>/.pi/worktree.json`.
- Creating a worktree requires a clean source checkout. Removal is blocked by any tracked, untracked, or ignored files in the target, or while another Pi process is using it.
- Dirty worktrees can always be reopened — unfinished work is never stranded.
- Quitting Pi never removes a checkout. `/worktree-remove` never deletes the branch. There is no force mode.

Worktrees isolate files, not permissions — every Pi process still runs with your own user access against the same repository.

**Not (yet) included:** automatic fetch/remote branch management, automatic branch deletion or rename, copying ignored/dependency files into new worktrees. A hard crash can leave a conservative lock behind — safe to inspect once you've confirmed no Pi process holds that worktree.

## 🧹 Uninstall

```text
/worktree-list   # review before removing anything
```

```bash
pi remove npm:pi-worktree-extension
```

Then drop the dispatcher function and the `PI_WORKTREE_REAL_PI` / `PI_WORKTREE_LAUNCHER` variables from your shell config. Uninstalling never touches existing worktrees or `worktree-*` branches.

## 🤝 Contributing

Issues and small friction reports are welcome: [open an issue](https://github.com/AjayPoshak/pi-worktree-extension/issues/new).

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

## 📄 License

[MIT](LICENSE)
