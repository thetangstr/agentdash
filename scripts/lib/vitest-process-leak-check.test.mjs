import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RUN_ID_ENV, createLeakCheck } from "./vitest-process-leak-check.mjs";

const posixOnly = process.platform === "win32" ? { skip: "posix process table only" } : {};
const bareEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
// node rather than `sleep`: macOS hides the environment of platform binaries
// from `ps -E`, and a runtime service is a node process anyway.
const IDLE = "setTimeout(() => {}, 300000)";
const idleCommand = (...extra) =>
  [process.execPath, "-e", IDLE, ...extra].map((part) => JSON.stringify(part)).join(" ");

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A direct, detached child of this process: a descendant of the run. */
function spawnChild({ cwd, env = bareEnv }) {
  const child = spawn(process.execPath, ["-e", IDLE], { cwd, env, detached: true, stdio: "ignore" });
  child.unref();
  return child.pid;
}

/**
 * A process that is NOT a descendant: started through a shell that exits at
 * once, so it is reparented away from this process. Resolves to its pid.
 */
async function spawnOrphan(script, { cwd = "/", env = bareEnv } = {}) {
  const shell = spawn("sh", ["-c", `${script} >/dev/null 2>&1 & echo $!`], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let out = "";
  shell.stdout.on("data", (chunk) => {
    out += chunk;
  });
  await new Promise((resolve) => shell.once("exit", resolve));
  const pid = Number(out.trim());
  assert.ok(pid > 0 && isAlive(pid), `orphan did not start: ${script}`);
  return pid;
}

function markedDir(runRoot, name) {
  const dir = path.join(runRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function settle() {
  // lsof and /proc can lag a freshly spawned process by a moment.
  await new Promise((resolve) => setTimeout(resolve, 300));
}

function cleanup(pids, runRoot) {
  for (const pid of pids) {
    if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  if (runRoot) fs.rmSync(runRoot, { recursive: true, force: true });
}

test("the run directory is short enough for a tsx IPC socket on macOS (104-byte sun_path)", posixOnly, async () => {
  const check = createLeakCheck({ pollMs: 0, settleMs: 0 });
  try {
    for (const root of [check.runRoot, fs.realpathSync(check.runRoot)]) {
      const pipe = path.join(root, `tsx-${os.userInfo().uid}`, "99999.pipe");
      assert.ok(Buffer.byteLength(pipe) < 104, `${pipe} is ${Buffer.byteLength(pipe)} bytes`);
    }
    assert.equal(process.env.TMPDIR, check.runRoot);
  } finally {
    await check.teardown();
  }
});

test("teardown fails and kills a leaked descendant, but not a process outside the run", posixOnly, async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "leak-check-outside-"));
  const check = createLeakCheck({ pollMs: 0, settleMs: 0 });
  let leaked = null;
  let bystander = null;
  try {
    // No run id in its environment: provably ours by descent alone.
    leaked = spawnChild({ cwd: markedDir(check.runRoot, "paperclip-runtime-sibling-a") });
    // Same marker and shape, but not inside this run's directory.
    bystander = spawnChild({ cwd: markedDir(outside, "paperclip-runtime-other-run") });
    await settle();

    await assert.rejects(check.teardown(), (error) => {
      assert.match(error.message, /\[process-leak-check\] 1 process/);
      assert.match(error.message, new RegExp(`pid ${leaked} \\(killed\\)`));
      assert.doesNotMatch(error.message, new RegExp(`pid ${bystander}\\b`));
      return true;
    });
    assert.equal(isAlive(leaked), false, "the leaked process was reported but left running");
    assert.equal(isAlive(bystander), true, "a process outside this run was killed");
  } finally {
    cleanup([leaked, bystander], check.runRoot);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("teardown kills a reparented leak that carries the run id in its environment", posixOnly, async () => {
  const check = createLeakCheck({ pollMs: 0, settleMs: 0 });
  let leaked = null;
  try {
    // What a detached runtime service looks like once its worker has exited.
    leaked = await spawnOrphan(idleCommand(), {
      cwd: markedDir(check.runRoot, "paperclip-runtime-service"),
      env: { ...bareEnv, [RUN_ID_ENV]: check.runId },
    });
    await settle();

    await assert.rejects(check.teardown(), new RegExp(`pid ${leaked} \\(killed\\)`));
    assert.equal(isAlive(leaked), false);
  } finally {
    cleanup([leaked], check.runRoot);
  }
});

test("a process that only names a path in the run directory is neither flagged nor killed", posixOnly, async () => {
  const check = createLeakCheck({ pollMs: 0, settleMs: 0 });
  const runRoot = check.runRoot;
  let decoy = null;
  let argDecoy = null;
  try {
    const log = path.join(markedDir(runRoot, "paperclip-runtime-decoy"), "service.log");
    fs.writeFileSync(log, "");
    // A developer's `tail -f` on a run log: not a descendant, no run id, cwd elsewhere.
    decoy = await spawnOrphan(`tail -f ${JSON.stringify(log)}`);
    // Naming the run id in its ARGUMENTS is not carrying it in its environment.
    argDecoy = await spawnOrphan(
      idleCommand(path.join(runRoot, "paperclip-ssh-fixture-x"), `${RUN_ID_ENV}=${check.runId}`),
    );
    await settle();

    await check.teardown();

    assert.equal(isAlive(decoy), true, "a tail -f on a run path was killed");
    assert.equal(isAlive(argDecoy), true, "a process naming the run id in its arguments was killed");
    assert.equal(fs.existsSync(runRoot), false, "a clean run did not remove its directory");
  } finally {
    cleanup([decoy, argDecoy], runRoot);
  }
});

test("a process started in the run directory but not provably ours is reported, not killed", posixOnly, async () => {
  const check = createLeakCheck({ pollMs: 0, settleMs: 0 });
  let suspect = null;
  try {
    suspect = await spawnOrphan(idleCommand(), { cwd: markedDir(check.runRoot, "paperclip-runtime-orphan") });
    await settle();

    await assert.rejects(check.teardown(), new RegExp(`pid ${suspect} \\(NOT killed`));
    assert.equal(isAlive(suspect), true);
  } finally {
    cleanup([suspect], check.runRoot);
  }
});

test("teardown restores TMPDIR and the run id variable", posixOnly, async () => {
  const savedTmpdir = process.env.TMPDIR;
  const savedRunId = process.env[RUN_ID_ENV];
  const check = createLeakCheck({ pollMs: 0, settleMs: 0 });
  assert.equal(process.env[RUN_ID_ENV], check.runId);
  await check.teardown();
  assert.equal(process.env.TMPDIR, savedTmpdir);
  assert.equal(process.env[RUN_ID_ENV], savedRunId);
});
