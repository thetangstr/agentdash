// Client-initiated OTA: the decision layer.
//
// Everything in this module is pure. It performs no git, no filesystem, and no
// network access — callers hand it facts and it returns a verdict. That is
// deliberate: the same planner runs behind the read-only status endpoint the
// board renders AND behind the updater's pre-apply gate, and those two must
// never be able to disagree about whether an update may proceed. A shared
// function is the only way to guarantee that; two implementations of "is this
// safe" is how a UI ends up offering a button the updater then refuses.
//
// The bias throughout is toward refusing. An unreadable migration inventory, a
// missing release directory, or an approval that no longer matches the release
// all resolve to "cannot apply" rather than to a hopeful default.

import {
  type OtaApproval,
  type OtaChannel,
  type OtaCompatibility,
  type OtaCompatibilityVerdict,
  type OtaDeploymentMode,
  type OtaDiffSummary,
  type OtaInstalledRelease,
  type OtaMigrationSummary,
  type OtaRelease,
  type OtaRollbackPlan,
  type OtaUpdateStatus,
} from "@paperclipai/shared";

/** Release tags are date-versioned: `v2026.827.2`. */
const RELEASE_TAG_PATTERN = /^v\d{4}\.\d{3,4}\.\d+$/;

/** Commit subjects shown to the approver before the list is cut short. */
export const MAX_COMMIT_SUBJECTS = 20;

export function isReleaseTag(tag: string): boolean {
  return RELEASE_TAG_PATTERN.test(tag);
}

/**
 * Display version for a tag. Strips a single leading `v` and nothing else — the
 * tag is the identity, this is only how it is written on screen.
 */
