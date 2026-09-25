import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createHermesLedgerFixture } from "../__tests__/helpers/hermes-ledger-fixture.js";
import { inferHeartbeatRunStopReason } from "./heartbeat-stop-metadata.js";
import { agentProfileName } from "./hermes-profile.js";
import {
  DEFAULT_FIRST_OUTPUT_DEADLINE_MS,
  classifyFirstOutput,
  effectiveActivityAt,
  isSameProcess,
  probeRunLiveness,
  readHermesLedgerActivity,
  resolveFirstOutputDeadlineMode,
  resolveFirstOutputDeadlineMs,
  resolveHermesLedgerForRun,
  type HermesLedgerResolution,
} from "./run-liveness-probe.js";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const alive = { isPidAlive: () => true, isProcessGroupAlive: () => true };
const dead = { isPidAlive: () => false, isProcessGroupAlive: () => false };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function ledger(...args: Parameters<typeof createHermesLedgerFixture>) {
  const fixture = createHermesLedgerFixture(...args);
  cleanups.push(fixture.cleanup);
  return fixture;
}

function tempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const certainLedger = (dbPath: string): HermesLedgerResolution => ({
  path: dbPath,
  certainty: "certain",
  source: "env_state_db",
  profile: null,
});

/** A fake ~/.hermes with profiles and an optional sticky active profile. */
function hermesRoot(opts: { profiles: string[]; active?: string }) {
  const root = tempDir("hermes-root-");
  fs.writeFileSync(path.join(root, "state.db"), "");
  for (const profile of opts.profiles) {
    fs.mkdirSync(path.join(root, "profiles", profile), { recursive: true });
    fs.writeFileSync(path.join(root, "profiles", profile, "state.db"), "");
  }
  if (opts.active) fs.writeFileSync(path.join(root, "active_profile"), `${opts.active}\n`);
  return root;
}

describe("managed-profile liveness (#703): resolve through the agent's own profile", () => {
  // The stored adapterConfig of a managed agent names no profile: the
  // per-agent wrapper is injected only at run time (registry.ts). Resolving
  // from the stored config pointed both the first-output deadline and the
  // stale-run scan at the root ledger, where no managed run ever writes.
  const agentId = "5b0c7a1e-0000-4000-8000-00000000abcd";
  const ownProfile = agentProfileName(agentId);

  function managedEnv(extra: Record<string, string> = {}) {
    const root = hermesRoot({ profiles: [] });
    const bin = tempDir("hermes-bin-");
    return {
      root,
      bin,
      env: {
        AGENTDASH_HERMES_ROOT: root,
        HERMES_PROFILES_DIR: path.join(root, "profiles"),
        AGENTDASH_HERMES_BIN_DIR: bin,
        AGENTDASH_HERMES_MANAGED_PROFILES: "true",
        ...extra,
      } as NodeJS.ProcessEnv,
    };
  }

  it("on a hosted box, resolves the profile ledger, certain, from a stored config with no -p", () => {
    const { root, env } = managedEnv({ AGENTDASH_DEPLOYMENT_KIND: "hosted" });
    expect(resolveHermesLedgerForRun({}, env, agentId)).toMatchObject({
      path: path.join(root, "profiles", ownProfile, "state.db"),
      certainty: "certain",
      source: "profile_hint",
      profile: ownProfile,
    });
  });

  it("with managed profiles on and the wrapper provisioned, ignores a foreign -p the run strips", () => {
    const { root, bin, env } = managedEnv();
    fs.mkdirSync(path.join(root, "profiles", "ccworker"), { recursive: true });
    fs.writeFileSync(path.join(root, "profiles", "ccworker", "state.db"), "");
    fs.writeFileSync(path.join(bin, ownProfile), `#!/bin/sh\nexec hermes -p ${ownProfile} "$@"\n`, { mode: 0o755 });
    expect(resolveHermesLedgerForRun({ args: ["-p", "ccworker"] }, env, agentId)).toMatchObject({
      path: path.join(root, "profiles", ownProfile, "state.db"),
      source: "profile_hint",
    });
  });

  it("on-prem with no wrapper (provisioning fell back), resolves like the stored command the run used", () => {
    const { root, env } = managedEnv();
    expect(resolveHermesLedgerForRun({}, env, agentId)).toMatchObject({
      path: path.join(root, "state.db"),
      source: "root_fallback",
    });
  });

  it("probeRunLiveness reads the managed agent's profile ledger, keyed by the run's agentId", () => {
    const { root, env } = managedEnv({ AGENTDASH_DEPLOYMENT_KIND: "hosted" });
    const profileDir = path.join(root, "profiles", ownProfile);
    fs.mkdirSync(profileDir, { recursive: true });
    ledger(
      [{ id: "s1", startedAt: minutesAgo(20), usage: [{ firstSeen: minutesAgo(19), lastSeen: minutesAgo(2) }] }],
      profileDir,
    );
    const run = { id: "run-m", agentId, processPid: 4242, processStartedAt: minutesAgo(20), startedAt: minutesAgo(20) };
    const evidence = probeRunLiveness(run, { adapterType: "hermes_local", adapterConfig: {} }, { ...alive, env });
    expect(evidence).toMatchObject({
      probe: "hermes_ledger",
      ledgerPath: path.join(profileDir, "state.db"),
      ledgerCertainty: "certain",
      ledgerSource: "profile_hint",
      ledgerStatus: "read",
      sessionIds: ["s1"],
    });
  });

  it("without managed profiles, the stored config still decides", () => {
    const root = hermesRoot({ profiles: [] });
    expect(resolveHermesLedgerForRun({}, { AGENTDASH_HERMES_ROOT: root }, agentId)).toMatchObject({
      path: path.join(root, "state.db"),
      source: "root_fallback",
    });
  });
});

