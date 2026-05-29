// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildHarnessSupportEscalationBody } from "./harness-support-escalation";

describe("harness support escalation", () => {
  it("builds a safe support note from classified run metadata only", () => {
    const body = buildHarnessSupportEscalationBody(
      {
        runId: "run-1",
        agentId: "agent-1",
        status: "failed",
        errorCode: "adapter_failed",
      },
      {
        category: "unknown",
        severity: "product_bug_unknown",
        title: "Run failed for an unknown reason",
        detail: "AgentDash could not classify this failure from the adapter error.",
        nextActions: ["run_adapter_test", "retry", "escalate_support"],
      },
    );

    expect(body).toContain("### Harness support escalation");
    expect(body).toContain("Run: run-1");
    expect(body).toContain("Status: failed (adapter_failed)");
    expect(body).toContain("Next actions: Run adapter test, Retry, Escalate support");
    expect(body).toContain("does not attach raw logs, transcripts, secrets, or trace bundles");
  });
});
