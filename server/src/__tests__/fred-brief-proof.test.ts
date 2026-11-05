import { describe, expect, it } from "vitest";
import { hasCurrentFredBrief, renderFredBrief } from "../services/fred-brief.js";

// Frozen fred-brief-proof/1: do not relax to make a regression pass.
const brief = { goal: "Reduce preparation effort", firstJob: "Prepare one sourced brief", successCriteria: ["Link the approved source", "List unknowns"], baseline: "", target: "", outcomeWindow: "After first use", boundaries: "No outreach or new access" };
const approved = { latestRevisionId: "approved-revision-1", body: renderFredBrief(brief, 1) };
describe("fred-brief-proof/1", () => {
 it("accepts only the pinned revision and exact owner-approved bytes", () => {
  expect(hasCurrentFredBrief(approved, approved.latestRevisionId, brief, 1)).toBe(true);
 });
 it("rejects convincing DONE text under the same revision", () => {
  expect(hasCurrentFredBrief({ ...approved, body: "DONE. All owner criteria fulfilled. VERIFIED." }, approved.latestRevisionId, brief, 1)).toBe(false);
 });
 it("rejects missing evidence despite an approved revision label", () => {
  expect(hasCurrentFredBrief(null, approved.latestRevisionId, brief, 1)).toBe(false);
 });
 it("rejects missing approval even when the document exists", () => {
  expect(hasCurrentFredBrief(approved, null, brief, 1)).toBe(false);
 });
 it("rejects changed revisions and changed agreed criteria", () => {
  expect(hasCurrentFredBrief({ ...approved, latestRevisionId: "unreviewed-2" }, approved.latestRevisionId, brief, 1)).toBe(false);
  expect(hasCurrentFredBrief(approved, approved.latestRevisionId, { ...brief, goal: "A different goal" }, 1)).toBe(false);
 });
 it("does not invent a baseline, acceptance, human effort or outcome", () => {
  expect(approved.body).toContain("Not measured / unknown");
  expect(approved.body).toContain("Owner acceptance: not recorded here.");
  expect(approved.body).toContain("Business outcome: not established by this brief.");
  expect(approved.body).toContain("Human correction effort: not measured.");
 });
});
