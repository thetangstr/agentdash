// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildAgentHarnessPreflightKey,
  getAgentCreateHarnessPreflightGate,
} from "./agent-harness-preflight";

describe("agent harness preflight", () => {
  it("blocks launch-safe creation until the current adapter config has passed preflight", () => {
    const currentConfigKey = buildAgentHarnessPreflightKey({
      adapterType: "codex_local",
      defaultEnvironmentId: null,
      adapterConfig: { model: "gpt-5.5" },
    });

    expect(
      getAgentCreateHarnessPreflightGate({
        currentConfigKey,
        passedConfigKey: null,
        pending: false,
        result: null,
        errorMessage: null,
      }),
    ).toMatchObject({
      canCreate: false,
      reason: "missing",
    });

    expect(
      getAgentCreateHarnessPreflightGate({
        currentConfigKey,
        passedConfigKey: currentConfigKey,
        pending: false,
        result: {
          adapterType: "codex_local",
          status: "pass",
          checks: [],
          testedAt: new Date(0).toISOString(),
        },
        errorMessage: null,
      }),
    ).toMatchObject({
      canCreate: true,
      reason: "passed",
    });
  });

  it("requires a retest after the adapter config changes", () => {
    const passedConfigKey = buildAgentHarnessPreflightKey({
      adapterType: "codex_local",
      defaultEnvironmentId: null,
      adapterConfig: { model: "gpt-5.5" },
    });
    const currentConfigKey = buildAgentHarnessPreflightKey({
      adapterType: "codex_local",
      defaultEnvironmentId: null,
      adapterConfig: { model: "gpt-5.6" },
    });

    expect(
      getAgentCreateHarnessPreflightGate({
        currentConfigKey,
        passedConfigKey,
        pending: false,
        result: {
          adapterType: "codex_local",
          status: "pass",
          checks: [],
          testedAt: new Date(0).toISOString(),
        },
        errorMessage: null,
      }),
    ).toMatchObject({
      canCreate: false,
      reason: "stale",
    });
  });

  it("blocks creation only when the latest preflight failed — warnings are advisory", () => {
    const currentConfigKey = buildAgentHarnessPreflightKey({
      adapterType: "codex_local",
      defaultEnvironmentId: null,
      adapterConfig: { model: "gpt-5.5" },
    });

    // A self-hosted Hermes box legitimately warns about keys living outside
    // AgentDash's env; that warning must not block creating the agent.
    expect(
      getAgentCreateHarnessPreflightGate({
        currentConfigKey,
        passedConfigKey: currentConfigKey,
        pending: false,
        result: {
          adapterType: "codex_local",
          status: "warn",
          checks: [],
          testedAt: new Date(0).toISOString(),
        },
        errorMessage: null,
      }),
    ).toMatchObject({
      canCreate: true,
      reason: "passed",
    });

    expect(
      getAgentCreateHarnessPreflightGate({
        currentConfigKey,
        passedConfigKey: currentConfigKey,
        pending: false,
        result: {
          adapterType: "codex_local",
          status: "fail",
          checks: [],
          testedAt: new Date(0).toISOString(),
        },
        errorMessage: null,
      }),
    ).toMatchObject({
      canCreate: false,
      reason: "not_passed",
    });
  });
});
