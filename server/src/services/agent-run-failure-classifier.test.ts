import { describe, expect, it } from "vitest";
import { classifyAgentRunFailure } from "./agent-run-failure-classifier.js";

describe("agent run failure classifier", () => {
  it("classifies missing credentials before auth rejection", () => {
    expect(
      classifyAgentRunFailure({
        outcome: "failed",
        adapterType: "codex_local",
        errorCode: "adapter_failed",
        errorMessage: "OPENAI_API_KEY is not set",
      }),
    ).toMatchObject({
      category: "missing_credential",
      severity: "customer_action_required",
      nextActions: expect.arrayContaining(["open_credentials", "run_adapter_test"]),
    });
  });

  it("classifies provider usage windows as rate limits", () => {
    expect(
      classifyAgentRunFailure({
        outcome: "failed",
        adapterType: "claude_local",
        errorCode: "claude_transient_upstream",
        errorMessage: "Usage limit reached. Resets at 3:15 AM.",
      }),
    ).toMatchObject({
      category: "rate_limited",
      severity: "transient",
      nextActions: expect.arrayContaining(["wait_and_retry", "switch_model_or_adapter"]),
    });
  });

  it("classifies invalid model errors as model unavailable", () => {
    expect(
      classifyAgentRunFailure({
        outcome: "failed",
        adapterType: "opencode_local",
        errorCode: "adapter_failed",
        errorMessage: "ProviderModelNotFoundError: model not found",
      }),
    ).toMatchObject({
      category: "model_unavailable",
      nextActions: expect.arrayContaining(["switch_model_or_adapter"]),
    });
  });

  it("classifies workspace errors separately from adapter install errors", () => {
    expect(
      classifyAgentRunFailure({
        outcome: "failed",
        adapterType: "codex_local",
        errorCode: "adapter_failed",
        errorMessage: "cwd invalid: no such file or directory",
      }),
    ).toMatchObject({
      category: "workspace_unavailable",
      nextActions: expect.arrayContaining(["fix_workspace"]),
    });
  });

  it("classifies timeouts without depending on message text", () => {
    expect(
      classifyAgentRunFailure({
        outcome: "timed_out",
        adapterType: "cursor",
        errorCode: "timeout",
        errorMessage: null,
      }),
    ).toMatchObject({
      category: "timeout",
      severity: "transient",
      nextActions: expect.arrayContaining(["retry", "run_adapter_test"]),
    });
  });

  it("returns null for successful runs", () => {
    expect(
      classifyAgentRunFailure({
        outcome: "succeeded",
        adapterType: "codex_local",
        errorCode: null,
        errorMessage: null,
      }),
    ).toBeNull();
  });
});
