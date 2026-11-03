import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { runChildProcess, runningProcesses, signalRunningProcess } from "../server-utils.ts";

// No exception/rejection handlers: a broken pipe must be handled by production
// code, not hidden by the test runner. Only this exact Node executable is run.
const scenario = process.argv[2];
assert.ok(["early-exit", "delayed-on-spawn", "failed-spawn", "failed-on-spawn", "roundtrip", "unexpected-stdin-error", "sync-stdin-error", "sync-closed-pipe", "sync-destroyed-pipe"].includes(scenario));
const runId = randomUUID();
const prompt = "stdin-private-prompt-marker:".repeat(300_000);
const logs = [];
const diagnostics = [];
let spawnCalls = 0;
const failsStdin = scenario === "unexpected-stdin-error" || scenario === "sync-stdin-error";
const inputError = Object.assign(new Error("synthetic stdin transport unavailable"), { code: "EIO" });
let owned;
let childClosed;
let trackedAtExit = false;
let watchdogFired = false;
const readsStdin = scenario === "roundtrip" || scenario === "failed-on-spawn";
const command = scenario === "failed-spawn" ? `${process.cwd()}/missing-executable` : process.execPath;
const args = failsStdin
  ? ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000);"]
  : readsStdin
  ? ["-e", "const {createHash}=require('node:crypto');const hash=createHash('sha256');let bytes=0;process.stdin.on('data',chunk=>{bytes+=chunk.length;hash.update(chunk)});process.stdin.on('end',()=>process.stdout.write(JSON.stringify({bytes,sha256:hash.digest('hex')})));"]
  : ["-e", "process.stderr.write('worker refused before reading stdin\\n');process.exit(126);"];
function observeOwnedChild() {
  owned = runningProcesses.get(runId);
  childClosed = new Promise((resolve) => owned.child.once("close", resolve));
  owned.child.once("exit", () => { trackedAtExit = runningProcesses.get(runId) === owned; });
}
const options = {
  cwd: process.cwd(),
  env: {},
  stdin: prompt,
  timeoutSec: failsStdin ? 0 : 5,
  graceSec: 1,
  onLog: async (stream, chunk) => {
    logs.push({ stream, chunk });
    if (scenario === "unexpected-stdin-error" && chunk.includes("ready")) {
      observeOwnedChild();
      owned.child.stdin.destroy(inputError);
    }
  },
  onLogError: (error, id, message) => { diagnostics.push({ code: error.code, id, message }); },
  onSpawn: async () => {
    spawnCalls++;
    if (scenario === "delayed-on-spawn") await new Promise((resolve) => setTimeout(resolve, 150));
    if (scenario === "failed-on-spawn") throw new Error("metadata persistence unavailable");
    if (scenario === "sync-stdin-error") {
      await Promise.resolve();
      observeOwnedChild();
      owned.child.stdin.write = () => { throw inputError; };
    }
    if (scenario === "sync-closed-pipe" || scenario === "sync-destroyed-pipe") {
      await Promise.resolve();
      const code = scenario === "sync-closed-pipe" ? "EPIPE" : "ERR_STREAM_DESTROYED";
      runningProcesses.get(runId).child.stdin.write = () => { throw Object.assign(new Error("closed stdin"), { code }); };
    }
  },
};

if (failsStdin) {
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    if (owned) signalRunningProcess(owned, "SIGKILL");
  }, 4_000);
  try {
    await assert.rejects(runChildProcess(runId, command, args, options), (error) => error === inputError);
    assert.ok(owned);
    assert.equal(trackedAtExit, true, "tracking must remain until the child terminates");
    assert.equal(runningProcesses.has(runId), false, "rejection must wait for registry cleanup");
    assert.ok(owned.child.exitCode !== null || owned.child.signalCode !== null, "rejection must wait for termination");
    assert.throws(() => process.kill(owned.child.pid, 0), { code: "ESRCH" });
    if (scenario === "unexpected-stdin-error") assert.equal(owned.child.signalCode, "SIGKILL");
    assert.equal(watchdogFired, false, "production must terminate its child before the test watchdog");
  } finally {
    clearTimeout(watchdog);
    if (owned) signalRunningProcess(owned, "SIGKILL");
    if (childClosed) await childClosed;
  }
} else if (scenario === "failed-spawn") {
  await assert.rejects(runChildProcess(runId, command, args, options), /Failed to start command/);
  assert.equal(spawnCalls, 0);
} else {
  const result = await runChildProcess(runId, command, args, options);
  assert.equal(spawnCalls, 1);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, null);
  if (readsStdin) {
    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      bytes: Buffer.byteLength(prompt),
      sha256: createHash("sha256").update(prompt).digest("hex"),
    });
  } else {
    assert.equal(result.exitCode, 126);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "worker refused before reading stdin\n");
    assert.deepEqual(logs, [{ stream: "stderr", chunk: result.stderr }]);
  }
}

// Exercise pending onSpawn work after close/failed spawn as well as late stream
// events. Strict rejection mode makes a floating promise fail the parent.
await new Promise((resolve) => setTimeout(resolve, 250));
assert.equal(runningProcesses.has(runId), false);
assert.equal(JSON.stringify(logs).includes("stdin-private-prompt-marker"), false);
assert.equal(JSON.stringify(diagnostics).includes("stdin-private-prompt-marker"), false);
if (scenario === "failed-on-spawn") {
  assert.deepEqual(diagnostics, [{ code: undefined, id: runId, message: "failed to record child process metadata" }]);
}
process.stdout.write(`${JSON.stringify({ scenario, parentSurvived: true })}\n`);
