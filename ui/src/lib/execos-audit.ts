import {
  parseExecOsExecutionAuditV1FromResult,
  type ExecOsExecutionAuditV1,
} from "./execos-execution-audit-contract";

export {
  agentDashExecutionSourceRef,
  parseExecOsExecutionAuditV1FromResult,
  type ExecOsExecutionAuditV1,
} from "./execos-execution-audit-contract";

export interface ExecOsAuditEvidence {
  kind: string;
  summary: string;
  sourceRef: string;
  observedAt: string;
  byteSize: number;
  sha256: string;
}

export interface ExecOsAuditTransition {
  status: string;
  occurredAt: string;
  sourceRef: string;
}

export interface ExecOsUnsupportedCapability {
  adapterId: string;
  capability: string;
  targetRef: string;
  reason: string;
}

export interface ExecOsAuditView {
  requestId: string;
  correlationId: string;
  question: string;
  status: string;
  answer: string;
  answerKind: "direct" | "cannot_answer";
  actor: string;
  runtime: string;
  runtimeId: string;
  paneId: string | null;
  acceptedAt: string;
  completedAt: string | null;
  evidence: ExecOsAuditEvidence[];
  transitions: ExecOsAuditTransition[];
  unsupported: ExecOsUnsupportedCapability[];
}

export function projectExecOsAudit(resultJson: unknown): ExecOsAuditView | null {
  const strictAudit = parseExecOsExecutionAuditV1FromResult(resultJson);
  if (strictAudit) {
    const strictView = projectStrictAudit(strictAudit);
    if (strictView) return strictView;
  }

  const result = asRecord(resultJson);
  const audit = asRecord(result?.audit);
  const request = asRecord(audit?.request);
  const actor = asRecord(audit?.actorIdentity);
  const runtime = asRecord(audit?.runtimeIdentity);
  if (!audit || !request || !actor || !runtime) return null;

  const requestId = text(request.id);
  const correlationId = text(request.correlationId);
  const question = text(request.question);
  const status = text(audit.terminalStatus);
  const actorType = text(actor.actorType);
  const actorId = text(actor.actorId);
  const track = text(runtime.track);
  const adapterId = text(runtime.adapterId);
  const runtimeId = text(runtime.runtimeId);
  const acceptedAt = text(audit.acceptedAt);
  const completedAt = optionalText(audit.completedAt);
  const directAnswer = optionalText(audit.directAnswer);
  const cannotAnswer = asRecord(audit.cannotAnswer);
  const cannotAnswerReason = optionalText(cannotAnswer?.reason);

  if (
    !requestId || !correlationId || !question || !status
    || !actorType || !actorId || !track || !adapterId || !runtimeId || !acceptedAt
  ) return null;
  if (!directAnswer && !cannotAnswerReason) return null;

  const evidence = projectArray(audit.evidence, projectEvidence);
  const transitions = projectArray(audit.events, projectTransition);
  const unsupported = projectArray(audit.unsupported, projectUnsupported);
  if (!evidence || !transitions || !unsupported) return null;

  const paneId = runtimeId.split(":").findLast((part) => /^%\d+$/u.test(part)) ?? null;
  return {
    requestId,
    correlationId,
    question,
    status,
    answer: directAnswer ?? cannotAnswerReason!,
    answerKind: directAnswer ? "direct" : "cannot_answer",
    actor: `${actorType}:${actorId}`,
    runtime: `${track}:${adapterId}`,
    runtimeId,
    paneId,
    acceptedAt,
    completedAt,
    evidence,
    transitions,
    unsupported,
  };
}

function projectStrictAudit(audit: ExecOsExecutionAuditV1): ExecOsAuditView | null {
  const answer = audit.directAnswer ?? audit.cannotAnswer?.reason;
  if (!answer) return null;
  const paneId = audit.runtimeIdentity.runtimeId.split(":").findLast((part) => /^%\d+$/u.test(part)) ?? null;
  return {
    requestId: audit.request.id,
    correlationId: audit.request.correlationId,
    question: audit.request.question,
    status: audit.terminalStatus,
    answer,
    answerKind: audit.directAnswer ? "direct" : "cannot_answer",
    actor: `${audit.actorIdentity.actorType}:${audit.actorIdentity.actorId}`,
    runtime: `${audit.runtimeIdentity.track}:${audit.runtimeIdentity.adapterId}`,
    runtimeId: audit.runtimeIdentity.runtimeId,
    paneId,
    acceptedAt: audit.acceptedAt,
    completedAt: audit.completedAt ?? null,
    evidence: audit.evidence.map((row) => ({
      kind: row.kind,
      summary: row.summary,
      sourceRef: row.sourceRef,
      observedAt: row.observedAt,
      byteSize: row.byteSize,
      sha256: row.sha256,
    })),
    transitions: audit.events.map((row) => ({
      status: row.type,
      occurredAt: row.occurredAt,
      sourceRef: row.sourceRef,
    })),
    unsupported: audit.unsupported.map((row) => ({
      adapterId: row.adapterId as string,
      capability: row.capability as string,
      targetRef: row.targetRef as string,
      reason: row.reason as string,
    })),
  };
}

function projectEvidence(value: unknown): ExecOsAuditEvidence | null {
  const row = asRecord(value);
  if (!row) return null;
  const kind = text(row.kind);
  const summary = text(row.summary);
  const sourceRef = text(row.sourceRef);
  const observedAt = text(row.observedAt);
  const sha256 = text(row.sha256);
  if (!kind || !summary || !sourceRef || !observedAt || !sha256 || !Number.isSafeInteger(row.byteSize)) return null;
  return { kind, summary, sourceRef, observedAt, byteSize: row.byteSize as number, sha256 };
}

function projectTransition(value: unknown): ExecOsAuditTransition | null {
  const row = asRecord(value);
  if (!row) return null;
  const status = text(row.type);
  const occurredAt = text(row.occurredAt);
  const sourceRef = text(row.sourceRef);
  return status && occurredAt && sourceRef ? { status, occurredAt, sourceRef } : null;
}

function projectUnsupported(value: unknown): ExecOsUnsupportedCapability | null {
  const row = asRecord(value);
  if (!row) return null;
  const adapterId = text(row.adapterId);
  const capability = text(row.capability);
  const targetRef = text(row.targetRef);
  const reason = text(row.reason);
  return adapterId && capability && targetRef && reason
    ? { adapterId, capability, targetRef, reason }
    : null;
}

function projectArray<T>(value: unknown, project: (row: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.map(project);
  return rows.every((row): row is T => row !== null) ? rows : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function optionalText(value: unknown): string | null {
  return value === undefined || value === null ? null : text(value);
}
