export interface WorktreePorcelainEntry {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked?: string;
  prunable?: string;
}

/** Parse `git worktree list --porcelain -z` without line or whitespace assumptions. */
export function parseWorktreePorcelain(input: string): WorktreePorcelainEntry[] {
  const tokens = input.split("\0");
  const entries: WorktreePorcelainEntry[] = [];
  let current: WorktreePorcelainEntry | undefined;

  const finish = (): void => {
    if (!current) return;
    if (!current.path) throw new Error("Malformed worktree porcelain: missing worktree path");
    entries.push(current);
    current = undefined;
  };

  for (const token of tokens) {
    if (token === "") {
      finish();
      continue;
    }
    const space = token.indexOf(" ");
    const key = space < 0 ? token : token.slice(0, space);
    const value = space < 0 ? "" : token.slice(space + 1);
    if (key === "worktree") {
      finish();
      current = { path: value, bare: false, detached: false };
      continue;
    }
    if (!current) throw new Error(`Malformed worktree porcelain: ${JSON.stringify(token)} before worktree`);
    switch (key) {
      case "HEAD": current.head = value; break;
      case "branch": current.branch = value; break;
      case "bare": current.bare = true; break;
      case "detached": current.detached = true; break;
      case "locked": current.locked = value; break;
      case "prunable": current.prunable = value; break;
      default: break; // Forward-compatible with new porcelain attributes.
    }
  }
  finish();
  return entries;
}
