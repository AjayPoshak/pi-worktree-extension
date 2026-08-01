import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type BaseMode = "fresh" | "head";

export interface WorktreeConfig {
  base: BaseMode;
}

function parseConfig(text: string, source: string): Partial<WorktreeConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid ${source}: expected a JSON object`);
  }
  const value = (parsed as Record<string, unknown>).base;
  if (value !== undefined && value !== "fresh" && value !== "head") {
    throw new Error(`Invalid ${source}: base must be "fresh" or "head"`);
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "base") throw new Error(`Invalid ${source}: unknown property ${JSON.stringify(key)}`);
  }
  return value === undefined ? {} : { base: value };
}

async function readOptional(path: string): Promise<Partial<WorktreeConfig>> {
  try {
    return parseConfig(await readFile(path, "utf8"), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function loadConfig(primaryRoot: string, trustProject: boolean, home = homedir()): Promise<WorktreeConfig> {
  const globalConfig = await readOptional(join(home, ".pi", "agent", "worktree.json"));
  const projectConfig = trustProject ? await readOptional(join(primaryRoot, ".pi", "worktree.json")) : {};
  return { base: projectConfig.base ?? globalConfig.base ?? "fresh" };
}

/** Read Pi's persisted trust decision without modifying user configuration. */
export async function isPersistentlyTrusted(primaryRoot: string, home = homedir()): Promise<boolean> {
  const trustPath = join(home, ".pi", "agent", "trust.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(trustPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`Cannot read Pi project trust from ${trustPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const decisions = parsed as Record<string, unknown>;
  let current = primaryRoot;
  while (true) {
    if (decisions[current] === true) return true;
    if (decisions[current] === false) return false;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export const testing = { parseConfig };
