import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPersistentlyTrusted, loadConfig, testing as configTesting } from "../src/config.js";
import { parseRecord, readRecord, writeRecordAtomic, type WorktreeRecord } from "../src/metadata.js";
import { isContained } from "../src/paths.js";
import { parseWorktreePorcelain } from "../src/porcelain.js";
import { validateSlug } from "../src/worktrees.js";

for (const valid of ["a", "0", "feature-1", "a".repeat(48)]) {
  test(`valid slug: ${valid}`, () => assert.doesNotThrow(() => validateSlug(valid)));
}
for (const invalid of ["", "A", "-a", "a_b", "a/b", "../x", "a".repeat(49), "x Y"]) {
  test(`invalid slug: ${invalid}`, () => assert.throws(() => validateSlug(invalid)));
}

test("porcelain parser handles NUL records, spaces, flags, and unknown fields", () => {
  const parsed = parseWorktreePorcelain(
    "worktree /tmp/main repo\0HEAD 012345\0branch refs/heads/main\0future value\0\0" +
    "worktree /tmp/linked\0HEAD abcdef\0detached\0locked reason with spaces\0\0",
  );
  assert.deepEqual(parsed, [
    { path: "/tmp/main repo", head: "012345", branch: "refs/heads/main", bare: false, detached: false },
    { path: "/tmp/linked", head: "abcdef", bare: false, detached: true, locked: "reason with spaces" },
  ]);
});

test("canonical containment rejects siblings, equality, and traversal", () => {
  assert.equal(isContained("/repo/.pi/worktrees", "/repo/.pi/worktrees/task"), true);
  assert.equal(isContained("/repo/.pi/worktrees", "/repo/.pi/worktrees"), false);
  assert.equal(isContained("/repo/.pi/worktrees", "/repo/.pi/worktrees-evil/task"), false);
  assert.equal(isContained("/repo/.pi/worktrees", "/repo/.pi/elsewhere"), false);
});

test("config layers trusted project over global and validates values", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktree-config-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  try {
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await mkdir(join(repo, ".pi"), { recursive: true });
    await writeFile(join(home, ".pi", "agent", "worktree.json"), '{"base":"head"}\n');
    await writeFile(join(repo, ".pi", "worktree.json"), '{"base":"fresh"}\n');
    assert.deepEqual(await loadConfig(repo, false, home), { base: "head" });
    assert.deepEqual(await loadConfig(repo, true, home), { base: "fresh" });
    assert.throws(() => configTesting.parseConfig('{"base":"network"}', "test"), /fresh.*head/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("persisted trust uses exact/ancestor booleans and ignores non-boolean entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worktree-trust-"));
  const home = join(root, "home");
  try {
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(join(home, ".pi", "agent", "trust.json"), JSON.stringify({ "/repo": true, "/repo/denied": false, "/other": "yes" }));
    assert.equal(await isPersistentlyTrusted("/repo/project", home), true);
    assert.equal(await isPersistentlyTrusted("/repo/denied/child", home), false);
    assert.equal(await isPersistentlyTrusted("/other", home), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("metadata records round-trip atomically and reject malformed data", async () => {
  const common = await mkdtemp(join(tmpdir(), "pi-worktree-meta-"));
  const record: WorktreeRecord = {
    version: 1,
    name: "task",
    primaryRoot: "/repo",
    path: "/repo/.pi/worktrees/task",
    branch: "worktree-task",
    baseOid: "a".repeat(40),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  try {
    await writeRecordAtomic(common, record);
    assert.deepEqual(await readRecord(common, "task"), record);
    assert.match(await readFile(join(common, "pi-worktree", "records", "task.json"), "utf8"), /worktree-task/);
    assert.throws(() => parseRecord('{"version":1}', "test"), /malformed/);
  } finally { await rm(common, { recursive: true, force: true }); }
});