describe("resolveHermesLedgerForRun", () => {
  it("is certain for an explicit state DB, an adapter env HERMES_HOME, or the server's HERMES_HOME", () => {
    expect(resolveHermesLedgerForRun({}, { AGENTDASH_HERMES_STATE_DB: "/x/state.db" })).toMatchObject({
      path: "/x/state.db",
      certainty: "certain",
    });
    expect(
      resolveHermesLedgerForRun({ env: { HERMES_HOME: { type: "plain", value: "/agent/home" } } }, { HERMES_HOME: "/server" }),
    ).toMatchObject({ path: path.resolve("/agent/home", "state.db"), certainty: "certain", source: "adapter_env_hermes_home" });
    expect(resolveHermesLedgerForRun({}, { HERMES_HOME: "/h" })).toMatchObject({
      path: path.resolve("/h", "state.db"),
      certainty: "certain",
    });
  });

  it("is certain for an explicit -p naming an existing profile", () => {
    const root = hermesRoot({ profiles: ["agentdash"] });
    const env = { AGENTDASH_HERMES_ROOT: root };
    expect(resolveHermesLedgerForRun({ extraArgs: ["-p", "agentdash"] }, env)).toMatchObject({
      path: path.join(root, "profiles", "agentdash", "state.db"),
      certainty: "certain",
      source: "profile_arg",
    });
  });

  it("reads a wrapper script for its profile instead of trusting the file name", () => {
    const root = hermesRoot({ profiles: ["rosstest", "agentdash"], active: "agentdash" });
    const bin = tempDir("hermes-bin-");
    // The wrapper's name does not match the profile it runs.
    const wrapper = path.join(bin, "hermes-rosstest");
    fs.writeFileSync(wrapper, "#!/bin/sh\nmkdir -p /tmp/x\nexec /usr/local/bin/hermes -p rosstest \"$@\"\n");
    expect(resolveHermesLedgerForRun({ hermesCommand: wrapper }, { AGENTDASH_HERMES_ROOT: root })).toMatchObject({
      path: path.join(root, "profiles", "rosstest", "state.db"),
      certainty: "certain",
      source: "wrapper_script",
    });

    // An opaque wrapper is unknown, never guessed from its name.
    const opaque = path.join(bin, "rosstest");
    fs.writeFileSync(opaque, "#!/bin/sh\nmkdir -p /tmp/x\nexec some-launcher \"$@\"\n");
    expect(resolveHermesLedgerForRun({ hermesCommand: opaque }, { AGENTDASH_HERMES_ROOT: root })).toMatchObject({
      certainty: "uncertain",
      source: "active_profile",
      profile: "agentdash",
    });
  });

  it("treats the sticky active profile and the root ledger as uncertain", () => {
    const root = hermesRoot({ profiles: ["agentdash"], active: "agentdash" });
    expect(resolveHermesLedgerForRun({ hermesCommand: "hermes" }, { AGENTDASH_HERMES_ROOT: root, PATH: "" })).toMatchObject({
      path: path.join(root, "profiles", "agentdash", "state.db"),
      certainty: "uncertain",
      source: "active_profile",
    });
    const bare = hermesRoot({ profiles: [] });
    expect(resolveHermesLedgerForRun({}, { AGENTDASH_HERMES_ROOT: bare })).toMatchObject({
      path: path.join(bare, "state.db"),
      certainty: "uncertain",
      source: "root_fallback",
    });
  });
});

