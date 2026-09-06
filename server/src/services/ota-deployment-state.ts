// Client-initiated OTA: one canonical deployment state.
//
// This host grew two state files that disagree. `~/.agentdash/deployments/
// source-state.json` was written by the source updater and `~/.agentdash-native/
// deployments/state.json` by the native launchd deploy, and on the MK Mini they
// recorded different commits — neither of which matched the commit the server
// was actually running. Three answers to "what version is this?" is the same as
// none.
//
// Phase 0 collapses them. The rule that matters is at the bottom of
// `reconcileDeploymentState`: when the running commit is known and disagrees
// with every recorded state, the RUNNING commit wins and the disagreement is
// recorded rather than smoothed over. A state file that reports a deploy which
// is not what is serving is worse than an empty one, because it is trusted.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  OTA_STATE_SCHEMA_VERSION,
  type OtaChannel,
  type OtaDeploymentMode,
  type OtaDeploymentState,
  type OtaInstalledRelease,
  type OtaReceipt,
} from "@paperclipai/shared";

export const CANONICAL_STATE_FILENAME = "deployment-state.json";
export const LEGACY_SOURCE_STATE_FILENAME = "source-state.json";
export const LEGACY_NATIVE_STATE_FILENAME = "state.json";

/** Either historical state file, loosely typed because they were untyped. */
export interface LegacyDeploymentState {
  currentSha?: string | null;
  previousSha?: string | null;
  updatedAt?: string | null;
  lastReceiptPath?: string | null;
  mode?: string | null;
  [key: string]: unknown;
}

function installedFrom(commit: string | null | undefined): OtaInstalledRelease {
  return {
    tag: null,
    version: null,
    commit: commit ?? "",
    channel: null,
    releaseDir: null,
    installedAt: null,
  };
}

function parseTime(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Build one state from the legacy pair plus ground truth.
 *
 * Precedence, in order:
 *   1. `runningCommit` — what the process is actually serving. Always wins for
 *      `current.commit`, because that is the only fact here that is observed
 *      rather than recorded.
 *   2. The newer of the two legacy files, for `previous` and receipt path.
 *
 * When the running commit matches neither legacy record, the state still
 * reports the running commit and `reconciledFrom` names both sources so the
 * discrepancy is visible in the file itself.
 */
export function reconcileDeploymentState(input: {
  sourceState: LegacyDeploymentState | null;
  nativeState: LegacyDeploymentState | null;
  runningCommit: string | null;
  runningReleaseDir?: string | null;
  mode?: OtaDeploymentMode;
  channel?: OtaChannel;
  now: string;
}): OtaDeploymentState {
  const candidates = [
    { name: LEGACY_SOURCE_STATE_FILENAME, state: input.sourceState },
    { name: LEGACY_NATIVE_STATE_FILENAME, state: input.nativeState },
  ].filter((entry): entry is { name: string; state: LegacyDeploymentState } => entry.state !== null);

  const newest = candidates
    .slice()
    .sort((a, b) => parseTime(b.state.updatedAt) - parseTime(a.state.updatedAt))[0];

  const recordedCurrent = newest?.state.currentSha ?? null;
  const effectiveCommit = input.runningCommit ?? recordedCurrent ?? "";

  // If what is running is not what was recorded, the previously recorded
  // "current" is the closest thing to a previous deployment we have.
  const previousCommit =
    input.runningCommit && recordedCurrent && input.runningCommit !== recordedCurrent
      ? recordedCurrent
      : (newest?.state.previousSha ?? null);

  const current = installedFrom(effectiveCommit);
  current.releaseDir = input.runningReleaseDir ?? null;

  return {
    schemaVersion: OTA_STATE_SCHEMA_VERSION,
    mode: input.mode ?? "source-release",
    channel: input.channel ?? "stable",
    current,
    previous: previousCommit ? installedFrom(previousCommit) : null,
    updatedAt: input.now,
    lastReceiptPath: newest?.state.lastReceiptPath ?? null,
    reconciledFrom: candidates.length > 0 ? candidates.map((entry) => entry.name) : null,
  };
}

/**
 * True when a recorded state describes the commit that is actually serving.
 *
 * The updater calls this before doing anything: acting on a state that has
 * drifted from reality is how a "rollback to previous" restores a commit nobody
 * was running.
 */
export function stateMatchesRunning(
  state: OtaDeploymentState | null,
  runningCommit: string | null,
): boolean {
  if (!state || !runningCommit) return false;
  return state.current.commit === runningCommit;
}

function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    // A corrupt state file is treated as absent. Reconciliation can rebuild
    // from the running commit; throwing here would make the instance
    // un-inspectable exactly when someone needs to inspect it.
    return null;
  }
}

export function readCanonicalState(stateDir: string): OtaDeploymentState | null {
  return readJson<OtaDeploymentState>(path.join(stateDir, CANONICAL_STATE_FILENAME));
}

export function readLegacyStates(input: { sourceStateDir: string; nativeStateDir?: string | null }): {
  sourceState: LegacyDeploymentState | null;
  nativeState: LegacyDeploymentState | null;
} {
  return {
    sourceState: readJson<LegacyDeploymentState>(
      path.join(input.sourceStateDir, LEGACY_SOURCE_STATE_FILENAME),
    ),
    nativeState: input.nativeStateDir
      ? readJson<LegacyDeploymentState>(path.join(input.nativeStateDir, LEGACY_NATIVE_STATE_FILENAME))
      : null,
  };
}

/** Mode 600: the state names paths on the host and does not need to be world-readable. */
export function writeCanonicalState(stateDir: string, state: OtaDeploymentState): string {
  mkdirSync(stateDir, { recursive: true });
  const target = path.join(stateDir, CANONICAL_STATE_FILENAME);
  writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return target;
}

export function writeReceipt(receiptDir: string, receipt: OtaReceipt): string {
  mkdirSync(receiptDir, { recursive: true });
  const stamp = receipt.finishedAt.replace(/[:.]/g, "-");
  const target = path.join(receiptDir, `${stamp}-ota-${receipt.outcome}.json`);
  writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return target;
}
