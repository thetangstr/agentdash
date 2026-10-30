import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import {
  PERSON_NEXT_STEP,
  accessPolicyRefusalOf,
  accessPolicyRefusalSentence,
  agentActionErrorText,
} from "./access-policy-refusal";

// AgentDash (APM gate 3): a 403 ACCESS_POLICY_REFUSED answers its refusal at
// the top level of the body. People see it in plain words with their next
// step; the agent-facing `howToRequest` is kept but not shown as their text.

const BODY = {
  error: "Refused by this agent's access rules (do.skills). Allowed: skills on its profile: research, writing.",
  code: "ACCESS_POLICY_REFUSED",
  dimension: "do.skills",
  rule: "do.skills.not_listed",
  requested: { skillKey: "browser" },
  allowedSummary: "skills on its profile: research, writing",
  howToRequest: "Ask your accountable person or steward to change this agent's access…",
};

function refusal(status = 403, body: unknown = BODY) {
  return new ApiError(BODY.error, status, body);
}

describe("access policy refusals", () => {
  it("reads the refusal body", () => {
    expect(accessPolicyRefusalOf(refusal())).toEqual({
      message: BODY.error,
      dimension: "do.skills",
      rule: "do.skills.not_listed",
      requested: { skillKey: "browser" },
      allowedSummary: "skills on its profile: research, writing",
      howToRequest: BODY.howToRequest,
    });
  });

  it("ignores anything that is not a 403 ACCESS_POLICY_REFUSED", () => {
    expect(accessPolicyRefusalOf(refusal(403, { error: "Forbidden" }))).toBeNull();
    expect(accessPolicyRefusalOf(refusal(400, BODY))).toBeNull();
    expect(accessPolicyRefusalOf(new Error("boom"))).toBeNull();
    expect(accessPolicyRefusalOf(null)).toBeNull();
  });

  it("says it in plain words, with what is allowed and what a person can do", () => {
    const sentence = accessPolicyRefusalSentence(accessPolicyRefusalOf(refusal())!);
    expect(sentence).toBe(
      `Refused by this agent's access rules (which skills it can have). Allowed: skills on its profile: research, writing. ${PERSON_NEXT_STEP}`,
    );
    expect(sentence).not.toContain("do.skills");
    expect(sentence).not.toContain("GET /api");
  });

  it("falls back to the server's message, then to the caller's words", () => {
    expect(agentActionErrorText(refusal(), "Failed")).toContain("Refused by this agent's access rules");
    expect(agentActionErrorText(new ApiError("Agent is paused", 409, { error: "Agent is paused" }), "Failed")).toBe("Agent is paused");
    expect(agentActionErrorText("nope", "Failed to update skills")).toBe("Failed to update skills");
  });
});
