// Client-initiated over-the-air updates: the shared contract.
//
// Phase 0 establishes identity and safety, not automation. Nothing here applies
// a release. The type that matters most is `OtaUpdateStatus`: it is the whole
// read-only surface the board renders before a human decides, and it is
// deliberately shaped so that "I do not know" is representable everywhere a
// confident answer would be a lie.
//
// Three invariants hold across this module:
//
//   1. A release is identified by a signed-able tag AND its commit, never by a
//      bare SHA. "Deploy whatever main points at" is how a working tree ends up
//      in production; a release has a name a human can say out loud.
//   2. Compatibility is a verdict about the DATABASE, not about the code. Code
//      rolls back cleanly by definition — it is a checkout. Data does not.
//   3. Approval is a record, not a flag. Who approved which exact commit, and
//      when, has to survive a rollback so the next person can read what
//      happened.

export const OTA_STATE_SCHEMA_VERSION = 2;

/**
 * Release channels. Only `stable` exists in Phase 0 and it means "a release tag
 * on the authoritative main branch". The enum exists so that adding a `beta`
 * channel later is an additive change rather than a reinterpretation of a
 * boolean.
 */
export const OTA_CHANNELS = ["stable"] as const;
export type OtaChannel = (typeof OTA_CHANNELS)[number];

/** Deployment shapes this contract covers. */
export const OTA_DEPLOYMENT_MODES = ["source-release", "image"] as const;
export type OtaDeploymentMode = (typeof OTA_DEPLOYMENT_MODES)[number];

/**
 * A candidate release, as published upstream.
 *
 * `notes` is the human-readable body from the GitHub Release. It is rendered to
 * the person approving, so it is carried verbatim rather than summarized.
 */
export interface OtaRelease {
  /** Release tag, e.g. `v2026.827.2`. The stable identity of the release. */
  tag: string;
  /** Display version, normally the tag without its leading `v`. */
  version: string;
  /** Full 40-character commit the tag resolves to. */
  commit: string;
  channel: OtaChannel;
  /** ISO 8601. Null when upstream did not report one. */
  publishedAt: string | null;
  /** Verbatim release notes. Empty string when the release has no body. */
  notes: string;
  /** Link to the release, for the "read the full notes" affordance. */
  url: string | null;
}

/**
 * What is deployed right now.
 *
 * `releaseDir` is the immutable directory the running process was started from.
 * Its presence is what distinguishes a real release deployment from a developer
 * checkout that happens to be on the right commit — the whole point of Phase 0.
 */
export interface OtaInstalledRelease {
  tag: string | null;
  version: string | null;
  commit: string;
  channel: OtaChannel | null;
  releaseDir: string | null;
  installedAt: string | null;
}

export const OTA_COMPATIBILITY_VERDICTS = [
  "compatible",
  "needs_migration",
  "forward_only",
  "unknown",
] as const;
export type OtaCompatibilityVerdict = (typeof OTA_COMPATIBILITY_VERDICTS)[number];

/**
 * One migration the candidate release would apply.
 *
 * `reversible` is tri-state on purpose. A migration we have not classified is
 * `null`, and `null` must never be rendered as "safe" — an unclassified
 * migration is exactly the one that strands a rollback.
 */
export interface OtaMigrationSummary {
  id: string;
  name: string;
  reversible: boolean | null;
}

/**
 * The database compatibility verdict for a candidate release.
 *
 * Verdicts:
 *   - `compatible`     — no pending migrations; rollback is a pure checkout.
 *   - `needs_migration`— forward migrations exist and all are reversible or
 *                        covered by a restore.
 *   - `forward_only`   — at least one pending migration cannot be reversed, so
 *                        rolling back requires restoring the pre-update backup
 *                        and accepting the data written since.
 *   - `unknown`        — the migration inventory could not be read. Treated as
 *                        blocking, because guessing here costs a database.
 */
export interface OtaCompatibility {
  verdict: OtaCompatibilityVerdict;
  pendingMigrations: OtaMigrationSummary[];
  /** Subset of `pendingMigrations` known NOT to be reversible. */
  irreversibleMigrations: OtaMigrationSummary[];
  /** Human-readable reasons, rendered to the approver verbatim. */
  reasons: string[];
}

/**
 * Enough of a diff for a human to decide, without shipping a patch to a
 * browser. Counts plus the commit subjects — not the code.
 */
