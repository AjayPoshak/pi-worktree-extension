#!/usr/bin/env node
import { isPersistentlyTrusted } from "./config.js";
import { prepareWorktree, resolveRepository } from "./worktrees.js";

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) throw new Error("usage: launcher-prepare <name>");
  const leaseText = process.env.PI_WORKTREE_LEASE_PID;
  if (!leaseText || !/^[1-9][0-9]*$/.test(leaseText)) throw new Error("launcher did not provide a valid shell PID for the startup lease");
  const leasePid = Number(leaseText);
  if (!Number.isSafeInteger(leasePid)) throw new Error("launcher shell PID is outside the safe integer range");
  const repo = await resolveRepository(process.cwd());
  const trustProject = await isPersistentlyTrusted(repo.primaryRoot);
  const prepared = await prepareWorktree(process.cwd(), name, { trustProject, leasePid });
  if (prepared.warning) process.stderr.write(`pi-worktree: warning: ${prepared.warning}\n`);
  process.stdout.write(`${prepared.record.path}\n`);
}

main().catch((error) => {
  process.stderr.write(`pi-worktree: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
