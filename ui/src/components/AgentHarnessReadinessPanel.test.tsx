// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { AGENT_HARNESS_PREFLIGHT_CONTRACT_VERSION } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  AgentHarnessReadinessPanel,
  needsBackgroundPreflight,
  readAgentHarnessPreflightStatus,
  shouldSurfaceHarnessPreflight,
} from "./AgentHarnessReadinessPanel";

const evidence = (overrides: Record<string, unknown> = {}) => ({
  harnessPreflight: {
    adapterType: "codex_local",
    status: "pass",
    testedAt: "2026-05-29T12:00:00.000Z",
    contractVersion: AGENT_HARNESS_PREFLIGHT_CONTRACT_VERSION,
    configDigest: "abc123",
    checks: [],
    ...overrides,
  },
});

const render = (metadata: unknown, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <AgentHarnessReadinessPanel status={readAgentHarnessPreflightStatus(metadata)} {...props} />,
  );

/**
 * Classification is still exercised in full, separately from rendering.
 *
 * The previous tests asserted on the HTML for every state, which tied the
 * question "did we read this evidence correctly" to the question "should this
 * be on screen". They are different questions, and merging them is why
 * changing the second one looked like breaking the first.
 */
describe("readAgentHarnessPreflightStatus", () => {
  it("reports missing evidence", () => {
    expect(readAgentHarnessPreflightStatus(null).state).toBe("missing");
  });

  it("reports passing evidence, naming the adapter and when it was taken", () => {
    const status = readAgentHarnessPreflightStatus(evidence());
    expect(status.state).toBe("pass");
    expect(status.adapterType).toBe("codex_local");
    expect(status.testedAt).toBe("2026-05-29T12:00:00.000Z");
  });

  it("does not treat evidence from an older launch contract as passing", () => {
    expect(readAgentHarnessPreflightStatus(evidence({ contractVersion: 1 })).state).toBe("stale");
  });

  it("reports incomplete evidence as malformed", () => {
    expect(readAgentHarnessPreflightStatus(evidence({ configDigest: null })).state).toBe("malformed");
  });

  it("reports failure and warning", () => {
    expect(readAgentHarnessPreflightStatus(evidence({ status: "fail" })).state).toBe("fail");
    expect(readAgentHarnessPreflightStatus(evidence({ status: "warn" })).state).toBe("warn");
  });
});

describe("what reaches the screen", () => {
  it("surfaces only states the reader can act on", () => {
    expect(shouldSurfaceHarnessPreflight("fail")).toBe(true);
    expect(shouldSurfaceHarnessPreflight("warn")).toBe(true);
    expect(shouldSurfaceHarnessPreflight("pass")).toBe(false);
    expect(shouldSurfaceHarnessPreflight("missing")).toBe(false);
    expect(shouldSurfaceHarnessPreflight("stale")).toBe(false);
    expect(shouldSurfaceHarnessPreflight("malformed")).toBe(false);
  });

  it("re-checks in the background exactly when there is no current evidence", () => {
    expect(needsBackgroundPreflight("missing")).toBe(true);
    expect(needsBackgroundPreflight("stale")).toBe(true);
    expect(needsBackgroundPreflight("malformed")).toBe(true);
    // A failure is an answer, not an absence — re-running it on a loop would
    // hammer the adapter and never settle.
    expect(needsBackgroundPreflight("fail")).toBe(false);
    expect(needsBackgroundPreflight("warn")).toBe(false);
    expect(needsBackgroundPreflight("pass")).toBe(false);
  });

  /**
   * Agents run whether or not preflight evidence exists. A banner demanding
   * preflight above an agent that is already working claims a gate that is not
   * enforced, which is worse than silence.
   */
  it("renders nothing when preflight has never been run", () => {
    expect(render(null)).toBe("");
  });

  it("renders nothing when preflight passed", () => {
    expect(render(evidence())).toBe("");
  });

  it("renders nothing for stale or malformed evidence, which the page re-checks itself", () => {
    expect(render(evidence({ contractVersion: 1 }))).toBe("");
    expect(render(evidence({ configDigest: null }))).toBe("");
  });

  it("renders failing checks with their hints, and a way to re-run", () => {
    const html = render(
      evidence({
        adapterType: "claude_local",
        status: "fail",
        checks: [
          {
            code: "missing_token",
            level: "error",
            message: "Missing API key",
            hint: "Add the provider key, then rerun preflight.",
          },
        ],
      }),
      { onRunPreflight: () => undefined },
    );

    expect(html).toContain("Harness preflight failed");
    expect(html).toContain("Missing API key");
    expect(html).toContain("Add the provider key");
    expect(html).toContain("Run preflight");
  });

  it("renders warnings", () => {
    expect(render(evidence({ status: "warn" }))).toContain("Harness preflight has warnings");
  });

  /**
   * A manual run that errors is the one case where a non-surfaced state still
   * has something to say: the person asked, so they get an answer.
   */
  it("still reports an error from a run the person asked for", () => {
    const html = render(evidence(), { error: "Adapter probe timed out" });
    expect(html).toContain("Adapter probe timed out");
  });
});
