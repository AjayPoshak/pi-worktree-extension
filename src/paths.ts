import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

export async function canonicalExisting(path: string): Promise<string> {
  return realpath(path);
}

/** Canonicalize a not-yet-created child using its real parent. */
export async function canonicalPlanned(path: string): Promise<string> {
  const parent = await realpath(dirname(path));
  return resolve(parent, basename(path));
}

export async function assertNotSymlink(path: string, label: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function ensureRealDirectory(path: string, label: string): Promise<void> {
  await assertNotSymlink(path, label);
  await mkdir(path, { recursive: true });
  await assertNotSymlink(path, label);
  const stat = await lstat(path);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
}
