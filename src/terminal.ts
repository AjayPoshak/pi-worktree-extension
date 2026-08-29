import { createConnection } from "node:net";
import { pathToFileURL } from "node:url";

interface TerminalOutput {
  isTTY?: boolean;
  write(text: string): unknown;
}

export function reportTerminalCwd(cwd: string, output: TerminalOutput = process.stdout): boolean {
  if (!output.isTTY) return false;
  output.write(`\x1b]7;${pathToFileURL(cwd).href}\x1b\\`);
  return true;
}

/** Update cmux's shell state, which drives its new-tab directory. */
export async function reportCmuxCwd(cwd: string, environment = process.env): Promise<boolean> {
  const socketPath = environment.CMUX_SOCKET_PATH;
  const tabId = environment.CMUX_TAB_ID ?? environment.CMUX_WORKSPACE_ID;
  const panelId = environment.CMUX_PANEL_ID ?? environment.CMUX_SURFACE_ID;
  if (!socketPath || !tabId || !panelId) return false;

  // This is cmux's shell-integration protocol, not its public JSON-RPC API.
  const quotedCwd = cwd.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const send = (options: string): Promise<boolean> => new Promise((resolve) => {
    let settled = false;
    const finish = (reported: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reported);
    };
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => { socket.destroy(); finish(false); }, 1_000);
    socket.once("error", () => finish(false));
    // A successful local write is enough: cmux closes this one-way protocol
    // without a response and may reset the connection after consuming it.
    socket.once("connect", () => socket.end(`report_pwd "${quotedCwd}" ${options}\n`, () => finish(true)));
  });

  // Match cmux's bundled shell integration exactly. This single report updates
  // both the panel directory and the tab's current directory used by new tabs.
  return send(`--tab=${tabId} --panel=${panelId}`);
}