export function versionFromTag(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/**
 * Is this the authoritative release source?
 *
 * Phase 0 accepts exactly one: a release tag on `origin/main`. The MK feature
 * branch, an arbitrary SHA, and a tag on any other branch are all refused. This
 * is the guard that stops "deploy whatever the working tree is on" — the
 * failure this whole phase exists to remove.
 */
export function isAuthoritativeReleaseSource(input: {
  remote: string;
  branch: string;
  tag: string | null;
  commitOnBranch: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (input.remote !== "origin") {
    return { ok: false, reason: `Release source must be the 'origin' remote, got '${input.remote}'.` };
  }
  if (input.branch !== "main") {
    return { ok: false, reason: `Release source must be the 'main' branch, got '${input.branch}'.` };
  }
  if (!input.tag) {
    return { ok: false, reason: "Release source must be a release tag; a bare commit is not a release." };
  }
  if (!isReleaseTag(input.tag)) {
    return { ok: false, reason: `'${input.tag}' is not a release tag (expected vYYYY.MDD.N).` };
  }
  if (!input.commitOnBranch) {
    return { ok: false, reason: `Tag '${input.tag}' does not point at a commit on origin/main.` };
  }
  return { ok: true };
}

/**
 * Compare the migrations a release carries against those already applied.
 *
 * `appliedMigrationIds` comes from the live database and `releaseMigrations`
 * from the candidate checkout. Passing null for the applied set means "could
 * not read it", which is materially different from "read it and it was empty" —
 * the first is `unknown` and blocks, the second is `compatible`.
 */
export function assessCompatibility(input: {
  appliedMigrationIds: string[] | null;
  releaseMigrations: OtaMigrationSummary[] | null;
}): OtaCompatibility {
  if (input.appliedMigrationIds === null || input.releaseMigrations === null) {
    return {
      verdict: "unknown",
      pendingMigrations: [],
      irreversibleMigrations: [],
      reasons: [
        "The migration inventory could not be read, so the effect on the database is unknown. Refusing rather than guessing.",
      ],
    };
  }

  const applied = new Set(input.appliedMigrationIds);
  const pending = input.releaseMigrations.filter((migration) => !applied.has(migration.id));

  if (pending.length === 0) {
    return {
      verdict: "compatible",
      pendingMigrations: [],
      irreversibleMigrations: [],
      reasons: ["No pending migrations. Rolling back is a checkout and nothing else."],
    };
  }

  // `reversible === null` is unclassified, and unclassified is not safe. It is
  // grouped with the known-irreversible so the approver is told the truth about
  // what a rollback would cost.
  const irreversible = pending.filter((migration) => migration.reversible !== true);

  if (irreversible.length > 0) {
    return {
      verdict: "forward_only",
      pendingMigrations: pending,
      irreversibleMigrations: irreversible,
      reasons: [
        `${irreversible.length} of ${pending.length} pending migration(s) cannot be reversed by a down-migration.`,
        "Rolling back after this update requires restoring the pre-update backup, which discards data written after the update.",
      ],
    };
  }

  return {
    verdict: "needs_migration",
    pendingMigrations: pending,
    irreversibleMigrations: [],
    reasons: [
      `${pending.length} forward migration(s) would run, all reversible.`,
    ],
  };
}

/**
 * Condense a range into something a person can read in a dialog. Counts and
 * subjects only — never a patch.
 */
export function summarizeDiff(input: {
  commitSubjects: string[];
  filesChanged: number;
  insertions: number;
  deletions: number;
  migrationsAdded: string[];
  maxSubjects?: number;
}): OtaDiffSummary {
  const max = input.maxSubjects ?? MAX_COMMIT_SUBJECTS;
  const truncated = input.commitSubjects.length > max;
  return {
    commitCount: input.commitSubjects.length,
    filesChanged: input.filesChanged,
    insertions: input.insertions,
    deletions: input.deletions,
    commitSubjects: truncated ? input.commitSubjects.slice(0, max) : [...input.commitSubjects],
    truncated,
    migrationsAdded: [...input.migrationsAdded],
  };
}

/**
 * What getting back would involve, computed before the apply.
 *
 * Note the asymmetry this encodes: code always rolls back, data sometimes
 * cannot. `codeOnly` is true only when no migration would run at all.
 */
export function buildRollbackPlan(input: {
  installed: OtaInstalledRelease;
  compatibility: OtaCompatibility;
  backupPath?: string | null;
}): OtaRollbackPlan {
  const codeOnly = input.compatibility.verdict === "compatible";
  const requiresRestore = input.compatibility.verdict === "forward_only";

  const steps: string[] = [];
  if (input.installed.releaseDir) {
    steps.push(`Point 'current' back at ${input.installed.releaseDir}.`);
  } else {
    steps.push(
      `Re-materialize release ${input.installed.tag ?? input.installed.commit} into an immutable directory and point 'current' at it.`,
    );
  }
  steps.push("Restart the service and wait for /api/health to report ok.");

  if (requiresRestore) {
    steps.push(
      input.backupPath
        ? `Restore the database from ${input.backupPath}.`
        : "Restore the database from the pre-update backup recorded in the receipt.",
    );
    steps.push("Accept that data written after the update is lost, or reconcile it by hand before restoring.");
  } else if (input.compatibility.verdict === "needs_migration") {
    steps.push("Run the down-migrations for the migrations this update applied.");
  }

  return {
    targetCommit: input.installed.commit || null,
    targetTag: input.installed.tag,
    targetReleaseDir: input.installed.releaseDir,
    codeOnly,
    requiresDatabaseRestore: requiresRestore,
    dataLossWindow: requiresRestore ? "Everything written between the update and the rollback." : null,
    steps,
  };
}

/**
 * Does this approval authorize this exact release, right now?
 *
 * Bound to the commit, and to the verdict that was shown when the human said
 * yes. If either has moved, the approval is stale — someone approved a
 * different thing than the one about to be applied.
 */
export function approvalAuthorizes(input: {
  approval: OtaApproval | null;
  release: OtaRelease;
  currentVerdict: OtaCompatibilityVerdict;
}): { ok: true } | { ok: false; reason: string } {
  const { approval, release } = input;
  if (!approval) return { ok: false, reason: "No approval on record for this release." };
  if (approval.status !== "approved") {
    return { ok: false, reason: `Approval is '${approval.status}', not 'approved'.` };
  }
  if (approval.commit !== release.commit) {
    return {
      ok: false,
      reason: "The approval is for a different commit than the release now offered. Re-approve the current release.",
    };
  }
  if (approval.approvedVerdict && approval.approvedVerdict !== input.currentVerdict) {
    return {
      ok: false,
      reason: `Compatibility changed since approval ('${approval.approvedVerdict}' then, '${input.currentVerdict}' now). Re-approve.`,
    };
  }
  return { ok: true };
}

/**
 * Assemble the read-only status the board renders and the updater gates on.
 *
 * `canApply` is computed here, once, and every false carries a reason. The
 * updater is expected to call this and refuse on `canApply === false` rather
 * than re-deriving the rules.
 */
export function buildUpdateStatus(input: {
  mode: OtaDeploymentMode;
  channel: OtaChannel;
  servingFromReleaseDir: boolean;
  installed: OtaInstalledRelease;
  available: OtaRelease | null;
  compatibility: OtaCompatibility;
  diff: OtaDiffSummary | null;
  approval: OtaApproval | null;
  backupPath?: string | null;
  checkedAt: string;
}): OtaUpdateStatus {
  const upToDate = !input.available || input.available.commit === input.installed.commit;
  const rollback = buildRollbackPlan({
    installed: input.installed,
    compatibility: input.compatibility,
    backupPath: input.backupPath ?? null,
  });

  const blockedReasons: string[] = [];

  // Phase 0's central guarantee. A process started from a developer checkout
  // cannot be updated safely, because swapping the release directory would not
  // change what it serves — and a `git checkout` under a running server is the
  // exact failure this work removes.
  if (!input.servingFromReleaseDir) {
    blockedReasons.push(
      "This instance is not running from an immutable release directory, so an update cannot be applied safely. Complete the release-layout cutover first.",
    );
  }
  if (upToDate) {
    blockedReasons.push("Already on the newest release.");
  }
  if (input.compatibility.verdict === "unknown") {
    blockedReasons.push(...input.compatibility.reasons);
  }

  if (input.available) {
    const authorized = approvalAuthorizes({
      approval: input.approval,
      release: input.available,
      currentVerdict: input.compatibility.verdict,
    });
    if (!authorized.ok) blockedReasons.push(authorized.reason);
  }

  return {
    mode: input.mode,
    channel: input.channel,
    servingFromReleaseDir: input.servingFromReleaseDir,
    installed: input.installed,
    available: input.available,
    upToDate,
    compatibility: input.compatibility,
    diff: input.diff,
    rollback,
    approval: input.approval,
    canApply: blockedReasons.length === 0,
    blockedReasons,
    checkedAt: input.checkedAt,
  };
}
