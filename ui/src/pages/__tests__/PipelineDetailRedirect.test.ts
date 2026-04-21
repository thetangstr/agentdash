// AgentDash (AGE-42): Unit tests for the pipeline→goal redirect helper.
import { describe, it, expect } from "vitest";
import { resolvePipelineRedirectTarget } from "../PipelineDetailRedirect";

describe("resolvePipelineRedirectTarget", () => {
  it("waits while the pipeline is still loading", () => {
    expect(resolvePipelineRedirectTarget(null)).toEqual({ kind: "wait" });
    expect(resolvePipelineRedirectTarget(undefined)).toEqual({ kind: "wait" });
  });

  it("redirects to the owning goal when goalId is set", () => {
    expect(resolvePipelineRedirectTarget({ goalId: "goal-123" })).toEqual({
      kind: "goal",
      goalId: "goal-123",
    });
  });

  it("falls back to the legacy detail surface when goalId is null", () => {
    expect(resolvePipelineRedirectTarget({ goalId: null })).toEqual({ kind: "fallback" });
  });
});
