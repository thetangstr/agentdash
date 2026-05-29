// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { AGENT_HARNESS_PREFLIGHT_CONTRACT_VERSION } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  AgentHarnessReadinessPanel,
  readAgentHarnessPreflightStatus,
} from "./AgentHarnessReadinessPanel";

describe("AgentHarnessReadinessPanel", () => {
  it("renders a missing-preflight call to action for saved agents", () => {
    const status = readAgentHarnessPreflightStatus(null);

    const html = renderToStaticMarkup(
      <AgentHarnessReadinessPanel
        status={status}
        onRunPreflight={() => undefined}
      />,
    );

    expect(html).toContain("Harness preflight required");
    expect(html).toContain("Run preflight");
  });

  it("renders saved passing preflight evidence", () => {
    const status = readAgentHarnessPreflightStatus({
      harnessPreflight: {
        adapterType: "codex_local",
        status: "pass",
        testedAt: "2026-05-29T12:00:00.000Z",
        contractVersion: AGENT_HARNESS_PREFLIGHT_CONTRACT_VERSION,
        configDigest: "abc123",
        checks: [],
      },
    });

    const html = renderToStaticMarkup(
      <AgentHarnessReadinessPanel status={status} />,
    );

    expect(html).toContain("Harness preflight passed");
    expect(html).toContain("codex local");
    expect(html).toContain("Saved evidence");
  });

  it("does not show a passing state for stale launch contract evidence", () => {
    const status = readAgentHarnessPreflightStatus({
      harnessPreflight: {
        adapterType: "codex_local",
        status: "pass",
        testedAt: "2026-05-29T12:00:00.000Z",
        contractVersion: 1,
        configDigest: "abc123",
        checks: [],
      },
    });

    const html = renderToStaticMarkup(
      <AgentHarnessReadinessPanel status={status} />,
    );

    expect(html).toContain("Harness preflight evidence is stale");
    expect(html).toContain("Run preflight again");
    expect(html).not.toContain("Harness preflight passed");
  });

  it("renders failing preflight checks with hints", () => {
    const status = readAgentHarnessPreflightStatus({
      harnessPreflight: {
        adapterType: "claude_local",
        status: "fail",
        testedAt: "2026-05-29T12:00:00.000Z",
        contractVersion: AGENT_HARNESS_PREFLIGHT_CONTRACT_VERSION,
        configDigest: "abc123",
        checks: [
          {
            code: "missing_token",
            level: "error",
            message: "Missing API key",
            hint: "Add the provider key, then rerun preflight.",
          },
        ],
      },
    });

    const html = renderToStaticMarkup(
      <AgentHarnessReadinessPanel status={status} />,
    );

    expect(html).toContain("Harness preflight failed");
    expect(html).toContain("Missing API key");
    expect(html).toContain("Add the provider key");
  });
});
