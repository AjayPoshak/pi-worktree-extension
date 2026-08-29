---
name: remove-worktree
description: Safely remove a finished managed Pi worktree while retaining its branch. Use when cleaning up a completed worktree.
---

# Remove Worktree

- Present eligible worktrees in a simple selectable list sorted by recency.
- Show names, clean/dirty state, and branch; do not show paths.
- Use arrows and Enter to select; Escape cancels.
- Verify the selected worktree is inactive and clean before removal.
- Use `/worktree-remove <name>`.
- Never force removal; the branch is retained.
