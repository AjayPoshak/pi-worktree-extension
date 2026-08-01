import { lstat, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureRealDirectory } from "./paths.js";

export const METADATA_VERSION = 1;

export interface WorktreeRecord {
  version: 1;
  name: string;
  primaryRoot: string;
  path: string;
  branch: string;
  baseOid: string;
  createdAt: string;
}

export function recordsDirectory(commonDir: string): string {
  return join(commonDir, "pi-worktree", "records");
}

export function recordPath(commonDir: string, name: string): string {
  return join(recordsDirectory(commonDir), `${name}.json`);
}

export function parseRecord(text: string, source = "metadata"): WorktreeRecord {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error(`Invalid ${source}: ${error instanceof Error ? error.message : String(error)}`); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid ${source}: expected object`);
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.name !== "string" || typeof v.primaryRoot !== "string" ||
      typeof v.path !== "string" || typeof v.branch !== "string" ||
      typeof v.baseOid !== "string" || !/^[0-9a-f]{40,64}$/.test(v.baseOid) ||
      typeof v.createdAt !== "string" || !Number.isFinite(Date.parse(v.createdAt))) {
    throw new Error(`Invalid ${source}: malformed worktree record`);
  }
  return v as unknown as WorktreeRecord;
}

export async function readRecord(commonDir: string, name: string): Promise<WorktreeRecord | undefined> {
  const path = recordPath(commonDir, name);
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Metadata record must not be a symlink: ${path}`);
    return parseRecord(await readFile(path, "utf8"), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function listRecords(commonDir: string): Promise<Array<{ file: string; record?: WorktreeRecord; error?: string }>> {
  const directory = recordsDirectory(commonDir);
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const results: Array<{ file: string; record?: WorktreeRecord; error?: string }> = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const record = await readRecord(commonDir, file.slice(0, -5));
      results.push(record ? { file, record } : { file, error: "record disappeared" });
    } catch (error) {
      results.push({ file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export async function writeRecordAtomic(commonDir: string, record: WorktreeRecord): Promise<void> {
  const ownerDirectory = join(commonDir, "pi-worktree");
  await ensureRealDirectory(ownerDirectory, "metadata root");
  const directory = recordsDirectory(commonDir);
  await ensureRealDirectory(directory, "metadata records directory");
  const destination = recordPath(commonDir, record.name);
  const temporary = join(directory, `.${record.name}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try { await rename(temporary, destination); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

export async function removeRecord(commonDir: string, name: string): Promise<void> {
  await rm(recordPath(commonDir, name));
}
