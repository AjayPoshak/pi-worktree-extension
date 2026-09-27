# Run parallel Pi coding tasks safely with Git worktrees

AI coding agents are most useful when you can keep moving while a different task is underway. The catch: two Pi sessions editing the same checkout can overwrite files, collide in Git, or lose each other's context.

Pi Worktree gives every task three things of its own:

- a Git branch;
- an isolated checkout; and
- a Pi conversation that can be resumed later.

## Get started

Install the extension once:

```bash
pi install npm:pi-worktree-extension
```

From a Git repository, start Pi and create a worktree for a task:

```text
/worktree fix-auth
```

Pi moves the active conversation into `.pi/worktrees/fix-auth` on branch `worktree-fix-auth`. Start another terminal for an independent task:

```text
/worktree add-api-tests
```

The tasks now have separate files and branches, so they can proceed at the same time.

## Resume work without reconstructing context

A worktree is not only a directory. Pi Worktree keeps it associated with its latest conversation. Reopen a task with the optional shell launcher:

```bash
pi -w fix-auth
```

Or, from an existing session, switch to a managed worktree:

```text
/worktree-switch fix-auth
```

Use `/worktree-exit` to return the conversation to the primary checkout.

## A practical workflow

Use separate worktrees for tasks that can be reviewed and merged independently:

```text
main checkout      review changes and integrate work
fix-auth           investigate and fix authentication
add-api-tests      add regression coverage
refactor-cache     explore a larger refactor
```

Keep each task narrow. Before creating a new worktree, leave the source checkout clean. When a task is done, commit its branch and remove its checkout:

```text
/worktree-remove fix-auth
```

Removal is deliberately conservative: Pi Worktree refuses to remove an active or dirty checkout, and it keeps the branch. This avoids deleting unfinished work accidentally.

## When worktrees help most

Use this workflow when you need to:

- investigate a bug while another task is implementing a feature;
- run multiple independent coding tasks concurrently;
- preserve a conversation's context while isolating its edits; or
- review or test one change without stashing another.

Git worktrees do not remove the need for review or integration. They only make parallel work safe at the filesystem and branch level. Keep tasks independent where possible, run tests in each checkout, and merge deliberately.

## Try it

```bash
pi install npm:pi-worktree-extension
```

Project: <https://github.com/AjayPoshak/pi-worktree-extension>