export interface OtaDiffSummary {
  commitCount: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** Commit subjects, newest first, already truncated for display. */
  commitSubjects: string[];
  /** True when the list above was cut short. */
  truncated: boolean;
  /** Migration files added between the installed commit and the candidate. */
  migrationsAdded: string[];
}

/**
 * How this instance would get back, if the update goes wrong.
 *
 * This is computed BEFORE the apply and shown to the approver, because a
 * rollback plan discovered after a failure is not a plan.
 */
export interface OtaRollbackPlan {
  /** Commit the instance would return to. */
  targetCommit: string | null;
  targetTag: string | null;
  /** Immutable directory that would be restored to `current`. */
  targetReleaseDir: string | null;
  /** True when code alone is enough — no migration would have run. */
  codeOnly: boolean;
  /** True when returning also requires restoring the pre-update backup. */
  requiresDatabaseRestore: boolean;
  /**
   * Data written after the update would be lost by that restore. Null when no
   * restore is needed.
   */
  dataLossWindow: string | null;
  /** Plain-language steps, rendered to the approver. */
  steps: string[];
}

export const OTA_APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired"] as const;
export type OtaApprovalStatus = (typeof OTA_APPROVAL_STATUSES)[number];

/**
 * A human's decision about one specific release.
 *
 * Bound to `commit`, not just `tag`: a tag can be moved upstream, and an
 * approval that survives a retag is not an approval of what actually ships.
 */
export interface OtaApproval {
  id: string;
  tag: string;
  commit: string;
  channel: OtaChannel;
  status: OtaApprovalStatus;
  requestedByUserId: string;
  requestedAt: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  /** Compatibility verdict AT APPROVAL TIME, so drift is detectable later. */
  approvedVerdict: OtaCompatibilityVerdict | null;
}

/**
 * The complete read-only surface behind the Update button.
 *
 * `canApply` is the single field the UI should gate on, and `blockedReasons`
 * explains a false. Keeping the decision here rather than in the client means
 * the board and the updater cannot disagree about whether an update is allowed.
 */
export interface OtaUpdateStatus {
  mode: OtaDeploymentMode;
  channel: OtaChannel;
  /** True when the running process was launched from an immutable release. */
  servingFromReleaseDir: boolean;
  installed: OtaInstalledRelease;
  /** Null when the instance is already on the newest release. */
  available: OtaRelease | null;
  upToDate: boolean;
  compatibility: OtaCompatibility;
  diff: OtaDiffSummary | null;
  rollback: OtaRollbackPlan;
  approval: OtaApproval | null;
  canApply: boolean;
  blockedReasons: string[];
  checkedAt: string;
}

/**
 * The one canonical deployment state file.
 *
 * Phase 0 collapses the two historical state files into this. `schemaVersion`
 * is what lets a reader tell a reconciled state from a legacy one rather than
 * guessing from which keys are present.
 */
export interface OtaDeploymentState {
  schemaVersion: typeof OTA_STATE_SCHEMA_VERSION;
  mode: OtaDeploymentMode;
  channel: OtaChannel;
  current: OtaInstalledRelease;
  previous: OtaInstalledRelease | null;
  updatedAt: string;
  lastReceiptPath: string | null;
  /**
   * Provenance of a reconciled state: which legacy files it was built from.
   * Null for states written natively at this schema version.
   */
  reconciledFrom: string[] | null;
}

export const OTA_RECEIPT_OUTCOMES = ["applied", "rolled_back", "failed", "noop"] as const;
export type OtaReceiptOutcome = (typeof OTA_RECEIPT_OUTCOMES)[number];

/** One recorded check performed during an apply. */
export interface OtaReceiptCheck {
  name: string;
  status: "passed" | "failed" | "skipped";
  detail?: string;
  completedAt: string;
}

/**
 * The record of one apply attempt. This is the artifact the UI renders as the
 * outcome, so it carries the approval that authorized it.
 */
export interface OtaReceipt {
  schemaVersion: typeof OTA_STATE_SCHEMA_VERSION;
  outcome: OtaReceiptOutcome;
  mode: OtaDeploymentMode;
  channel: OtaChannel;
  from: OtaInstalledRelease | null;
  to: OtaInstalledRelease | null;
  approvalId: string | null;
  approvedByUserId: string | null;
  backupPath: string | null;
  checks: OtaReceiptCheck[];
  startedAt: string;
  finishedAt: string;
  error: string | null;
}
