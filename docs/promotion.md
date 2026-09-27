# Launch copy

## Pi Discord / Reddit

I built **Pi Worktree**, a Pi extension for running multiple coding tasks in parallel without sharing a checkout.

Each task gets an isolated Git worktree, branch, and resumable Pi conversation. You can also move an in-progress conversation into a worktree, so it keeps its context instead of starting from zero.

```bash
pi install npm:pi-worktree-extension
```

Then, inside any Git repository:

```text
/worktree fix-auth
```

The optional `pi -w fix-auth` launcher reopens a task directly from the shell.

The project is deliberately conservative: it will not force-remove worktrees or delete branches. I would especially value feedback from people who run parallel Pi sessions: what makes setup, dependencies, cleanup, or merging painful?

- Package: <https://pi.dev/packages/pi-worktree-extension>
- Source: <https://github.com/AjayPoshak/pi-worktree-extension>

## Request for a Pi package showcase

Subject: Pi Worktree — parallel Pi sessions with isolated Git worktrees

Hi Pi maintainers — I published Pi Worktree, a package for running parallel Pi coding tasks safely. It creates isolated worktrees and branches, keeps each task associated with a resumable Pi conversation, and can move an active conversation into a worktree.

Install: `pi install npm:pi-worktree-extension`

Would it be suitable for inclusion in a community package showcase or extension roundup? I would appreciate any feedback on its package metadata, documentation, or integration with the Pi ecosystem.

- Package: <https://pi.dev/packages/pi-worktree-extension>
- Source: <https://github.com/AjayPoshak/pi-worktree-extension>
