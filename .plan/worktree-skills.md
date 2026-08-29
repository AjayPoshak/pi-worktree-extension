# Worktree Skills Plan

## Skills

1. **Create worktree**
   - Use `/worktree <name>` or `pi -w <name>`.
   - Check naming and clean-source requirements.
   - Explain the created branch and path.

2. **Switch worktree**
   - Present a selectable list of existing worktrees, sorted by recency.
   - Move the active Pi session into the selected worktree.
   - Return to the primary checkout with `/worktree-exit`.
   - Recheck cwd and Git state after switching.

3. **List worktrees**
   - Use `/worktree-list`.
   - Show selectable worktree options, sorted by recency, with clean/dirty state and branch.
   - Switch to the selected worktree.

4. **Remove worktree**
   - Present a selectable list of worktrees eligible for removal, sorted by recency.
   - Verify the selected worktree is inactive and clean first.
   - Preserve the branch; never force removal.

## Implementation

- Create one `SKILL.md` per skill under `skills/`.
- Keep each skill short, command-oriented, and explicit about safety rules.
- Register/package `skills/` so Pi discovers it.
- Add a short README section listing the four skills.
