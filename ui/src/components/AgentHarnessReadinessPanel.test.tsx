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

  it("reports a warn that means the adapter cannot run as a failure", () => {
    const status = readAgentHarnessPreflightStatus(
      evidence({
        status: "warn",
        checks: [
          {
            code: "codex_hello_probe_auth_required",
            level: "warn",
            message: "Codex CLI is installed, but authentication is not ready.",
          },
        ],
      }),
    );
    expect(status.state).toBe("fail");
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

    expect(html).toContain("Setup check failed");
    expect(html).not.toMatch(/preflight/i);
    expect(html).toContain("Missing API key");
    expect(html).toContain("Add the provider key, then rerun setup check.");
    expect(html).toContain("Check setup");
  });

  /**
   * A failed check on an agent that has already run successfully is not the
   * red "this agent is broken" block — the evidence is probably stale, so the
   * panel asks for a re-check in neutral styling.
   */
  it("softens a failed check into 'Re-check setup' when the agent has run successfully", () => {
    const html = render(
      evidence({ status: "fail" }),
      { onRunPreflight: () => undefined, hasSuccessfulRuns: true },
    );

    expect(html).toContain("Re-check setup");
    expect(html).toContain("has run before");
    expect(html).toContain("Launching stays blocked");
    expect(html).not.toContain("Setup check failed");
  });

  it("keeps the hard failure styling when the agent has never run successfully", () => {
    const html = render(evidence({ status: "fail" }), { onRunPreflight: () => undefined });
    expect(html).toContain("Setup check failed");
    expect(html).not.toContain("Re-check setup");
  });

  it("renders warnings as an advisory note, not a failure", () => {
    const html = render(evidence({ status: "warn" }));
    expect(html).toContain("Setup check passed with warnings");
    expect(html).toContain("advisory");
    expect(html).not.toContain("Setup check required");
  });

  /**
   * A manual run that errors is the one case where a non-surfaced state still
   * has something to say: the person asked, so they get an answer.
   */
  it("still reports an error from a run the person asked for", () => {
    const html = render(evidence(), { error: "Adapter probe timed out" });
    expect(html).toContain("Adapter probe timed out");
  });
})

describe("stale evidence the client cannot detect alone", () => {
  /**
   * The exact shape found on every agent in the MK workspace: a preflight that
   * passed weeks ago, naming `codex_local`, on an agent that now runs
   * `hermes_local`. Reported as "all five agents, and three of them name the
   * wrong adapter... anyone reading a preflight to learn what an agent runs
   * gets a wrong answer."
   */
  const CODEX_EVIDENCE_ON_A_HERMES_AGENT = {
    harnessPreflight: {
      status: "pass",
      adapterType: "codex_local",
      testedAt: "2026-08-19T04:22:22.461Z",
      configDigest: "6b725ac383b0b11950024a1708c3b76884d760c5318087f2ec8bf217afedd65d",
      contractVersion: AGENT_HARNESS_PREFLIGHT_CONTRACT_VERSION,
      checks: [],
    },
  };

  it("reported a pass before the server's verdict was available", () => {
    // Documents the defect rather than endorsing it: with no verdict there is
    // nothing in the metadata that reveals the mismatch.
    expect(readAgentHarnessPreflightStatus(CODEX_EVIDENCE_ON_A_HERMES_AGENT).state).toBe("pass");
  });

  it("reports stale once the server says the configuration changed", () => {
    const status = readAgentHarnessPreflightStatus(CODEX_EVIDENCE_ON_A_HERMES_AGENT, {
      ready: false,
      reason: "stale",
      message: "Run a new harness preflight because the agent configuration changed.",
      testedAt: "2026-08-19T04:22:22.461Z",
    });
    expect(status.state).toBe("stale");
    expect(status.message).toBe(
      "Run a new harness preflight because the agent configuration changed.",
    );
  });

  it("still shows what was tested, so the mismatch is visible not just asserted", () => {
    const status = readAgentHarnessPreflightStatus(CODEX_EVIDENCE_ON_A_HERMES_AGENT, {
      ready: false,
      reason: "stale",
      message: "Run a new harness preflight because the agent configuration changed.",
      testedAt: "2026-08-19T04:22:22.461Z",
    });
    expect(status.adapterType).toBe("codex_local");
    expect(status.testedAt).toBe("2026-08-19T04:22:22.461Z");
  });

  it("keeps reporting a pass when the server says the evidence is current", () => {
    const status = readAgentHarnessPreflightStatus(CODEX_EVIDENCE_ON_A_HERMES_AGENT, {
      ready: true,
      reason: "passed",
      message: "ok",
      testedAt: "2026-08-19T04:22:22.461Z",
    });
    expect(status.state).toBe("pass");
  });

  /**
   * AgentDash (c4 trust): every agent in the MK workspace had a verdict of
   * `not_passed` — a CURRENT check that failed — which the panel mapped to
   * "stale". Stale is hidden and re-checked in the background, so the failure
   * was invisible while the page hammered the preflight endpoint (and logged
   * an activity row) on every visit.
   */
  it("reports a not-passed verdict as the failure it is, with the check's message", () => {
    const status = readAgentHarnessPreflightStatus(
      evidence({
        status: "fail",
        checks: [
          {
            code: "missing_token",
            level: "error",
            message: "Missing API key",
            hint: "Add the provider key.",
          },
        ],
      }),
      {
        ready: false,
        reason: "not_passed",
        message: "Resolve the saved harness preflight checks before starting this agent.",
        testedAt: "2026-05-29T12:00:00.000Z",
      },
    );
    expect(status.state).toBe("fail");
    expect(status.message).toBe(
      "Resolve the saved harness preflight checks before starting this agent.",
    );
    expect(status.checks[0]?.message).toBe("Missing API key");
    // A failure is a current answer, not stale evidence — no re-check.
    expect(needsBackgroundPreflight(status.state)).toBe(false);
  });

  it("renders a not-passed verdict as the softened re-check note for an agent that has run", () => {
    const status = readAgentHarnessPreflightStatus(evidence({ status: "fail" }), {
      ready: false,
      reason: "not_passed",
      message: "Resolve the saved harness preflight checks before starting this agent.",
      testedAt: "2026-05-29T12:00:00.000Z",
    });
    const html = renderToStaticMarkup(
      <AgentHarnessReadinessPanel status={status} onRunPreflight={() => undefined} hasSuccessfulRuns />,
    );
    expect(html).toContain("Re-check setup");
    expect(html).toContain("has run before");
    expect(html).not.toContain("out of date");
  });
});
