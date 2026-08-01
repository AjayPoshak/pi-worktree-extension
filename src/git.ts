import { execFile } from "node:child_process";

export const GIT_TIMEOUT_MS = 15_000;

export class GitError extends Error {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly killed: boolean;

  constructor(message: string, args: readonly string[], cwd: string, stderr: string, exitCode: number | null, killed: boolean) {
    super(message);
    this.name = "GitError";
    this.args = args;
    this.cwd = cwd;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.killed = killed;
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

/** Run git without a shell. Every invocation has an explicit cwd and timeout. */
export function runGit(args: readonly string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  if (!cwd) throw new Error("runGit requires an explicit cwd");
  if (!(timeoutMs > 0)) throw new Error("runGit requires a positive timeout");

  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const killed = Boolean(error.killed || error.signal);
          const exitCode = typeof error.code === "number" ? error.code : null;
          const detail = killed
            ? `git was killed or timed out after ${timeoutMs}ms`
            : `git exited ${exitCode ?? "abnormally"}`;
          reject(new GitError(`${detail}: git ${args.join(" ")}${stderr.trim() ? `: ${stderr.trim()}` : ""}`, args, cwd, stderr, exitCode, killed));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

