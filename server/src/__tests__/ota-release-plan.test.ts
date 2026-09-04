// The OTA decision layer, tested at its edges.
//
// These cases are chosen around the failures that actually happened on the
// first design-partner host rather than around the happy path: a server serving
// from a developer checkout, a state file that disagreed with the running
// commit, and an update mechanism that would have "upgraded" a machine by
// reverting it. Each of those is a `canApply === false` here.

import { describe, expect, it } from "vitest";
import {
  approvalAuthorizes,
  assessCompatibility,
  buildRollbackPlan,
  buildUpdateStatus,
  isAuthoritativeReleaseSource,
  isReleaseTag,
  summarizeDiff,
  versionFromTag,
  MAX_COMMIT_SUBJECTS,
} from "../services/ota-release-plan.js";
import type { OtaApproval, OtaInstalledRelease, OtaRelease } from "@paperclipai/shared";

const RELEASE: OtaRelease = {
  tag: "v2026.827.2",
  version: "2026.827.2",
  commit: "4637abd727dfe98b4865bec30a39cd772c484749",
  channel: "stable",
  publishedAt: "2026-08-27T11:27:59Z",
  notes: "Fixes the thing.",
  url: "https://github.com/example/repo/releases/tag/v2026.827.2",
};

const INSTALLED_FROM_RELEASE: OtaInstalledRelease = {
  tag: "v2026.827.1",
  version: "2026.827.1",
  commit: "e912d614c8f81498c842b154182bb764a98d0164",
  channel: "stable",
  releaseDir: "/opt/releases/v2026.827.1-e912d614",
  installedAt: "2026-08-27T09:00:00Z",
};

function approvalFor(release: OtaRelease, overrides: Partial<OtaApproval> = {}): OtaApproval {
  return {
    id: "approval-1",
    tag: release.tag,
    commit: release.commit,
    channel: "stable",
    status: "approved",
    requestedByUserId: "user-1",
    requestedAt: "2026-08-27T12:00:00Z",
    decidedByUserId: "user-1",
    decidedAt: "2026-08-27T12:01:00Z",
    approvedVerdict: "compatible",
    ...overrides,
  };
}

describe("release identity", () => {
  it("accepts date-versioned release tags and rejects anything else", () => {
    expect(isReleaseTag("v2026.827.2")).toBe(true);
    expect(isReleaseTag("v2026.1231.10")).toBe(true);
    expect(isReleaseTag("2026.827.2")).toBe(false);
    expect(isReleaseTag("v1.2.3")).toBe(false);
    expect(isReleaseTag("main")).toBe(false);
    expect(isReleaseTag("4637abd")).toBe(false);
  });

  it("strips only the leading v", () => {
    expect(versionFromTag("v2026.827.2")).toBe("2026.827.2");
    expect(versionFromTag("2026.827.2")).toBe("2026.827.2");
  });
});

describe("isAuthoritativeReleaseSource", () => {
  const base = { remote: "origin", branch: "main", tag: "v2026.827.2", commitOnBranch: true };

  it("accepts a release tag on origin/main", () => {
    expect(isAuthoritativeReleaseSource(base)).toEqual({ ok: true });
  });

  // The MK host was serving a feature branch. An updater that accepted it would
  // have made that branch a release.
  it("refuses a feature branch", () => {
    const result = isAuthoritativeReleaseSource({ ...base, branch: "fix/inbox-scope-and-steward-guard" });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining("'main'") });
  });

  it("refuses a bare commit with no tag", () => {
    const result = isAuthoritativeReleaseSource({ ...base, tag: null });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining("not a release") });
  });

  it("refuses a non-release tag", () => {
    expect(isAuthoritativeReleaseSource({ ...base, tag: "nightly" }).ok).toBe(false);
  });

  it("refuses a tag that is not on main", () => {
    expect(isAuthoritativeReleaseSource({ ...base, commitOnBranch: false }).ok).toBe(false);
  });

  it("refuses a remote other than origin", () => {
    expect(isAuthoritativeReleaseSource({ ...base, remote: "upstream" }).ok).toBe(false);
  });
});

