import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createLease, removeLease } from "../src/leases.js";
import { recordPath, recordsDirectory } from "../src/metadata.js";
import { listManaged, prepareWorktree, removeManaged, resolveRepository, rollbackCreated } from "../src/worktrees.js";
import { runGit } from "../src/git.js";

const execFile = promisify(execFileCallback);

async function makeRepository(): Promise<{ root: string; repo: string; home: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-worktree-integration-")));
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(repo);
  await mkdir(home);
  await runGit(["init", "-b", "main"], repo);
  await runGit(["config", "user.name", "Test User"], repo);
  await runGit(["config", "user.email", "test@example.invalid"], repo);
  await writeFile(join(repo, "README.md"), "fixture\n");
  await runGit(["add", "README.md"], repo);
  await runGit(["commit", "-m", "initial"], repo);
  return { root, repo, home };
}

test("create, reuse, list, and remove use real Git worktrees", async () => {
  const fixture = await makeRepository();
  try {
    const fromSubdirectory = join(fixture.repo, "nested", "directory");
    await mkdir(fromSubdirectory, { recursive: true });
    const created = await prepareWorktree(fromSubdirectory, "task-one", { trustProject: false, home: fixture.home });
    assert.equal(created.created, true);
    assert.match(created.warning ?? "", /origin\/HEAD.*using current HEAD/);
    assert.equal(created.record.path, join(fixture.repo, ".pi", "worktrees", "task-one"));
    assert.equal((await runGit(["branch", "--show-current"], created.record.path)).stdout.trim(), "worktree-task-one");

    const reused = await prepareWorktree(fixture.repo, "task-one", { trustProject: false, home: fixture.home });
    assert.equal(reused.created, false);
    assert.deepEqual(reused.record, created.record);

    const listed = await listManaged(await resolveRepository(fixture.repo));
    assert.equal(listed.invalid.length, 0);
    assert.equal(listed.valid.length, 1);
    assert.equal(listed.valid[0]?.clean, true);

    const exclude = await readFile(join(fixture.repo, ".git", "info", "exclude"), "utf8");
    assert.equal(exclude.split("\n").filter((line) => line === "/.pi/worktrees/").length, 1);
    await prepareWorktree(fixture.repo, "task-one", { trustProject: false, home: fixture.home });
    const excludeAgain = await readFile(join(fixture.repo, ".git", "info", "exclude"), "utf8");
    assert.equal(excludeAgain.split("\n").filter((line) => line === "/.pi/worktrees/").length, 1);

    const removed = await removeManaged(await resolveRepository(fixture.repo), "task-one", fixture.repo);
    assert.equal(removed.branch, "worktree-task-one");
    assert.equal(await runGit(["show-ref", "--verify", "refs/heads/worktree-task-one"], fixture.repo).then(() => true), true);
    assert.equal((await runGit(["worktree", "list", "--porcelain", "-z"], fixture.repo)).stdout.includes(created.record.path), false);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("creation rejects a dirty source but reuse permits a dirty target", async () => {
  const fixture = await makeRepository();
  try {
    await writeFile(join(fixture.repo, "dirty.txt"), "dirty\n");
    await assert.rejects(prepareWorktree(fixture.repo, "dirty-source", { trustProject: false, home: fixture.home }), /tracked or untracked changes/);
    await rm(join(fixture.repo, "dirty.txt"));
    const created = await prepareWorktree(fixture.repo, "reusable", { trustProject: false, home: fixture.home });
    await writeFile(join(created.record.path, "change.txt"), "keep me\n");
    const reused = await prepareWorktree(fixture.repo, "reusable", { trustProject: false, home: fixture.home });
    assert.equal(reused.created, false);
    await assert.rejects(removeManaged(await resolveRepository(fixture.repo), "reusable", fixture.repo), /has changes/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("startup launcher creates, reuses, changes cwd, and passes Pi arguments", async () => {
  const fixture = await makeRepository();
  try {
    const capture = join(fixture.root, "capture");
    const fakePi = join(fixture.root, "real-pi");
    await mkdir(capture);
    await writeFile(fakePi, '#!/usr/bin/env bash\nprintf "%s" "$PWD" > "$CAPTURE/cwd"\nprintf "%s\\n" "$@" > "$CAPTURE/args"\n');
    await chmod(fakePi, 0o755);
    const launcher = join(process.cwd(), "bin", "pi-worktree");
    const env = { ...process.env, HOME: fixture.home, CAPTURE: capture, PI_WORKTREE_REAL_PI: fakePi };
    const first = await execFile(launcher, ["startup", "--model", "provider/model"], { cwd: fixture.repo, env });
    const target = join(fixture.repo, ".pi", "worktrees", "startup");
    assert.match(first.stderr, /No network fetch was attempted/);
    assert.equal(await readFile(join(capture, "cwd"), "utf8"), target);
    assert.deepEqual((await readFile(join(capture, "args"), "utf8")).trim().split("\n"), ["--continue", "--model", "provider/model"]);

    const transcript = join(fixture.root, "terminal-output");
    const ptyCapture = [
      "import os, pty, sys",
      "pid, fd = pty.fork()",
      "if pid == 0: os.execv(sys.argv[2], sys.argv[2:])",
      "chunks = []",
      "while True:",
      "  try: data = os.read(fd, 4096)",
      "  except OSError: break",
      "  if not data: break",
      "  chunks.append(data)",
      "_, status = os.waitpid(pid, 0)",
      "open(sys.argv[1], 'wb').write(b''.join(chunks))",
      "raise SystemExit(os.waitstatus_to_exitcode(status))",
    ].join("\n");
    await execFile("python3", ["-c", ptyCapture, transcript, launcher, "startup"], { cwd: fixture.repo, env });
    const expectedCwdReport = `\x1b]7;${pathToFileURL(target).href}\x1b\\`;
    assert.equal((await readFile(transcript, "utf8")).includes(expectedCwdReport), true);

    // A relative real-Pi path is canonicalized before cwd changes.
    await execFile(launcher, ["startup", "--thinking", "high"], {
      cwd: fixture.repo,
      env: { ...env, PI_WORKTREE_REAL_PI: "../real-pi" },
    });
    assert.equal(await readFile(join(capture, "cwd"), "utf8"), target);
    assert.deepEqual((await readFile(join(capture, "args"), "utf8")).trim().split("\n"), ["--continue", "--thinking", "high"]);

    // npm-style node_modules/.bin symlinks must resolve the physical package root.
    assert.equal((await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], fixture.repo)).stdout, "");
    const binDirectory = join(fixture.root, "consumer", "node_modules", ".bin");
    await mkdir(binDirectory, { recursive: true });
    const linkedLauncher = join(binDirectory, "pi-worktree");
    await symlink(launcher, linkedLauncher);
    await execFile(linkedLauncher, ["linked"], { cwd: fixture.repo, env });
    assert.equal(await readFile(join(capture, "cwd"), "utf8"), join(fixture.repo, ".pi", "worktrees", "linked"));
    await assert.rejects(readFile(join(fixture.home, ".pi", "agent", "worktree.json")), /ENOENT/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("source ignored files do not block creation, but target ignored files block destructive cleanup", async () => {
  const fixture = await makeRepository();
  try {
    await writeFile(join(fixture.repo, ".gitignore"), "*.ignored\n");
    await runGit(["add", ".gitignore"], fixture.repo);
    await runGit(["commit", "-m", "ignore fixture"], fixture.repo);
    await writeFile(join(fixture.repo, "source.ignored"), "local source setup\n");

    const prepared = await prepareWorktree(fixture.repo, "ignored-target", { trustProject: false, home: fixture.home });
    await writeFile(join(prepared.record.path, "target.ignored"), "must survive\n");
    await assert.rejects(removeManaged(await resolveRepository(fixture.repo), "ignored-target", fixture.repo), /ignored files/);
    const rolledBack = await rollbackCreated(prepared);
    assert.equal(rolledBack.removed, false);
    assert.match(rolledBack.reason ?? "", /ignored files count as changes/);
    assert.equal(await readFile(join(prepared.record.path, "target.ignored"), "utf8"), "must survive\n");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("a live process lease blocks removal and the owner can release only its lease", async () => {
  const fixture = await makeRepository();
  try {
    const prepared = await prepareWorktree(fixture.repo, "leased", { trustProject: false, home: fixture.home });
    await createLease(prepared.repo.commonDir, prepared.record.name, process.pid);
    await assert.rejects(removeManaged(await resolveRepository(fixture.repo), "leased", fixture.repo), new RegExp(`leased.*PID ${process.pid}`));
    await removeLease(prepared.repo.commonDir, prepared.record.name, process.pid);
    await removeManaged(await resolveRepository(fixture.repo), "leased", fixture.repo);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test("managed layout rejects symlinks, tracked paths, case/branch collisions, and metadata mismatch", async (t) => {
  await t.test("symlinked project .pi", async () => {
    const fixture = await makeRepository();
    try {
      const outside = join(fixture.root, "outside");
      await mkdir(outside);
      await symlink(outside, join(fixture.repo, ".pi"));
      await assert.rejects(prepareWorktree(fixture.repo, "unsafe", { trustProject: false, home: fixture.home }), /must not be a symlink/);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("tracked managed path", async () => {
    const fixture = await makeRepository();
    try {
      await mkdir(join(fixture.repo, ".pi", "worktrees"), { recursive: true });
      await writeFile(join(fixture.repo, ".pi", "worktrees", "tracked.txt"), "tracked\n");
      await runGit(["add", ".pi/worktrees/tracked.txt"], fixture.repo);
      await runGit(["commit", "-m", "tracked unsafe path"], fixture.repo);
      await assert.rejects(prepareWorktree(fixture.repo, "unsafe", { trustProject: false, home: fixture.home }), /contains tracked paths/);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("case and branch collisions", async () => {
    const fixture = await makeRepository();
    try {
      await mkdir(join(fixture.repo, ".pi", "worktrees", "Task"), { recursive: true });
      await assert.rejects(prepareWorktree(fixture.repo, "task", { trustProject: false, home: fixture.home }), /case-insensitive path collision/);
      await rm(join(fixture.repo, ".pi", "worktrees", "Task"), { recursive: true });
      await runGit(["branch", "worktree-collision"], fixture.repo);
      await assert.rejects(prepareWorktree(fixture.repo, "collision", { trustProject: false, home: fixture.home }), /collides.*without a validated managed worktree/);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
  await t.test("metadata mismatch", async () => {
    const fixture = await makeRepository();
    try {
      const prepared = await prepareWorktree(fixture.repo, "metadata", { trustProject: false, home: fixture.home });
      await writeFile(recordPath(prepared.repo.commonDir, "metadata"), `${JSON.stringify({ ...prepared.record, primaryRoot: "/wrong" })}\n`);
      await assert.rejects(prepareWorktree(fixture.repo, "metadata", { trustProject: false, home: fixture.home }), /does not match.*managed layout/);
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
});

test("prepare failure preserves checkout and branch when safe removal cannot be proven", async () => {
  const fixture = await makeRepository();
  try {
    await writeFile(join(fixture.repo, ".gitignore"), "*.ignored\n");
    await runGit(["add", ".gitignore"], fixture.repo);
    await runGit(["commit", "-m", "ignore fixture"], fixture.repo);
    const repo = await resolveRepository(fixture.repo);
    await mkdir(recordsDirectory(repo.commonDir), { recursive: true });
    const hook = join(fixture.repo, ".git", "hooks", "post-checkout");
    await writeFile(hook, `#!/usr/bin/env bash\ntouch "$PWD/recovery.ignored"\nrmdir ${JSON.stringify(recordsDirectory(repo.commonDir))}\nprintf 'blocks metadata directory\\n' > ${JSON.stringify(recordsDirectory(repo.commonDir))}\n`);
    await chmod(hook, 0o755);

    await assert.rejects(
      prepareWorktree(fixture.repo, "cleanup-failure", { trustProject: false, home: fixture.home }),
      /Preserved checkout .*cleanup-failure.*branch worktree-cleanup-failure/,
    );
    const target = join(fixture.repo, ".pi", "worktrees", "cleanup-failure");
    assert.equal((await lstat(target)).isDirectory(), true);
    assert.equal(await readFile(join(target, "recovery.ignored"), "utf8"), "");
    assert.equal(await runGit(["show-ref", "--verify", "refs/heads/worktree-cleanup-failure"], fixture.repo).then(() => true), true);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
