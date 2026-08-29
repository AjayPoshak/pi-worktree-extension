---
name: create-worktree
description: Create an isolated Pi Git worktree for a task. Use when starting a new worktree, isolated task, or parallel coding session.
---

# Create Worktree

- From a shell, use `pi -w <name>`.
- In Pi, use `/worktree <name>`.
- Names must match `[a-z0-9][a-z0-9-]{0,47}`.
- New worktrees require a clean source checkout.
- Explain the created worktree name, checkout path, and retained branch.

Ignored source files do not block creation and are not copied. Do not use forceful Git commands for managed worktrees.
