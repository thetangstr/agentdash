// AgentDash: fail a vitest run that leaves runtime-service or SSH-fixture
// processes alive.
//
// Tests start real processes: workspace runtime services (spawned detached, so
// they outlive the worker) and sshd env-lab fixtures. A test that forgets to
// stop one leaks it past the run, and on a long-lived machine those pile up:
// orphaned `node -e createServer` services and sshd daemons that keep running
// for weeks after the run that started them.
//
// Scoped to THIS run, so it never kills anything else on the machine:
//
// - Setup gives the run its own short TMPDIR and a run id in the environment
//   (`VITEST_LEAK_RUN_ID`). Workers and everything they spawn inherit both.
// - While the run is live, it records every descendant of this process (pid
//   plus start time). Detached children are reparented once their worker
//   exits, so descendancy has to be observed during the run, not at the end.
// - At teardown a process is a leak only if it carries a leak marker
//   (`paperclip-runtime-`, `paperclip-ssh-fixture-`, `sshd_config`) inside the
//   run directory, by cwd or command line. It is killed only if it is provably
//   this run's: a recorded descendant with the same start time, or a process
//   whose environment carries the run id. Something that merely names the
//   path, such as a `tail -f` on a log in it, is never touched.
// - A process that was plainly started for this run (cwd in the run
//   directory, or an sshd whose -f config is in it) but could not be proven
//   ours is reported, which still fails the run, and left running.

import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Path fragments that identify the processes this check is about. */
export const LEAK_MARKERS = ["paperclip-runtime-", "paperclip-ssh-fixture-", "sshd_config"];

/** Environment variable carrying this run's id to every process it starts. */
export const RUN_ID_ENV = "VITEST_LEAK_RUN_ID";

const SETTLE_MS = 5_000;
const POLL_MS = 500;
const KILL_GRACE_MS = 2_000;
const PS_ARGS = ["-A", "-ww", "-o", "pid=,ppid=,lstart=,command="];
// `lstart` is five fields: "Wed Sep  2 08:18:03 2026".
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runText(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // lsof and ps exit 1 when some requested pid is gone but print the rest.
    return typeof error?.stdout === "string" ? error.stdout : "";
  }
}

function parseProcessTable(out) {
  const table = new Map();
  for (const line of out.split("\n")) {
    const match = PS_LINE.exec(line);
    if (!match) continue;
    table.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      started: match[3].replace(/\s+/g, " "),
      command: match[4],
    });
  }
  return table;
}

function readProcessTable() {
  return parseProcessTable(runText("ps", PS_ARGS));
}

function descendantsOf(rootPid, table) {
  const children = new Map();
  for (const entry of table.values()) {
    if (!children.has(entry.ppid)) children.set(entry.ppid, []);
    children.get(entry.ppid).push(entry);
  }
  const found = [];
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const entry = queue.shift();
    found.push(entry);
    queue.push(...(children.get(entry.pid) ?? []));
  }
  return found;
}

