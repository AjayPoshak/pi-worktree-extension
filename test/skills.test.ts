import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const skillsRoot = join(root, "skills");
const expectedSkills = [
  "create-worktree",
  "list-worktrees",
  "remove-worktree",
  "switch-worktree",
];

test("package contains only the planned worktree skills", async () => {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  assert.deepEqual(
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
    expectedSkills,
  );

  for (const name of expectedSkills) {
    const content = await readFile(join(skillsRoot, name, "SKILL.md"), "utf8");
    assert.match(content, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
  }
});

test("package manifest registers and publishes skills", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    files?: string[];
    pi?: { skills?: string[] };
  };
  assert.deepEqual(packageJson.pi?.skills, ["./skills"]);
  assert.ok(packageJson.files?.includes("skills"));
});

test("selection skills keep the simple recency-sorted workflow", async () => {
  for (const name of ["switch-worktree", "list-worktrees", "remove-worktree"]) {
    const content = await readFile(join(skillsRoot, name, "SKILL.md"), "utf8");
    assert.match(content, /selectable list sorted by recency/);
    assert.doesNotMatch(content, /filesystem paths/);
  }
});
