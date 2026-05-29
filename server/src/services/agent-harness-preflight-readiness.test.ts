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
