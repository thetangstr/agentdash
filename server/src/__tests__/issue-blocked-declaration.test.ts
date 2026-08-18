import { describe, expect, it } from "vitest";
import {
  declaresBlocked,
  resolveAgentClosingStatus,
} from "../services/issue-blocked-declaration.js";

/**
 * From a real cold install: the Chief of Staff posted "BLOCKED — cannot
 * assemble a board pack yet: no contributions exist to assemble", then set the
 * same issue to `done`. The pack was never assembled and the board read green.
 */
const REAL_BLOCKED_COMMENT =
  "BLOCKED — cannot assemble a board pack yet: no contributions exist to assemble.\n"
  + "What I checked • Goal 0bbb8961: only goal; owner = CoS (me); status = active.";

describe("declaresBlocked", () => {
  it("recognises the verdict an agent actually wrote", () => {
    expect(declaresBlocked(REAL_BLOCKED_COMMENT)).toBe(true);
  });

  it("reads through leading markdown and list punctuation", () => {
    expect(declaresBlocked("## BLOCKED: waiting on Delivery")).toBe(true);
    expect(declaresBlocked("- **blocked** — no access")).toBe(true);
    expect(declaresBlocked("\n\n  > BLOCKED, see below")).toBe(true);
  });

  /**
   * Anchored to the start, because agents lead with a verdict. The word
   * appearing mid-body is nearly always narration about the past, and treating
   * that as a live block would strand finished work.
   */
  it("ignores the word when it is narration rather than a verdict", () => {
    expect(declaresBlocked("DONE: this was blocked until Tuesday, now shipped.")).toBe(false);
    expect(declaresBlocked("Summary: nothing is blocked this week.")).toBe(false);
  });

  it("handles absent bodies", () => {
    expect(declaresBlocked(null)).toBe(false);
    expect(declaresBlocked(undefined)).toBe(false);
    expect(declaresBlocked("")).toBe(false);
  });
});

describe("resolveAgentClosingStatus", () => {
  it("refuses to close an issue the agent just declared blocked", () => {
    const result = resolveAgentClosingStatus({
      actorIsAgent: true,
      requestedStatus: "done",
      latestOwnCommentBody: REAL_BLOCKED_COMMENT,
    });

    expect(result.status).toBe("blocked");
    expect(result.overridden).toBe(true);
  });

  it("reads the declaration from the same request when there is one", () => {
    const result = resolveAgentClosingStatus({
      actorIsAgent: true,
      requestedStatus: "done",
      commentBody: "BLOCKED — need the API key first",
    });

    expect(result.status).toBe("blocked");
  });

  it("lets an agent close work it reported as done", () => {
    const result = resolveAgentClosingStatus({
      actorIsAgent: true,
      requestedStatus: "done",
      latestOwnCommentBody: "DONE: pack assembled, 151 lines, every figure sourced.",
    });

    expect(result.status).toBe("done");
    expect(result.overridden).toBe(false);
  });

  /**
   * A person closing an issue an agent called blocked is overruling a machine
   * with knowledge it does not have. That is the decision this whole product
   * exists to keep with the human, so it passes through untouched.
   */
  it("never overrides a person", () => {
    const result = resolveAgentClosingStatus({
      actorIsAgent: false,
      requestedStatus: "done",
      latestOwnCommentBody: REAL_BLOCKED_COMMENT,
    });

    expect(result.status).toBe("done");
    expect(result.overridden).toBe(false);
  });

  it("only guards the transition to done", () => {
    for (const status of ["in_progress", "todo", "cancelled", "blocked", undefined]) {
      const result = resolveAgentClosingStatus({
        actorIsAgent: true,
        requestedStatus: status,
        latestOwnCommentBody: REAL_BLOCKED_COMMENT,
      });
      expect(result.status).toBe(status);
      expect(result.overridden).toBe(false);
    }
  });
});