describe("assessCompatibility", () => {
  it("is compatible when the release adds no migrations", () => {
    const result = assessCompatibility({
      appliedMigrationIds: ["0001_a", "0002_b"],
      releaseMigrations: [
        { id: "0001_a", name: "0001_a", reversible: false },
        { id: "0002_b", name: "0002_b", reversible: false },
      ],
    });
    expect(result.verdict).toBe("compatible");
    expect(result.pendingMigrations).toHaveLength(0);
  });

  // Drizzle has no down-migrations, so this is the common real case.
  it("is forward_only when a pending migration cannot be reversed", () => {
    const result = assessCompatibility({
      appliedMigrationIds: ["0001_a"],
      releaseMigrations: [
        { id: "0001_a", name: "0001_a", reversible: false },
        { id: "0002_b", name: "0002_b", reversible: false },
      ],
    });
    expect(result.verdict).toBe("forward_only");
    expect(result.pendingMigrations.map((m) => m.id)).toEqual(["0002_b"]);
    expect(result.irreversibleMigrations).toHaveLength(1);
  });

  it("treats an unclassified migration as irreversible rather than safe", () => {
    const result = assessCompatibility({
      appliedMigrationIds: [],
      releaseMigrations: [{ id: "0001_a", name: "0001_a", reversible: null }],
    });
    expect(result.verdict).toBe("forward_only");
  });

  it("is needs_migration only when every pending migration is reversible", () => {
    const result = assessCompatibility({
      appliedMigrationIds: [],
      releaseMigrations: [{ id: "0001_a", name: "0001_a", reversible: true }],
    });
    expect(result.verdict).toBe("needs_migration");
    expect(result.irreversibleMigrations).toHaveLength(0);
  });

  // "Could not read" must never render as "nothing pending".
  it("is unknown when either side is unreadable", () => {
    expect(assessCompatibility({ appliedMigrationIds: null, releaseMigrations: [] }).verdict).toBe("unknown");
    expect(assessCompatibility({ appliedMigrationIds: [], releaseMigrations: null }).verdict).toBe("unknown");
  });
});

describe("summarizeDiff", () => {
  it("truncates the subject list and says so", () => {
    const subjects = Array.from({ length: MAX_COMMIT_SUBJECTS + 5 }, (_, i) => `commit ${i}`);
    const diff = summarizeDiff({
      commitSubjects: subjects,
      filesChanged: 12,
      insertions: 300,
      deletions: 40,
      migrationsAdded: ["0123_x"],
    });
    expect(diff.commitCount).toBe(MAX_COMMIT_SUBJECTS + 5);
    expect(diff.commitSubjects).toHaveLength(MAX_COMMIT_SUBJECTS);
    expect(diff.truncated).toBe(true);
    expect(diff.migrationsAdded).toEqual(["0123_x"]);
  });

  it("does not mark a short list as truncated", () => {
    const diff = summarizeDiff({
      commitSubjects: ["one", "two"],
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
      migrationsAdded: [],
    });
    expect(diff.truncated).toBe(false);
  });
});

describe("buildRollbackPlan", () => {
  it("is code-only when nothing would migrate", () => {
    const plan = buildRollbackPlan({
      installed: INSTALLED_FROM_RELEASE,
      compatibility: assessCompatibility({ appliedMigrationIds: [], releaseMigrations: [] }),
    });
    expect(plan.codeOnly).toBe(true);
    expect(plan.requiresDatabaseRestore).toBe(false);
    expect(plan.dataLossWindow).toBeNull();
    expect(plan.targetReleaseDir).toBe(INSTALLED_FROM_RELEASE.releaseDir);
  });

  it("requires a restore and names the data-loss window when forward_only", () => {
    const plan = buildRollbackPlan({
      installed: INSTALLED_FROM_RELEASE,
      compatibility: assessCompatibility({
        appliedMigrationIds: [],
        releaseMigrations: [{ id: "0002_b", name: "0002_b", reversible: false }],
      }),
      backupPath: "/backups/predeploy.sql.gz",
    });
    expect(plan.requiresDatabaseRestore).toBe(true);
    expect(plan.dataLossWindow).not.toBeNull();
    expect(plan.steps.join(" ")).toContain("/backups/predeploy.sql.gz");
  });

  it("explains how to get back when the previous release directory is gone", () => {
    const plan = buildRollbackPlan({
      installed: { ...INSTALLED_FROM_RELEASE, releaseDir: null },
      compatibility: assessCompatibility({ appliedMigrationIds: [], releaseMigrations: [] }),
    });
    expect(plan.steps[0]).toContain("Re-materialize");
  });
});

