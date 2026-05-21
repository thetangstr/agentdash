import type {
  CosPilotAccessGrant,
  CosPilotProposalV1Payload,
} from "../cards.js";

const ACCESS_MODES: ReadonlySet<string> = new Set([
  "read_only",
  "draft_only",
  "human_approved",
]);

const ACCESS_STATUSES: ReadonlySet<string> = new Set([
  "not_connected",
  "requested",
  "available",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isAccessGrant(value: unknown): value is CosPilotAccessGrant {
  if (!value || typeof value !== "object") return false;
  const grant = value as Record<string, unknown>;
  return (
    isNonEmptyString(grant.system) &&
    isNonEmptyString(grant.purpose) &&
    typeof grant.mode === "string" &&
    ACCESS_MODES.has(grant.mode) &&
    typeof grant.status === "string" &&
    ACCESS_STATUSES.has(grant.status)
  );
}

function isDelegationContract(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const contract = value as Record<string, unknown>;
  const boundaries = contract.operatingBoundaries as Record<string, unknown> | undefined;
  return (
    isNonEmptyStringArray(contract.stakeholders) &&
    isNonEmptyStringArray(contract.goals) &&
    isNonEmptyStringArray(contract.preferences) &&
    Array.isArray(contract.access) &&
    contract.access.length > 0 &&
    contract.access.every(isAccessGrant) &&
    !!boundaries &&
    typeof boundaries === "object" &&
    isNonEmptyStringArray(boundaries.canDo) &&
    isNonEmptyStringArray(boundaries.requiresApproval) &&
    isNonEmptyStringArray(boundaries.neverDo) &&
    isNonEmptyStringArray(contract.telemetry)
  );
}

function isSuccessMetric(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const metric = value as Record<string, unknown>;
  return isNonEmptyString(metric.label) && isNonEmptyString(metric.target);
}

function isWorkstream(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const stream = value as Record<string, unknown>;
  return (
    isNonEmptyString(stream.id) &&
    isNonEmptyString(stream.title) &&
    isNonEmptyString(stream.outcome) &&
    isNonEmptyStringArray(stream.weeklySteps)
  );
}

function isPilotPlan(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  return (
    typeof plan.durationDays === "number" &&
    Number.isFinite(plan.durationDays) &&
    plan.durationDays > 0 &&
    plan.durationDays <= 45 &&
    isNonEmptyString(plan.projectName) &&
    isNonEmptyString(plan.heartbeatCadence) &&
    Array.isArray(plan.successMetrics) &&
    plan.successMetrics.length > 0 &&
    plan.successMetrics.every(isSuccessMetric) &&
    Array.isArray(plan.workstreams) &&
    plan.workstreams.length > 0 &&
    plan.workstreams.every(isWorkstream) &&
    isNonEmptyStringArray(plan.approvalGates)
  );
}

export function isCosPilotProposalPayload(
  value: unknown,
): value is CosPilotProposalV1Payload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  return (
    isNonEmptyString(payload.rationale) &&
    isDelegationContract(payload.delegationContract) &&
    isPilotPlan(payload.pilotPlan)
  );
}
