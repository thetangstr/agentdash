import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

/**
 * G1g, for the whole slice at once.
 *
 * Every function this pipeline exports, and the non-test file that calls it.
 * `buildApprovalKeyboard` shipped in this repository with nine passing tests and
 * no caller at all, which is why the assertion is on a real source file rather
 * than on the export existing.
 *
 * The service factories are listed alongside the functions on them that are the
 * actual entry points: a factory with a caller whose interesting method nobody
 * invokes is the same defect one level down.
 */
const CALLERS: Array<[string, string]> = [
  // Definition
  ["deliverableService", "server/src/routes/deliverables.ts"],
  ["deliverableRoutes", "server/src/app.ts"],
  // Runs
  ["deliverableRunService", "server/src/routes/deliverables.ts"],
  ["deliverableRunService", "server/src/index.ts"],
  ["runKeyFor", "server/src/services/deliverable-runs.ts"],
  ["sweepDueDeliverableRuns", "server/src/index.ts"],
  ["sweepCollectingRuns", "server/src/index.ts"],
  // Check
  ["deliverableCheckService", "server/src/routes/deliverables.ts"],
  ["deliverableCheckService", "server/src/index.ts"],
  ["computeDraftHash", "server/src/services/deliverable-checks.ts"],
  ["sweepAssembledRuns", "server/src/index.ts"],
  ["verifyDraftUnchanged", "server/src/services/deliverable-review.ts"],
  ["scoreDeliverable", "server/src/routes/deliverables.ts"],
  // Review, approval, corrections
  ["deliverableReviewService", "server/src/routes/deliverables.ts"],
  ["deliverableReviewService", "server/src/routes/approvals.ts"],
  ["deliverableReviewService", "server/src/services/deliverable-runs.ts"],
  ["advanceDeliverableApproval", "server/src/routes/approvals.ts"],
  ["failDeliverableApproval", "server/src/routes/approvals.ts"],
  ["recordCorrection", "server/src/routes/deliverables.ts"],
  ["reviewSurface", "server/src/routes/deliverables.ts"],
  ["isApprover", "server/src/routes/deliverables.ts"],
  ["activeCorrections", "server/src/services/deliverable-runs.ts"],
  // The derivation record
  ["deliverableRecordService", "server/src/routes/deliverables.ts"],
  ["factRecord", "server/src/routes/deliverables.ts"],
  ["latestShipped", "server/src/routes/deliverables.ts"],
  // MCP
  ["listResources", "packages/mcp-server/src/index.ts"],
  ["readAgentDashResource", "packages/mcp-server/src/index.ts"],
  ["RESOURCE_TEMPLATES", "packages/mcp-server/src/index.ts"],
];

describe("deliverable pipeline caller existence (G1g)", () => {
  it.each(CALLERS)("%s is called from %s", (name, file) => {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    expect(source.includes(`${name}(`) || source.includes(`${name}.`) || source.includes(`${name},`) || source.includes(`${name}.map(`),
      `${name} has no non-test caller in ${file}`).toBe(true);
  });

  it("names every function the pipeline's services export", () => {
    // A list that drifts is a list that stops meaning anything, so the exports
    // are read out of the sources rather than remembered.
    const exported = new Set<string>();
    for (const file of [
      "server/src/services/deliverables.ts",
      "server/src/services/deliverable-runs.ts",
      "server/src/services/deliverable-checks.ts",
      "server/src/services/deliverable-review.ts",
      "server/src/services/deliverable-record.ts",
      "packages/mcp-server/src/resources.ts",
    ]) {
      const source = readFileSync(path.join(repoRoot, file), "utf8");
      for (const match of source.matchAll(/^export (?:async )?function (\w+)/gm)) {
        exported.add(match[1]!);
      }
      for (const match of source.matchAll(/^export const ([A-Z_][A-Z0-9_]*) =/gm)) {
        exported.add(match[1]!);
      }
    }
    const covered = new Set(CALLERS.map(([name]) => name));
    const uncovered = Array.from(exported).filter((name) => !covered.has(name));
    expect(uncovered, "a new export was added with no caller assertion").toEqual([]);
  });
});