describe("approvalAuthorizes", () => {
  it("accepts an approved record for the same commit and verdict", () => {
    expect(
      approvalAuthorizes({ approval: approvalFor(RELEASE), release: RELEASE, currentVerdict: "compatible" }),
    ).toEqual({ ok: true });
  });

  it("refuses when there is no approval", () => {
    expect(approvalAuthorizes({ approval: null, release: RELEASE, currentVerdict: "compatible" }).ok).toBe(false);
  });

  it("refuses a pending approval", () => {
    const result = approvalAuthorizes({
      approval: approvalFor(RELEASE, { status: "pending" }),
      release: RELEASE,
      currentVerdict: "compatible",
    });
    expect(result.ok).toBe(false);
  });

  // A moved tag must not carry an old consent forward.
  it("refuses when the approved commit is not the offered commit", () => {
    const result = approvalAuthorizes({
      approval: approvalFor(RELEASE, { commit: "0000000000000000000000000000000000000000" }),
      release: RELEASE,
      currentVerdict: "compatible",
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining("different commit") });
  });

  // Consent was given for a set of facts; if the facts moved, ask again.
  it("refuses when compatibility drifted after approval", () => {
    const result = approvalAuthorizes({
      approval: approvalFor(RELEASE, { approvedVerdict: "compatible" }),
      release: RELEASE,
      currentVerdict: "forward_only",
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining("Compatibility changed") });
  });
});

describe("buildUpdateStatus", () => {
  const compatible = assessCompatibility({ appliedMigrationIds: [], releaseMigrations: [] });

  function status(overrides: Partial<Parameters<typeof buildUpdateStatus>[0]> = {}) {
    return buildUpdateStatus({
      mode: "source-release",
      channel: "stable",
      servingFromReleaseDir: true,
      installed: INSTALLED_FROM_RELEASE,
      available: RELEASE,
      compatibility: compatible,
      diff: null,
      approval: approvalFor(RELEASE),
      checkedAt: "2026-08-27T12:05:00Z",
      ...overrides,
    });
  }

  it("allows apply when everything lines up", () => {
    const result = status();
    expect(result.canApply).toBe(true);
    expect(result.blockedReasons).toEqual([]);
    expect(result.upToDate).toBe(false);
  });

  // The central Phase 0 guarantee.
  it("refuses when the process is not serving from a release directory", () => {
    const result = status({ servingFromReleaseDir: false });
    expect(result.canApply).toBe(false);
    expect(result.blockedReasons.join(" ")).toContain("immutable release directory");
  });

  it("refuses without an approval", () => {
    const result = status({ approval: null });
    expect(result.canApply).toBe(false);
    expect(result.blockedReasons.join(" ")).toContain("No approval");
  });

  it("refuses when compatibility is unknown", () => {
    const result = status({
      compatibility: assessCompatibility({ appliedMigrationIds: null, releaseMigrations: null }),
      approval: approvalFor(RELEASE, { approvedVerdict: "unknown" }),
    });
    expect(result.canApply).toBe(false);
    expect(result.blockedReasons.join(" ")).toContain("could not be read");
  });

  it("reports up to date and refuses when installed already matches", () => {
    const result = status({
      installed: { ...INSTALLED_FROM_RELEASE, commit: RELEASE.commit },
      approval: null,
    });
    expect(result.upToDate).toBe(true);
    expect(result.canApply).toBe(false);
  });

  it("always carries a rollback plan, even when it cannot apply", () => {
    const result = status({ servingFromReleaseDir: false });
    expect(result.rollback.steps.length).toBeGreaterThan(0);
  });
});
