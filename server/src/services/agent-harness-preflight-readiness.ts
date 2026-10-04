import { createHash } from "node:crypto";
import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { AGENT_HARNESS_PREFLIGHT_CONTRACT_VERSION, isBlockingPreflightResult } from "@paperclipai/shared";

export type AgentHarnessPreflightReadinessReason =
  | "passed"
  | "passed_with_warnings"
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
  const savedChecks = Array.isArray(harnessPreflight.checks)
    ? harnessPreflight.checks.flatMap((check) => {
        const record = asRecord(check);
        return record ? [{ code: record.code, level: record.level }] : [];
      })
    : [];
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

  // Staleness outranks outcome: a failed check against an OLD config must
  // read as stale so the page re-checks the current one in the background —
  // the saved failure may no longer be true. Blocking is unaffected: the UI
  // treats stale evidence as not-ready either way, and launch stays gated.
  if (configDigest !== buildAgentHarnessPreflightDigest(input)) {
    return {
      ready: false,
      reason: "stale",
      message: "Run a new harness preflight because the agent configuration changed.",
      testedAt,
    };
  }

  // Warnings are advisory — the evidence is usable; only a failed check blocks
  // the agent. Except a warning that says the adapter cannot run at all
  // (probe auth required, probe failed, Hermes with no provider): that blocks
  // like a fail. Anything else (unknown statuses included) still cannot be
  // trusted, so it stays `not_passed`.
  if (
    status === "fail"
    || (status !== "pass" && status !== "warn")
    || isBlockingPreflightResult({ status, checks: savedChecks })
  ) {
    return {
      ready: false,
      reason: "not_passed",
      // "harness preflight" is rewritten to "setup check" for owners — say
      // "findings", not "checks", or it reads "Resolve the saved setup check
      // checks".
      message: "Resolve the findings from the saved harness preflight before starting this agent.",
      testedAt,
    };
  }

  return {
    ready: true,
    reason: status === "warn" ? "passed_with_warnings" : "passed",
    message:
      status === "warn"
        ? "Harness preflight passed with warnings for the current agent configuration."
        : "Harness preflight passed for the current agent configuration.",
    testedAt,
  };
}

export function shouldRequireAgentHarnessPreflight(env: NodeJS.ProcessEnv = process.env) {
  return env.AGENTDASH_REQUIRE_AGENT_HARNESS_PREFLIGHT === "true";
}
