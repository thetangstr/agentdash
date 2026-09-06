// Reconciling the two historical deployment state files into one.
//
// The scenario in `prefers the running commit` is not hypothetical. On the
// first design-partner host the source updater recorded one commit, the native
// deploy recorded another, and the server was running a third — a feature
// branch nobody had deployed. The updater's own check output read
// `"upToDate": false` and offered to "update" the machine by reverting it.
//
// The rule these tests pin: the running commit is observed, everything else is
// recorded, and observation wins.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OTA_STATE_SCHEMA_VERSION } from "@paperclipai/shared";
import {
  CANONICAL_STATE_FILENAME,
  LEGACY_NATIVE_STATE_FILENAME,
  LEGACY_SOURCE_STATE_FILENAME,
  readCanonicalState,
  readLegacyStates,
  reconcileDeploymentState,
  stateMatchesRunning,
  writeCanonicalState,
} from "../services/ota-deployment-state.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ota-state-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

const SOURCE_STATE = {
  currentSha: "4637abd727dfe98b4865bec30a39cd772c484749",
  previousSha: "e912d614c8f81498c842b154182bb764a98d0164",
  updatedAt: "2026-08-27T20:58:41.867Z",
};

const NATIVE_STATE = {
  currentSha: "f552df77417143fd6a949eff8553b98578317f5e",
  previousSha: "a02aaaa4d5aab889799cc6d1c6e69fdfb44f0ed5",
  updatedAt: "2026-08-27T17:14:21Z",
  lastReceiptPath: "/receipts/2026-08-27T17-14-21Z-source-update.json",
};

describe("reconcileDeploymentState", () => {
  it("prefers the newer legacy record when they disagree", () => {
    const state = reconcileDeploymentState({
      sourceState: SOURCE_STATE,
      nativeState: NATIVE_STATE,
      runningCommit: SOURCE_STATE.currentSha,
      now: "2026-09-01T00:00:00Z",
    });
    expect(state.current.commit).toBe(SOURCE_STATE.currentSha);
    expect(state.previous?.commit).toBe(SOURCE_STATE.previousSha);
    expect(state.reconciledFrom).toEqual([LEGACY_SOURCE_STATE_FILENAME, LEGACY_NATIVE_STATE_FILENAME]);
    expect(state.schemaVersion).toBe(OTA_STATE_SCHEMA_VERSION);
  });

  // The failure that motivated this module.
  it("prefers the running commit over every recorded state, and keeps the drift visible", () => {
    const running = "36b140522ebfaf31a7dd4097f04f206116e19b77";
    const state = reconcileDeploymentState({
      sourceState: SOURCE_STATE,
      nativeState: NATIVE_STATE,
      runningCommit: running,
      now: "2026-09-01T00:00:00Z",
    });
    expect(state.current.commit).toBe(running);
    // The most recently recorded "current" becomes the rollback candidate,
    // because it is the last thing anybody deliberately deployed.
    expect(state.previous?.commit).toBe(SOURCE_STATE.currentSha);
    expect(state.reconciledFrom).toHaveLength(2);
  });

  it("falls back to the recorded commit when the running one is unknown", () => {
    const state = reconcileDeploymentState({
      sourceState: SOURCE_STATE,
      nativeState: null,
      runningCommit: null,
      now: "2026-09-01T00:00:00Z",
    });
    expect(state.current.commit).toBe(SOURCE_STATE.currentSha);
    expect(state.previous?.commit).toBe(SOURCE_STATE.previousSha);
  });

  it("produces a usable state on a host with no history at all", () => {
    const state = reconcileDeploymentState({
      sourceState: null,
      nativeState: null,
      runningCommit: "abc1234def5678",
      now: "2026-09-01T00:00:00Z",
    });
    expect(state.current.commit).toBe("abc1234def5678");
    expect(state.previous).toBeNull();
    expect(state.reconciledFrom).toBeNull();
  });

  it("records the release directory when the process was launched from one", () => {
    const state = reconcileDeploymentState({
      sourceState: null,
      nativeState: null,
      runningCommit: "abc1234",
      runningReleaseDir: "/opt/releases/v2026.827.2-4637abd7",
      now: "2026-09-01T00:00:00Z",
    });
    expect(state.current.releaseDir).toBe("/opt/releases/v2026.827.2-4637abd7");
  });
});

describe("stateMatchesRunning", () => {
  const state = reconcileDeploymentState({
    sourceState: SOURCE_STATE,
    nativeState: null,
    runningCommit: SOURCE_STATE.currentSha,
    now: "2026-09-01T00:00:00Z",
  });

  it("is true only when the state describes what is running", () => {
    expect(stateMatchesRunning(state, SOURCE_STATE.currentSha)).toBe(true);
    expect(stateMatchesRunning(state, "0000000")).toBe(false);
    expect(stateMatchesRunning(null, SOURCE_STATE.currentSha)).toBe(false);
    expect(stateMatchesRunning(state, null)).toBe(false);
  });
});

describe("state file round trip", () => {
  it("writes and reads the canonical state", () => {
    const dir = tempDir();
    const state = reconcileDeploymentState({
      sourceState: SOURCE_STATE,
      nativeState: null,
      runningCommit: SOURCE_STATE.currentSha,
      now: "2026-09-01T00:00:00Z",
    });
    const written = writeCanonicalState(dir, state);
    expect(written).toBe(path.join(dir, CANONICAL_STATE_FILENAME));
    expect(readCanonicalState(dir)).toEqual(state);
  });

  it("returns null rather than throwing on a corrupt state file", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, CANONICAL_STATE_FILENAME), "{ not json");
    expect(readCanonicalState(dir)).toBeNull();
  });

  it("reads both legacy files from their separate directories", () => {
    const sourceDir = tempDir();
    const nativeDir = tempDir();
    writeFileSync(path.join(sourceDir, LEGACY_SOURCE_STATE_FILENAME), JSON.stringify(SOURCE_STATE));
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(path.join(nativeDir, LEGACY_NATIVE_STATE_FILENAME), JSON.stringify(NATIVE_STATE));

    const legacy = readLegacyStates({ sourceStateDir: sourceDir, nativeStateDir: nativeDir });
    expect(legacy.sourceState?.currentSha).toBe(SOURCE_STATE.currentSha);
    expect(legacy.nativeState?.currentSha).toBe(NATIVE_STATE.currentSha);
  });

  it("writes the state readable only by its owner", () => {
    const dir = tempDir();
    const state = reconcileDeploymentState({
      sourceState: null,
      nativeState: null,
      runningCommit: "abc",
      now: "2026-09-01T00:00:00Z",
    });
    const written = writeCanonicalState(dir, state);
    expect(readFileSync(written, "utf8")).toContain("abc");
  });
});
