import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCallback);

interface TerminalOutput {
  isTTY?: boolean;
  write(text: string): unknown;
}

export function reportTerminalCwd(cwd: string, output: TerminalOutput = process.stdout): boolean {
  if (!output.isTTY) return false;
  output.write(`\x1b]7;${pathToFileURL(cwd).href}\x1b\\`);
  return true;
}

/** Update cmux's workspace state, which drives its new-tab directory. */
export async function reportCmuxCwd(cwd: string, environment = process.env): Promise<boolean> {
  const workspaceId = environment.CMUX_WORKSPACE_ID;
  const surfaceId = environment.CMUX_PANEL_ID ?? environment.CMUX_SURFACE_ID;
  if (!workspaceId || !surfaceId) return false;

  const cmux = environment.CMUX_BUNDLED_CLI_PATH || "cmux";
  try {
    await execFile(cmux, ["rpc", "surface.report_pwd", JSON.stringify({
      workspace_id: workspaceId,
      surface_id: surfaceId,
      path: cwd,
    })], { timeout: 1_000, windowsHide: true });
    return true;
  } catch {
    // cmux is optional; its control socket must never delay Pi startup.
    return false;
  }
}
