// Client-initiated OTA: assembling the status the board renders.
//
// This is the I/O half of the planner. It reads files the updater has already
// written and hands the facts to `buildUpdateStatus`, which decides. Nothing
// here reaches the network or shells out to git, and that is a design
// constraint rather than an omission: the status endpoint is polled by a UI,
// and a request path that fetches from GitHub would make the board's
// responsiveness depend on network weather and hand an unauthenticated-ish
// surface a way to trigger outbound calls.
//
// The daily `--check` run is what refreshes `available-release.json`. So the
// status is "as of the last check", and `checkedAt` says so rather than
// implying it is live.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  type OtaApproval,
  type OtaDeploymentState,
  type OtaMigrationSummary,
  type OtaRelease,
  type OtaUpdateStatus,
} from "@paperclipai/shared";
import { assessCompatibility, buildUpdateStatus } from "./ota-release-plan.js";
import { readCanonicalState } from "./ota-deployment-state.js";

export const AVAILABLE_RELEASE_FILENAME = "available-release.json";
export const APPROVAL_FILENAME = "pending-approval.json";
export const MIGRATION_INVENTORY_FILENAME = "release-migrations.json";

export function defaultOtaStateDir(): string {
  return (
    process.env.AGENTDASH_OTA_STATE_DIR
    ?? path.join(os.homedir(), ".agentdash", "deployments")
  );
}

function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * What the last `--check` found upstream, plus the diff it measured.
 *
 * Written by the updater, never by the server — the server has no business
 * running git, and keeping the write on the updater side means the status
 * endpoint stays read-only in the strongest sense.
 */
export interface AvailableReleaseFile {
  release: OtaRelease | null;
  diff: OtaUpdateStatus["diff"];
  /** Migrations carried by the candidate release. Null when unreadable. */
  releaseMigrations: OtaMigrationSummary[] | null;
  checkedAt: string;
}

export interface OtaStatusSources {
  stateDir?: string;
  /** Migration ids already applied, from the live database. Null when unreadable. */
  appliedMigrationIds: string[] | null;
  /** Directory the running process was launched from, for the release-dir check. */
  runningReleaseDir?: string | null;
  now?: string;
}

/**
 * Assemble the full read-only status.
 *
 * Deliberately tolerant of missing files: a fresh instance that has never run a
 * check should render "unknown / cannot apply" rather than 500. Every absent
 * input becomes a blocked reason, which is the honest rendering.
 */
export function getOtaUpdateStatus(sources: OtaStatusSources): OtaUpdateStatus {
  const stateDir = sources.stateDir ?? defaultOtaStateDir();
  const now = sources.now ?? new Date().toISOString();

  const state: OtaDeploymentState | null = readCanonicalState(stateDir);
  const availableFile = readJson<AvailableReleaseFile>(path.join(stateDir, AVAILABLE_RELEASE_FILENAME));
  const approval = readJson<OtaApproval>(path.join(stateDir, APPROVAL_FILENAME));

  const installed = state?.current ?? {
    tag: null,
    version: null,
    commit: "",
    channel: null,
    releaseDir: null,
    installedAt: null,
  };

  // Serving from a release directory is a property of the RUNNING process, not
  // of the state file, so it is derived from where the process was launched.
  const runningReleaseDir = sources.runningReleaseDir ?? installed.releaseDir;
  const servingFromReleaseDir = Boolean(runningReleaseDir);

  const compatibility = assessCompatibility({
    appliedMigrationIds: sources.appliedMigrationIds,
    releaseMigrations: availableFile?.releaseMigrations ?? null,
  });

  return buildUpdateStatus({
    mode: state?.mode ?? "source-release",
    channel: state?.channel ?? "stable",
    servingFromReleaseDir,
    installed: { ...installed, releaseDir: runningReleaseDir ?? null },
    available: availableFile?.release ?? null,
    compatibility,
    diff: availableFile?.diff ?? null,
    approval,
    checkedAt: availableFile?.checkedAt ?? now,
  });
}
