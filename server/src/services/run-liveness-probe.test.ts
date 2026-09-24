import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHermesLedgerFixture } from "../__tests__/helpers/hermes-ledger-fixture.js";
import { inferHeartbeatRunStopReason } from "./heartbeat-stop-metadata.js";
import {
  DEFAULT_FIRST_OUTPUT_DEADLINE_MS,
  effectiveActivityAt,
  hasFirstOutput,
  probeRunLiveness,
  readHermesLedgerActivity,
  resolveFirstOutputDeadlineMs,
  resolveHermesLedgerPathForRun,
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

describe("resolveHermesLedgerPathForRun", () => {
  it("prefers AGENTDASH_HERMES_STATE_DB, then HERMES_HOME", () => {
    expect(resolveHermesLedgerPathForRun({}, { AGENTDASH_HERMES_STATE_DB: "/x/state.db" })).toBe("/x/state.db");
    expect(resolveHermesLedgerPathForRun({}, { HERMES_HOME: "/h" })).toBe(path.resolve("/h", "state.db"));
  });

  it("reads the profile ledger named by -p, by config, or by the alias wrapper", () => {
    const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-profiles-"));
    cleanups.push(() => fs.rmSync(profilesDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(profilesDir, "agentdash"));
    fs.writeFileSync(path.join(profilesDir, "agentdash", "state.db"), "");
    const env = { HERMES_PROFILES_DIR: profilesDir };
    const expected = path.join(profilesDir, "agentdash", "state.db");

    expect(resolveHermesLedgerPathForRun({ extraArgs: ["-p", "agentdash"] }, env)).toBe(expected);
    expect(resolveHermesLedgerPathForRun({ hermesProfile: "agentdash" }, env)).toBe(expected);
    expect(resolveHermesLedgerPathForRun({ hermesCommand: "/Users/x/.local/bin/agentdash" }, env)).toBe(expected);
    // Unknown profile falls back to the root ledger.
    expect(resolveHermesLedgerPathForRun({ hermesCommand: "hermes" }, env)).toBe(
      path.join(os.homedir(), ".hermes", "state.db"),
    );
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
    // Clamped to the run start: the session's first row predates this run.
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
    expect(activity.lastActivityAt?.toISOString()).toBe(minutesAgo(2).toISOString());
  });

  it("uses the least recent open session when a shared profile is ambiguous", () => {
    const { dbPath } = ledger([
      { id: "s-busy", startedAt: minutesAgo(74), usage: [{ firstSeen: minutesAgo(73), lastSeen: minutesAgo(1) }] },
      { id: "s-stuck", startedAt: minutesAgo(70), usage: [{ firstSeen: minutesAgo(69), lastSeen: minutesAgo(65) }] },
    ]);
    const activity = readHermesLedgerActivity({ ledgerPath: dbPath, runStartedAt: minutesAgo(74) });
    expect(activity.lastActivityAt?.toISOString()).toBe(minutesAgo(65).toISOString());
  });

  it("reports a missing ledger instead of throwing", () => {
    const activity = readHermesLedgerActivity({ ledgerPath: "/nonexistent/state.db", runStartedAt: minutesAgo(5) });
    expect(activity.status).toBe("missing");
    expect(activity.lastActivityAt).toBeNull();
  });

  it("reports a read ledger with no row for a zero-turn session", () => {
    const { dbPath } = ledger([{ id: "s-zero", startedAt: minutesAgo(11) }]);
    const activity = readHermesLedgerActivity({ ledgerPath: dbPath, runStartedAt: minutesAgo(11) });
    expect(activity.status).toBe("read");
    expect(activity.firstActivityAt).toBeNull();
    expect(activity.anyActivityAt).toBeNull();
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
    const evidence = probeRunLiveness(run, hermesAgent, { ...alive, ledgerPath: dbPath });
    expect(evidence).toMatchObject({ probe: "hermes_ledger", processAlive: true, ledgerStatus: "read" });
    expect(effectiveActivityAt(run, evidence)?.toISOString()).toBe(minutesAgo(4).toISOString());
  });

  it("a Hermes run whose process is dead falls back to output silence", () => {
    const { dbPath } = ledger([
      { id: "s1", startedAt: minutesAgo(74), usage: [{ firstSeen: minutesAgo(73), lastSeen: minutesAgo(4) }] },
    ]);
    const run = hermesRun();
    const evidence = probeRunLiveness(run, hermesAgent, { ...dead, ledgerPath: dbPath });
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

describe("first-output deadline", () => {
  it("defaults to 10 minutes for hermes_local and is opt-in for streaming adapters", () => {
    expect(resolveFirstOutputDeadlineMs("hermes_local", {}, {})).toBe(DEFAULT_FIRST_OUTPUT_DEADLINE_MS);
    expect(resolveFirstOutputDeadlineMs("hermes_local", { firstOutputDeadlineSec: 120 }, {})).toBe(120_000);
    expect(resolveFirstOutputDeadlineMs("hermes_local", { firstOutputDeadlineSec: 0 }, {})).toBeNull();
    expect(resolveFirstOutputDeadlineMs("hermes_local", {}, { AGENTDASH_FIRST_OUTPUT_DEADLINE_MS: "0" })).toBeNull();
    expect(resolveFirstOutputDeadlineMs("codex_local", {}, {})).toBeNull();
    expect(resolveFirstOutputDeadlineMs("codex_local", { firstOutputDeadlineSec: 300 }, {})).toBe(300_000);
  });

  it("judges Hermes first output from the ledger, and refuses to judge without one", () => {
    const run = { id: "r", processStartedAt: minutesAgo(11), lastOutputAt: minutesAgo(11) };
    const zero = ledger([{ id: "s-zero", startedAt: minutesAgo(11) }]);
    const zeroEvidence = probeRunLiveness(run, { adapterType: "hermes_local", adapterConfig: {} }, {
      ...alive,
      ledgerPath: zero.dbPath,
    });
    expect(hasFirstOutput(run, zeroEvidence)).toBe(false);

    const missing = probeRunLiveness(run, { adapterType: "hermes_local", adapterConfig: {} }, {
      ...alive,
      ledgerPath: "/nonexistent/state.db",
    });
    expect(hasFirstOutput(run, missing)).toBeNull();
  });

  it("maps the no_first_output error code to its own stop reason", () => {
    expect(inferHeartbeatRunStopReason({ outcome: "failed", errorCode: "no_first_output" })).toBe("no_first_output");
    expect(inferHeartbeatRunStopReason({ outcome: "failed", errorCode: "adapter_failed" })).toBe("adapter_failed");
  });
});
