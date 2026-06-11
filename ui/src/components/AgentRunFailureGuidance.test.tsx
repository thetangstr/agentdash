// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgentRunFailureGuidance,
  readAgentRunFailureClassification,
} from "./AgentRunFailureGuidance";

describe("AgentRunFailureGuidance", () => {
  it("reads classified failure metadata and renders recovery actions", () => {
    const classification = readAgentRunFailureClassification({
      failureClassification: {
        category: "missing_credential",
        severity: "customer_action_required",
        title: "Credential setup is incomplete",
        detail: "The adapter needs a configured API key or completed CLI login before this agent can run.",
        nextActions: ["open_credentials", "run_adapter_test", "retry"],
      },
    });

    expect(classification).toMatchObject({
      category: "missing_credential",
      severity: "customer_action_required",
      nextActions: ["open_credentials", "run_adapter_test", "retry"],
    });

    const html = renderToStaticMarkup(
      <AgentRunFailureGuidance classification={classification!} />,
    );

    expect(html).toContain("Harness recovery");
    expect(html).toContain("Credential setup is incomplete");
    expect(html).toContain("Open credentials");
    expect(html).toContain("Run adapter test");
    expect(html).toContain("Retry");
  });

  it("renders wired recovery actions as links or buttons", () => {
    const classification = readAgentRunFailureClassification({
      failureClassification: {
        category: "workspace_unavailable",
        severity: "operator_action_required",
        title: "Workspace missing",
        detail: "The run could not access its workspace.",
        nextActions: ["fix_workspace", "retry", "escalate_support"],
      },
    });

    const html = renderToStaticMarkup(
      <AgentRunFailureGuidance
        classification={classification!}
        actions={{
          fix_workspace: { href: "/agents/agent-1/configuration" },
          retry: { onClick: () => undefined },
        }}
      />,
    );

    expect(html).toContain('href="/agents/agent-1/configuration"');
    expect(html).toContain("<button");
    expect(html).toContain("Retry");
    expect(html).toContain("Escalate support");
  });

  it("ignores malformed failure metadata", () => {
    expect(readAgentRunFailureClassification({ failureClassification: { category: "missing_credential" } }))
      .toBeNull();
    expect(readAgentRunFailureClassification(null)).toBeNull();
  });
});
