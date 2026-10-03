import type { AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { isBlockingPreflightResult } from "@paperclipai/shared";

type HarnessPreflightReason =
  | "passed"
  | "pending"
  | "missing"
  | "stale"
  | "not_passed"
  | "error";

export type AgentCreateHarnessPreflightGate = {
  canCreate: boolean;
  reason: HarnessPreflightReason;
  message: string | null;
};

export function buildAgentHarnessPreflightKey(input: {
  adapterType: string;
  defaultEnvironmentId: string | null | undefined;
  adapterConfig: Record<string, unknown>;
}) {
  return JSON.stringify({
    adapterType: input.adapterType,
    defaultEnvironmentId: input.defaultEnvironmentId ?? null,
    adapterConfig: input.adapterConfig,
  });
}

export function getAgentCreateHarnessPreflightGate(input: {
  currentConfigKey: string;
  passedConfigKey: string | null;
  pending: boolean;
  result: AdapterEnvironmentTestResult | null;
  errorMessage: string | null;
}): AgentCreateHarnessPreflightGate {
  if (input.pending) {
    return {
      canCreate: false,
      reason: "pending",
      message: "The setup check is still running.",
    };
  }
  if (input.errorMessage) {
    return {
      canCreate: false,
      reason: "error",
      message: input.errorMessage,
    };
  }
  if (!input.result) {
    return {
      canCreate: false,
      reason: "missing",
      message: "Run Test Agent and resolve any checks before creating this agent.",
    };
  }
  // Warnings are advisory (e.g. a self-hosted Hermes box legitimately holds its
  // LLM keys outside AgentDash's env) — except a warn that says the adapter
  // cannot run at all (probe auth required, probe failed). Those block like a
  // fail; the shared rule keeps this gate in step with the server.
  if (isBlockingPreflightResult(input.result)) {
    return {
      canCreate: false,
      reason: "not_passed",
      message: "The latest setup check did not pass. Resolve the checks, then test again.",
    };
  }
  if (input.passedConfigKey !== input.currentConfigKey) {
    return {
      canCreate: false,
      reason: "stale",
      message: "Agent configuration changed after the last passing test. Run Test Agent again.",
    };
  }
  return {
    canCreate: true,
    reason: "passed",
    message: null,
  };
}