describe("readHermesLedgerActivity", () => {
  it("attributes a resumed session and ignores activity from before the run", () => {
    const { dbPath } = ledger([
      {
        id: "s-resumed",
        startedAt: minutesAgo(600),
        usage: [
          { firstSeen: minutesAgo(600), lastSeen: minutesAgo(500), model: "old" },
          { firstSeen: minutesAgo(80), lastSeen: minutesAgo(3) },
        ],
      },
    ]);
    const activity = readHermesLedgerActivity({ ledgerPath: dbPath, sessionId: "s-resumed", runStartedAt: minutesAgo(74) });
    expect(activity.status).toBe("read");
    expect(activity.sessionIds).toEqual(["s-resumed"]);
    expect(activity.lastActivityAt?.toISOString()).toBe(minutesAgo(3).toISOString());
    expect(activity.firstActivityAt?.toISOString()).toBe(minutesAgo(74).toISOString());
  });

  it("finds a new open session and skips sessions that ended", () => {
    const { dbPath } = ledger([
      { id: "s-new", startedAt: minutesAgo(74), usage: [{ firstSeen: minutesAgo(73), lastSeen: minutesAgo(2) }] },
      {
        id: "s-finished",
        startedAt: minutesAgo(60),
        endedAt: minutesAgo(50),
        usage: [{ firstSeen: minutesAgo(59), lastSeen: minutesAgo(50) }],
      },
    ]);
    const activity = readHermesLedgerActivity({ ledgerPath: dbPath, runStartedAt: minutesAgo(74) });
    expect(activity.sessionIds).toEqual(["s-new"]);
    expect(activity.windowSessionIds).toEqual(["s-new"]);
    expect(activity.lastActivityAt?.toISOString()).toBe(minutesAgo(2).toISOString());
  });

  it("on a shared profile uses the least recent session and attributes only sessions from the run's window", () => {
    const { dbPath } = ledger([
      { id: "s-busy", startedAt: minutesAgo(74), usage: [{ firstSeen: minutesAgo(73), lastSeen: minutesAgo(1) }] },
      { id: "s-other", startedAt: minutesAgo(70), usage: [{ firstSeen: minutesAgo(69), lastSeen: minutesAgo(65) }] },
    ]);
    const activity = readHermesLedgerActivity({ ledgerPath: dbPath, runStartedAt: minutesAgo(74) });
    expect(activity.lastActivityAt?.toISOString()).toBe(minutesAgo(65).toISOString());
    // s-other opened 4 minutes after this run started: another run's session.
    expect(activity.windowSessionIds).toEqual(["s-busy"]);
  });

  it("reports a missing ledger instead of throwing", () => {
    const activity = readHermesLedgerActivity({ ledgerPath: "/nonexistent/state.db", runStartedAt: minutesAgo(5) });
    expect(activity.status).toBe("missing");
  });

  it("reports a corrupt ledger as unreadable", () => {
    const dir = tempDir("hermes-corrupt-");
    const dbPath = path.join(dir, "state.db");
    fs.writeFileSync(dbPath, "this is not a sqlite database at all, just bytes ".repeat(200));
    expect(readHermesLedgerActivity({ ledgerPath: dbPath, runStartedAt: minutesAgo(5) }).status).toBe("unreadable");
  });

  it("reports a locked ledger as unreadable", () => {
    const { dbPath } = ledger([{ id: "s1", startedAt: minutesAgo(11) }]);
    const writer = new DatabaseSync(dbPath);
    writer.exec("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE; INSERT INTO sessions (id, source, started_at) VALUES ('s2', 'tool', 1);");
    try {
      expect(readHermesLedgerActivity({ ledgerPath: dbPath, runStartedAt: minutesAgo(11) }).status).toBe("unreadable");
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });

  it("reports a read ledger with no row for a zero-turn session", () => {
    const { dbPath } = ledger([{ id: "s-zero", startedAt: minutesAgo(11) }]);
    const activity = readHermesLedgerActivity({ ledgerPath: dbPath, runStartedAt: minutesAgo(11) });
    expect(activity.status).toBe("read");
    expect(activity.windowSessionIds).toEqual(["s-zero"]);
    expect(activity.firstActivityAt).toBeNull();
  });
});

describe("probeRunLiveness + effectiveActivityAt", () => {
  const hermesAgent = { adapterType: "hermes_local", adapterConfig: {} };
  const hermesRun = (overrides: Record<string, unknown> = {}) => ({
    id: "run-1",
    processPid: 4242,
    processStartedAt: minutesAgo(74),
    startedAt: minutesAgo(74),
    lastOutputAt: minutesAgo(74),
    ...overrides,
  });

  it("a 74-minute Hermes run with an advancing ledger is active as of its last ledger row", () => {
    const { dbPath } = ledger([
      { id: "s1", startedAt: minutesAgo(74), usage: [{ firstSeen: minutesAgo(73), lastSeen: minutesAgo(4) }] },
    ]);
    const run = hermesRun();
    const evidence = probeRunLiveness(run, hermesAgent, { ...alive, ledger: certainLedger(dbPath) });
    expect(evidence).toMatchObject({ probe: "hermes_ledger", processAlive: true, ledgerStatus: "read" });
    expect(effectiveActivityAt(run, evidence)?.toISOString()).toBe(minutesAgo(4).toISOString());
  });

  it("a Hermes run whose process is dead falls back to output silence", () => {
    const { dbPath } = ledger([
      { id: "s1", startedAt: minutesAgo(74), usage: [{ firstSeen: minutesAgo(73), lastSeen: minutesAgo(4) }] },
    ]);
    const run = hermesRun();
    const evidence = probeRunLiveness(run, hermesAgent, { ...dead, ledger: certainLedger(dbPath) });
    expect(evidence.processAlive).toBe(false);
    expect(effectiveActivityAt(run, evidence)?.toISOString()).toBe(minutesAgo(74).toISOString());
  });

  it("streaming adapters keep last_output_at", () => {
    const run = hermesRun({ lastOutputAt: minutesAgo(80) });
    const evidence = probeRunLiveness(run, { adapterType: "codex_local", adapterConfig: {} }, alive);
    expect(evidence.probe).toBe("output");
    expect(effectiveActivityAt(run, evidence)?.toISOString()).toBe(minutesAgo(80).toISOString());
  });
});

describe("classifyFirstOutput", () => {
  const hermesAgent = { adapterType: "hermes_local", adapterConfig: {} };
  const run = { id: "r", processStartedAt: minutesAgo(11), startedAt: minutesAgo(11), lastOutputAt: minutesAgo(11) };

  it("is none_certain only with a certain ledger, a session in the run's window, and a known process start", () => {
    const { dbPath } = ledger([{ id: "s-zero", startedAt: minutesAgo(11) }]);
    const evidence = probeRunLiveness(run, hermesAgent, { ...alive, ledger: certainLedger(dbPath) });
    expect(classifyFirstOutput(run, evidence).kind).toBe("none_certain");

    const noSpawnTime = { ...run, processStartedAt: null };
    expect(classifyFirstOutput(noSpawnTime, probeRunLiveness(noSpawnTime, hermesAgent, { ...alive, ledger: certainLedger(dbPath) })).kind).toBe(
      "none_uncertain",
    );
  });

  it("never reaches none_certain on an uncertain ledger (the stale-root case)", () => {
    const { dbPath } = ledger([{ id: "s-zero", startedAt: minutesAgo(11) }]);
    const evidence = probeRunLiveness(run, hermesAgent, {
      ...alive,
      ledger: { path: dbPath, certainty: "uncertain", source: "root_fallback", profile: null },
    });
    expect(classifyFirstOutput(run, evidence)).toMatchObject({ kind: "none_uncertain" });
  });

  it("never reaches none_certain when the ledger reads fine but holds no session for this run", () => {
    // A wrong-but-existing ledger: readable, certain by configuration, stale.
    const { dbPath } = ledger([
      { id: "s-old", startedAt: minutesAgo(20_000), endedAt: minutesAgo(19_000), usage: [{ firstSeen: minutesAgo(20_000), lastSeen: minutesAgo(19_000) }] },
    ]);
    const evidence = probeRunLiveness(run, hermesAgent, { ...alive, ledger: certainLedger(dbPath) });
    expect(evidence.ledgerStatus).toBe("read");
    expect(classifyFirstOutput(run, evidence)).toMatchObject({ kind: "none_uncertain" });
  });

  it("is unknown when the ledger is missing or unreadable, and seen after a first row", () => {
    const missing = probeRunLiveness(run, hermesAgent, { ...alive, ledger: certainLedger("/nonexistent/state.db") });
    expect(classifyFirstOutput(run, missing).kind).toBe("unknown");
    const { dbPath } = ledger([
      { id: "s1", startedAt: minutesAgo(11), usage: [{ firstSeen: minutesAgo(9), lastSeen: minutesAgo(9) }] },
    ]);
    expect(classifyFirstOutput(run, probeRunLiveness(run, hermesAgent, { ...alive, ledger: certainLedger(dbPath) })).kind).toBe("seen");
  });

  it("streaming adapters are at most none_uncertain", () => {
    const quiet = { ...run, lastOutputAt: minutesAgo(12) };
    const evidence = probeRunLiveness(quiet, { adapterType: "codex_local", adapterConfig: {} }, alive);
    expect(classifyFirstOutput(quiet, evidence).kind).toBe("none_uncertain");
  });
});

describe("first-output deadline settings", () => {
  it("defaults to 10 minutes for hermes_local and is opt-in for streaming adapters", () => {
    expect(resolveFirstOutputDeadlineMs("hermes_local", {}, {})).toBe(DEFAULT_FIRST_OUTPUT_DEADLINE_MS);
    expect(resolveFirstOutputDeadlineMs("hermes_local", { firstOutputDeadlineSec: 120 }, {})).toBe(120_000);
    expect(resolveFirstOutputDeadlineMs("hermes_local", { firstOutputDeadlineSec: 0 }, {})).toBeNull();
    expect(resolveFirstOutputDeadlineMs("hermes_local", {}, { AGENTDASH_FIRST_OUTPUT_DEADLINE_MS: "0" })).toBeNull();
    expect(resolveFirstOutputDeadlineMs("codex_local", {}, {})).toBeNull();
    expect(resolveFirstOutputDeadlineMs("codex_local", { firstOutputDeadlineSec: 300 }, {})).toBe(300_000);
  });

  it("defaults to shadow; enforce is opt-in per instance or per agent", () => {
    expect(resolveFirstOutputDeadlineMode({}, {})).toBe("shadow");
    expect(resolveFirstOutputDeadlineMode({}, { AGENTDASH_FIRST_OUTPUT_DEADLINE_MODE: "enforce" })).toBe("enforce");
    expect(resolveFirstOutputDeadlineMode({ firstOutputDeadlineMode: "shadow" }, { AGENTDASH_FIRST_OUTPUT_DEADLINE_MODE: "enforce" })).toBe("shadow");
    expect(resolveFirstOutputDeadlineMode({ firstOutputDeadlineMode: "enforce" }, {})).toBe("enforce");
    expect(resolveFirstOutputDeadlineMode({ firstOutputDeadlineMode: "bogus" }, {})).toBe("shadow");
  });

  it("maps the no_first_output error code to its own stop reason", () => {
    expect(inferHeartbeatRunStopReason({ outcome: "failed", errorCode: "no_first_output" })).toBe("no_first_output");
    expect(inferHeartbeatRunStopReason({ outcome: "failed", errorCode: "adapter_failed" })).toBe("adapter_failed");
  });
});

describe("isSameProcess", () => {
  it("matches a pid only when the OS start time agrees with the recorded one", () => {
    const recorded = minutesAgo(11);
    expect(isSameProcess(123, recorded, () => new Date(recorded.getTime() + 1_000))).toBe(true);
    expect(isSameProcess(123, recorded, () => minutesAgo(2))).toBe(false); // pid reused
    expect(isSameProcess(123, recorded, () => null)).toBe(false);
    expect(isSameProcess(123, null, () => recorded)).toBe(false);
  });

  it("reads a real process's start time", () => {
    if (process.platform === "win32") return;
    expect(isSameProcess(process.pid, new Date(Date.now() - process.uptime() * 1000))).toBe(true);
  });
});
