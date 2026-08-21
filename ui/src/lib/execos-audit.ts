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
