---
name: switch-worktree
description: Switch an active Pi conversation between the primary checkout and managed worktrees. Use when resuming another task or moving a session into or out of a worktree.
---

# Switch Worktree

- Switch into a named worktree with `/worktree <name>`.
- Return to the primary checkout with `/worktree-exit`.
- If no target is named, present a simple selectable list sorted by recency.
- Show names, clean/dirty state, and branch; do not show paths.
- Use arrows and Enter to select; Escape cancels.

After switching, recheck cwd, Git branch, and filesystem assumptions.
