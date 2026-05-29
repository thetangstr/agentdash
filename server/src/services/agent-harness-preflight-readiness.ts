import { createHash } from "node:crypto";
import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";

const AGENT_HARNESS_PREFLIGHT_CONTRACT_VERSION = 2;

export type AgentHarnessPreflightReadinessReason =
  | "passed"
  | "missing"
  | "not_passed"
  | "stale"
  | "malformed";

export interface AgentHarnessPreflightReadiness {
  ready: boolean;
  reason: AgentHarnessPreflightReadinessReason;
  message: string;
  testedAt: string | null;
}

export interface AgentHarnessPreflightDigestInput {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  defaultEnvironmentId: string | null | undefined;
}

interface AgentHarnessPreflightMetadataInput extends AgentHarnessPreflightDigestInput {
  result: AdapterEnvironmentTestResult;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildAgentHarnessPreflightDigest(input: AgentHarnessPreflightDigestInput) {
  return createHash("sha256")
    .update(stableJson({
      adapterType: input.adapterType,
      adapterConfig: input.adapterConfig,
      defaultEnvironmentId: input.defaultEnvironmentId ?? null,
    }))
    .digest("hex");
}

export function withAgentHarnessPreflightMetadata(
  metadata: Record<string, unknown> | null | undefined,
  input: AgentHarnessPreflightMetadataInput,
) {
  const existing = asRecord(metadata) ?? {};
  return {
    ...existing,
    harnessPreflight: {
      adapterType: input.result.adapterType,
      status: input.result.status,
      testedAt: input.result.testedAt,
      contractVersion: AGENT_HARNESS_PREFLIGHT_CONTRACT_VERSION,
      configDigest: buildAgentHarnessPreflightDigest(input),
      checks: input.result.checks.map((check) => ({
        code: check.code,
        level: check.level,
        message: check.message,
        hint: check.hint ?? null,
      })),
    },
  };
}

export function evaluateAgentHarnessPreflightReadiness(
  input: AgentHarnessPreflightDigestInput & { metadata: unknown },
): AgentHarnessPreflightReadiness {
  const metadata = asRecord(input.metadata);
  const harnessPreflight = asRecord(metadata?.harnessPreflight);
  if (!harnessPreflight) {
    return {
      ready: false,
      reason: "missing",
      message: "Run a harness preflight before starting this agent.",
      testedAt: null,
    };
  }

  const status = typeof harnessPreflight.status === "string" ? harnessPreflight.status : null;
  const testedAt = typeof harnessPreflight.testedAt === "string" ? harnessPreflight.testedAt : null;
  const configDigest = typeof harnessPreflight.configDigest === "string" ? harnessPreflight.configDigest : null;
  const contractVersion =
    typeof harnessPreflight.contractVersion === "number" && Number.isInteger(harnessPreflight.contractVersion)
      ? harnessPreflight.contractVersion
      : null;
  if (!status || !testedAt || !configDigest) {
    return {
      ready: false,
      reason: "malformed",
      message: "Run a new harness preflight because the saved preflight evidence is incomplete.",
      testedAt,
    };
  }

  if (contractVersion !== AGENT_HARNESS_PREFLIGHT_CONTRACT_VERSION) {
    return {
      ready: false,
      reason: "stale",
      message: "Run a new harness preflight because the preflight contract changed.",
      testedAt,
    };
  }

  if (status !== "pass") {
    return {
      ready: false,
      reason: "not_passed",
      message: "Resolve the saved harness preflight checks before starting this agent.",
      testedAt,
    };
  }

  if (configDigest !== buildAgentHarnessPreflightDigest(input)) {
    return {
      ready: false,
      reason: "stale",
      message: "Run a new harness preflight because the agent configuration changed.",
      testedAt,
    };
  }

  return {
    ready: true,
    reason: "passed",
    message: "Harness preflight passed for the current agent configuration.",
    testedAt,
  };
}

export function shouldRequireAgentHarnessPreflight(env: NodeJS.ProcessEnv = process.env) {
  return env.AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT === "true";
}
