import { describe, expect, it } from "vitest";
import {
  buildAgentHarnessPreflightDigest,
  evaluateAgentHarnessPreflightReadiness,
  shouldRequireAgentHarnessPreflight,
  withAgentHarnessPreflightMetadata,
} from "./agent-harness-preflight-readiness.js";

const baseInput = {
  adapterType: "codex_local",
  adapterConfig: { model: "gpt-5.5", env: { OPENAI_API_KEY: { type: "secret_ref", name: "openai" } } },
  defaultEnvironmentId: null,
};

describe("agent harness preflight readiness", () => {
  it("treats missing preflight metadata as not launch-ready", () => {
    expect(evaluateAgentHarnessPreflightReadiness({ ...baseInput, metadata: null })).toMatchObject({
      ready: false,
      reason: "missing",
    });
  });

  it("requires a passing preflight result for the current saved adapter config", () => {
    const result = {
      adapterType: "codex_local",
      status: "pass" as const,
      checks: [],
      testedAt: "2026-05-29T12:00:00.000Z",
    };
    const metadata = withAgentHarnessPreflightMetadata(null, {
      ...baseInput,
      result,
    });

    expect(evaluateAgentHarnessPreflightReadiness({ ...baseInput, metadata })).toMatchObject({
      ready: true,
      reason: "passed",
    });
  });

  it("treats a warned preflight as usable evidence, but a failed one as blocking", () => {
    const warned = withAgentHarnessPreflightMetadata(null, {
      ...baseInput,
      result: {
        adapterType: "codex_local",
        status: "warn" as const,
        checks: [{ code: "no_llm_keys", level: "warn" as const, message: "No LLM API keys in AgentDash env" }],
        testedAt: "2026-05-29T12:00:00.000Z",
      },
    });
    expect(evaluateAgentHarnessPreflightReadiness({ ...baseInput, metadata: warned })).toMatchObject({
      ready: true,
      reason: "passed_with_warnings",
    });

    const blocking = withAgentHarnessPreflightMetadata(null, {
      ...baseInput,
      result: {
        adapterType: "codex_local",
        status: "warn" as const,
        checks: [{ code: "codex_hello_probe_auth_required", level: "warn" as const, message: "Codex CLI is installed, but authentication is not ready." }],
        testedAt: "2026-05-29T12:00:00.000Z",
      },
    });
    // A warn that means the adapter cannot run at all is not usable evidence —
    // it blocks exactly like a fail.
    expect(evaluateAgentHarnessPreflightReadiness({ ...baseInput, metadata: blocking })).toMatchObject({
      ready: false,
      reason: "not_passed",
    });

    const failed = withAgentHarnessPreflightMetadata(null, {
      ...baseInput,
      result: {
        adapterType: "codex_local",
        status: "fail" as const,
        checks: [{ code: "missing_token", level: "error" as const, message: "Missing token" }],
        testedAt: "2026-05-29T12:00:00.000Z",
      },
    });
    expect(evaluateAgentHarnessPreflightReadiness({ ...baseInput, metadata: failed })).toMatchObject({
      ready: false,
      reason: "not_passed",
    });
  });

  // AgentDash (c4 trust, review #1026): staleness must outrank outcome — a
  // failed check against a CHANGED config reads as stale so the page
  // re-checks the current config in the background, instead of pinning the
  // old failure forever.
  it("marks a failed preflight stale after the saved config changes", () => {
    const metadata = withAgentHarnessPreflightMetadata(null, {
      ...baseInput,
      result: {
        adapterType: "codex_local",
        status: "fail" as const,
        checks: [{ code: "missing_token", level: "error" as const, message: "Missing token" }],
        testedAt: "2026-05-29T12:00:00.000Z",
      },
    });

    expect(
      evaluateAgentHarnessPreflightReadiness({
        ...baseInput,
        adapterConfig: { ...baseInput.adapterConfig, model: "gpt-5.6" },
        metadata,
      }),
    ).toMatchObject({
      ready: false,
      reason: "stale",
    });

    // Same evidence on the unchanged config still reports the failure.
    expect(
      evaluateAgentHarnessPreflightReadiness({ ...baseInput, metadata }),
    ).toMatchObject({
      ready: false,
      reason: "not_passed",
    });
  });

  it("marks a previously passing preflight stale after the saved config changes", () => {
    const result = {
      adapterType: "codex_local",
      status: "pass" as const,
      checks: [],
      testedAt: "2026-05-29T12:00:00.000Z",
    };
    const metadata = withAgentHarnessPreflightMetadata(null, {
      ...baseInput,
      result,
    });

    expect(
      evaluateAgentHarnessPreflightReadiness({
        ...baseInput,
        adapterConfig: { ...baseInput.adapterConfig, model: "gpt-5.6" },
        metadata,
      }),
    ).toMatchObject({
      ready: false,
      reason: "stale",
    });
  });

  it("marks legacy preflight metadata stale when it lacks the current preflight contract version", () => {
    const metadata = {
      harnessPreflight: {
        adapterType: "codex_local",
        status: "pass",
        testedAt: "2026-05-29T12:00:00.000Z",
        configDigest: buildAgentHarnessPreflightDigest(baseInput),
        checks: [],
      },
    };

    expect(evaluateAgentHarnessPreflightReadiness({ ...baseInput, metadata })).toMatchObject({
      ready: false,
      reason: "stale",
    });
  });

  it("uses stable digests independent of object key order", () => {
    expect(
      buildAgentHarnessPreflightDigest({
        adapterType: "codex_local",
        defaultEnvironmentId: null,
        adapterConfig: { b: 2, a: { d: 4, c: 3 } },
      }),
    ).toBe(
      buildAgentHarnessPreflightDigest({
        adapterType: "codex_local",
        defaultEnvironmentId: null,
        adapterConfig: { a: { c: 3, d: 4 }, b: 2 },
      }),
    );
  });

  it("requires launch preflight only when explicitly enabled", () => {
    expect(shouldRequireAgentHarnessPreflight({})).toBe(false);
    expect(
      shouldRequireAgentHarnessPreflight({
        AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT: "true",
      }),
    ).toBe(true);
  });
});
