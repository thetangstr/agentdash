// Phase H — typed-card payload schema tests for the goals-eval-hitl layer.
//
// These exercise the two new card-payload schemas (verdict_review and
// human_taste_gate) the CoS taste-router emits. Validates that:
//  - minimal valid payloads parse successfully,
//  - all-optional-field payloads parse successfully,
//  - missing required fields are rejected,
//  - invalid enum values are rejected.
//
// Co-located alongside the existing `mention-parser.test.ts` per the
// package's `__tests__/` convention.
import { describe, expect, it } from "vitest";
import {
  definitionOfDoneSchema,
  verdictReviewCardPayloadSchema,
  humanTasteGateCardPayloadSchema,
} from "../validators/goals-eval-hitl.js";

const VERDICT_ID = "11111111-1111-1111-1111-111111111111";
const ISSUE_ID = "22222222-2222-2222-2222-222222222222";
const APPROVAL_ID = "33333333-3333-3333-3333-333333333333";
const REVIEWER_AGENT_ID = "44444444-4444-4444-4444-444444444444";
const REVIEWER_USER_ID = "user_admin";

describe("verdictReviewCardPayloadSchema", () => {
  it("accepts a minimal valid payload (verdictId, issueId, entityType, outcome)", () => {
    const result = verdictReviewCardPayloadSchema.safeParse({
      verdictId: VERDICT_ID,
      issueId: ISSUE_ID,
      entityType: "issue",
      outcome: "passed",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a full payload with rubric scores, justification, both reviewer ids", () => {
    const result = verdictReviewCardPayloadSchema.safeParse({
      verdictId: VERDICT_ID,
      issueId: ISSUE_ID,
      entityType: "issue",
      outcome: "revision_requested",
      rubricScores: {
        clarity: 3,
        completeness: { score: 4, justification: "thorough" },
      },
      justification: "Looks great overall, minor revision needed.",
      reviewerAgentId: REVIEWER_AGENT_ID,
      reviewerUserId: REVIEWER_USER_ID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects when verdictId is missing", () => {
    const result = verdictReviewCardPayloadSchema.safeParse({
      issueId: ISSUE_ID,
      entityType: "issue",
      outcome: "passed",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when entityType is missing", () => {
    const result = verdictReviewCardPayloadSchema.safeParse({
      verdictId: VERDICT_ID,
      issueId: ISSUE_ID,
      outcome: "passed",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when outcome is an unknown value", () => {
    const result = verdictReviewCardPayloadSchema.safeParse({
      verdictId: VERDICT_ID,
      issueId: ISSUE_ID,
      entityType: "issue",
      outcome: "bogus",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when verdictId is not a UUID", () => {
    const result = verdictReviewCardPayloadSchema.safeParse({
      verdictId: "not-a-uuid",
      issueId: ISSUE_ID,
      entityType: "issue",
      outcome: "passed",
    });
    expect(result.success).toBe(false);
  });
});

describe("humanTasteGateCardPayloadSchema", () => {
  const baseValid = {
    approvalId: APPROVAL_ID,
    verdictId: VERDICT_ID,
    issueId: ISSUE_ID,
    entityType: "issue" as const,
    summary: "CoS escalated this issue for human review",
    rationale: "Taste-critical decision: brand voice ambiguous",
  };

  it("accepts the minimal valid payload (no reviewUrl)", () => {
    const result = humanTasteGateCardPayloadSchema.safeParse(baseValid);
    expect(result.success).toBe(true);
  });

  it("accepts the full payload including reviewUrl", () => {
    const result = humanTasteGateCardPayloadSchema.safeParse({
      ...baseValid,
      reviewUrl: "https://example.com/issues/123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when approvalId is missing", () => {
    const { approvalId: _, ...rest } = baseValid;
    void _;
    const result = humanTasteGateCardPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects when verdictId is missing", () => {
    const { verdictId: _, ...rest } = baseValid;
    void _;
    const result = humanTasteGateCardPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects when summary is missing", () => {
    const { summary: _, ...rest } = baseValid;
    void _;
    const result = humanTasteGateCardPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects when rationale is missing", () => {
    const { rationale: _, ...rest } = baseValid;
    void _;
    const result = humanTasteGateCardPayloadSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects when entityType is invalid", () => {
    const result = humanTasteGateCardPayloadSchema.safeParse({
      ...baseValid,
      entityType: "task" as any,
    });
    expect(result.success).toBe(false);
  });
});

describe("definitionOfDoneSchema (Fix #177 — DoD must have at least one criterion)", () => {
  it("rejects an empty criteria array", () => {
    const result = definitionOfDoneSchema.safeParse({
      summary: "x",
      criteria: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join("|");
      expect(messages).toContain("at least one criterion");
    }
  });

  it("accepts a DoD with one or more criteria", () => {
    const result = definitionOfDoneSchema.safeParse({
      summary: "Ship the feature",
      criteria: [{ id: "c1", text: "Tests pass", done: false }],
    });
    expect(result.success).toBe(true);
  });
});