/** pid -> cwd, for this user's processes. */
function listCwds(pids) {
  const cwds = new Map();
  if (process.platform === "linux") {
    for (const pid of pids) {
      try {
        cwds.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`));
      } catch {
        // Gone, or not ours to read.
      }
    }
    return cwds;
  }
  const out = runText("lsof", ["-a", "-u", String(os.userInfo().uid), "-d", "cwd", "-Fpn"]);
  let pid = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== null) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/** True when the process's own environment (not its arguments) carries the run id. */
function environmentCarriesRunId(pid, runId) {
  const needle = `${RUN_ID_ENV}=${runId}`;
  if (process.platform === "linux") {
    try {
      return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(needle);
    } catch {
      return false;
    }
  }
  // macOS: `ps -E` appends the environment to the arguments. Only the part
  // after the arguments counts, so an argument naming the id proves nothing.
  const args = runText("ps", ["-ww", "-o", "command=", "-p", String(pid)]).replace(/\n$/, "");
  const withEnv = runText("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)]).replace(/\n$/, "");
  if (!args || !withEnv.startsWith(args)) return false;
  return withEnv.slice(args.length).split(/\s+/).includes(needle);
}

function rootVariants(runRoot) {
  const variants = new Set([path.resolve(runRoot)]);
  try {
    // macOS: /tmp -> /private/tmp. Command lines carry the path as it was
    // given; lsof reports the resolved one.
    variants.add(fs.realpathSync(runRoot));
  } catch {
    // Already removed; the given path is all there is to match.
  }
  return [...variants];
}

function isInside(candidate, roots) {
  return roots.some((root) => candidate === root || candidate.includes(`${root}${path.sep}`));
}

function sshdConfigInside(command, roots) {
  const match = /(?:^|[\s/])sshd(?::\s+\S*sshd)?\s.*?-f\s+(\S+)/.exec(command);
  return Boolean(match) && isInside(match[1], roots);
}

/**
 * A short base for the run directory. macOS caps a unix socket path at 104
 * bytes, and tools put sockets under TMPDIR (tsx: `<TMPDIR>/tsx-<uid>/<pid>.pipe`).
 * Nesting under the default /var/folders/… tmpdir, or under the stable
 * runner's per-invocation tmp, overflows it.
 */
export function runRootBase() {
  return process.platform === "win32" ? os.tmpdir() : "/tmp";
}

/**
 * Leaks still alive for a run. `killable` is set only for processes proven to
 * be this run's; the rest are reported but must not be signalled.
 */
export function findLeakedProcesses({ runRoot, runId, descendants, markers = LEAK_MARKERS }) {
  const roots = rootVariants(runRoot);
  const table = readProcessTable();
  const cwds = listCwds([...table.keys()]);
  const leaked = [];
  for (const entry of table.values()) {
    if (entry.pid === process.pid) continue;
    const cwd = cwds.get(entry.pid) ?? "";
    const cwdInRun = isInside(cwd, roots);
    const commandInRun = isInside(entry.command, roots);
    if (!cwdInRun && !commandInRun) continue;
    const marked = markers.some((marker) => entry.command.includes(marker) || cwd.includes(marker));
    if (!marked) continue;

    const descendant = descendants.get(entry.pid) === entry.started;
    const killable = descendant || environmentCarriesRunId(entry.pid, runId);
    const startedForRun = cwdInRun || sshdConfigInside(entry.command, roots);
    if (!killable && !startedForRun) continue; // Only names the path: not ours.
    leaked.push({ ...entry, cwd, killable });
  }
  return leaked;
}

function stillSameProcess(entry) {
  const now = parseProcessTable(runText("ps", ["-o", "pid=,ppid=,lstart=,command=", "-p", String(entry.pid)]));
  return now.get(entry.pid)?.started === entry.started;
}

/**
 * SIGTERM, then SIGKILL whatever is left. Each signal is sent only after
 * re-reading the pid's start time, so a pid recycled in between is spared.
 */
export async function killProcesses(entries) {
  for (const entry of entries) {
    if (!stillSameProcess(entry)) continue;
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline && entries.some(stillSameProcess)) await sleep(100);
  for (const entry of entries.filter(stillSameProcess)) {
    try {
      process.kill(entry.pid, "SIGKILL");
    } catch {
      // Raced to exit.
    }
  }
}

/**
 * Start a leak check for one run. Exported for its own tests; vitest uses the
 * default export. `pollMs: 0` records descendants only at teardown.
 */
export function createLeakCheck({ pollMs = POLL_MS, settleMs = SETTLE_MS } = {}) {
  const previousTmpdir = process.env.TMPDIR;
  const previousRunId = process.env[RUN_ID_ENV];
  const runId = randomBytes(6).toString("hex");
  const runRoot = fs.mkdtempSync(path.join(runRootBase(), "pvr-"));
  process.env.TMPDIR = runRoot;
  process.env[RUN_ID_ENV] = runId;

  // pid -> start time, for every process seen descending from this one.
  const descendants = new Map();
  const record = (table) => {
    for (const entry of descendantsOf(process.pid, table)) descendants.set(entry.pid, entry.started);
  };

  let polling = false;
  const timer =
    pollMs > 0
      ? setInterval(() => {
          if (polling) return;
          polling = true;
          execFile("ps", PS_ARGS, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
            polling = false;
            if (!error) record(parseProcessTable(stdout));
          });
        }, pollMs)
      : null;
  timer?.unref();

  async function teardown() {
    if (timer) clearInterval(timer);
    record(readProcessTable());
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    if (previousRunId === undefined) delete process.env[RUN_ID_ENV];
    else process.env[RUN_ID_ENV] = previousRunId;

    // A service stopped at the very end of a test can still be shutting down.
    const deadline = Date.now() + settleMs;
    let leaked = findLeakedProcesses({ runRoot, runId, descendants });
    while (leaked.length > 0 && Date.now() < deadline) {
      await sleep(200);
      leaked = findLeakedProcesses({ runRoot, runId, descendants });
    }
    if (leaked.length === 0) {
      fs.rmSync(runRoot, { recursive: true, force: true });
      return;
    }

    // Stopped so the leak does not outlive the report, but still a failure:
    // the test that started them is what needs fixing.
    const killable = leaked.filter((entry) => entry.killable);
    await killProcesses(killable);
    const detail = leaked
      .map(
        (entry) =>
          `  pid ${entry.pid} ${entry.killable ? "(killed)" : "(NOT killed: not provably this run's; stop it by hand)"} `
          + `cwd=${entry.cwd || "?"}\n    ${entry.command}`,
      )
      .join("\n");
    throw new Error(
      `[process-leak-check] ${leaked.length} process(es) started by this vitest run were still alive `
        + `after it finished. A test is not stopping what it starts:\n${detail}\n`
        + `Run directory kept for inspection: ${runRoot}`,
    );
  }

  return { runRoot, runId, teardown };
}

/** vitest globalSetup: returns the teardown. */
export default function setup() {
  if (process.platform === "win32") return undefined;
  return createLeakCheck().teardown;
}
