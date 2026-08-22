export interface ExecOsExecutionAuditV1 {
  request: {
    id: string;
    correlationId: string;
    project: string;
    question: string;
    expectedOutput: string;
    classification: string;
    scope: { readOnly: boolean; paths: string[]; repos: string[] };
    requestedBy: { actorType: string; actorId: string };
    createdAt: string;
  };
  runs: Array<{
    runId: string;
    track: "agentdash" | "local_claude";
    adapterId: string;
    runtimeId: string;
    actor: { actorType: string; actorId: string };
    startedAt: string;
    completedAt?: string;
  }>;
  events: Array<{
    id: string;
    requestId: string;
    runId: string;
    track: "agentdash" | "local_claude";
    adapterId: string;
    type: string;
    occurredAt: string;
    sourceRef: string;
    payload: Record<string, unknown>;
  }>;
  evidence: Array<{
    id: string;
    requestId: string;
    runId: string;
    track: "agentdash" | "local_claude";
    adapterId: string;
    kind: string;
    summary: string;
    sourceRef: string;
    observedAt: string;
    method: string;
    byteSize: number;
    sha256: string;
    truncated: boolean;
    sourceUrl?: string;
    excerpt?: string;
  }>;
  actorIdentity: { actorType: string; actorId: string };
  runtimeIdentity: { track: "agentdash" | "local_claude"; adapterId: string; runtimeId: string };
  terminalStatus: "completed" | "cannot_answer" | "blocked_pending_approval" | "failed" | "unsupported";
  acceptedAt: string;
  completedAt?: string;
  directAnswer?: string;
  cannotAnswer?: { reason: string; at: string };
  unsupported: Array<Record<string, unknown>>;
}

const EXECUTION_TRACKS = ["agentdash", "local_claude"] as const;
const ACTION_CLASSIFICATIONS = ["routine_read_only", "destructive", "credentialed", "external", "high_impact", "unknown"] as const;
const REQUEST_ACTOR_TYPES = ["ceo", "execos", "agentdash_agent"] as const;
const EXECUTION_STATUSES = ["accepted", "started", "evidence_created", "completed", "cannot_answer", "blocked_pending_approval", "failed", "unsupported"] as const;
const TERMINAL_EXECUTION_STATUSES = ["completed", "cannot_answer", "blocked_pending_approval", "failed", "unsupported"] as const;
const EVIDENCE_METHODS = ["read", "derived", "reported"] as const;
const REQUIRED_UNSUPPORTED = [
  { adapterId: "hermes", capability: "execution", targetRef: "hermes", status: "unsupported" },
  { adapterId: "hermes", capability: "direct_session_control", targetRef: "hermes", status: "unsupported" },
  { adapterId: "execos-0", capability: "observed_pane_control", targetRef: "%0", status: "unsupported" },
] as const;

export function parseExecOsExecutionAuditV1FromResult(input: unknown): ExecOsExecutionAuditV1 | null {
  const result = asRecord(input);
  const audit = asRecord(result?.audit);
  if (!audit || !hasOnlyKeys(audit, [
    "request",
    "runs",
    "events",
    "evidence",
    "actorIdentity",
    "runtimeIdentity",
    "terminalStatus",
    "acceptedAt",
    "completedAt",
    "directAnswer",
    "cannotAnswer",
    "unsupported",
  ])) return null;
  const request = validateExecutionRequest(audit.request);
  const runs = validateExecutionRuns(audit.runs);
  const events = validateExecutionEvents(audit.events);
  const evidence = validateExecutionEvidence(audit.evidence);
  const actorIdentity = validateActor(audit.actorIdentity);
  const runtimeIdentity = validateRuntime(audit.runtimeIdentity);
  const unsupported = Array.isArray(audit.unsupported) && audit.unsupported.every((row) => !!asRecord(row))
    ? validateUnsupported(audit.unsupported)
    : null;
  if (!request || !runs || !events || !evidence || !actorIdentity || !runtimeIdentity || !unsupported) return null;
  if (!["completed", "cannot_answer", "blocked_pending_approval", "failed", "unsupported"].includes(String(audit.terminalStatus))) return null;
  if (!iso(audit.acceptedAt) || (audit.completedAt !== undefined && !iso(audit.completedAt))) return null;
  if (audit.directAnswer !== undefined && !text(audit.directAnswer)) return null;
  let cannotAnswer: { reason: string; at: string } | undefined;
  if (audit.cannotAnswer !== undefined) {
    const parsed = validateCannotAnswer(audit.cannotAnswer);
    if (!parsed) return null;
    cannotAnswer = parsed;
  }
  if (!runs.some((run) => run.track === "agentdash") || !runs.some((run) => run.track === "local_claude")) return null;
  if (!events.some((event) => event.track === "agentdash") || !events.some((event) => event.track === "local_claude")) return null;
  if (!evidence.some((row) => row.track === "agentdash") || !evidence.some((row) => row.track === "local_claude")) return null;
  if (!validateEventEvidenceBindings(request.id, runs, events, evidence)) return null;
  if (!runs.some((run) => (
    run.track === runtimeIdentity.track &&
    run.adapterId === runtimeIdentity.adapterId &&
    run.runtimeId === runtimeIdentity.runtimeId &&
    run.actor.actorType === actorIdentity.actorType &&
    run.actor.actorId === actorIdentity.actorId
  ))) return null;
  if (!validateChronology(request.createdAt, audit.acceptedAt as string, audit.completedAt, runs, events, evidence)) return null;
  if (!validateTerminalAnswerInvariant(audit.terminalStatus, audit.directAnswer, cannotAnswer)) return null;
  return {
    request,
    runs,
    events,
    evidence,
    actorIdentity,
    runtimeIdentity,
    terminalStatus: audit.terminalStatus as ExecOsExecutionAuditV1["terminalStatus"],
    acceptedAt: audit.acceptedAt as string,
    ...(audit.completedAt === undefined ? {} : { completedAt: audit.completedAt as string }),
    ...(audit.directAnswer === undefined ? {} : { directAnswer: audit.directAnswer as string }),
    ...(cannotAnswer === undefined ? {} : { cannotAnswer }),
    unsupported,
  };
}

export function agentDashExecutionSourceRef(issueId: string, runId: string): string {
  return `paperclip://issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}`;
}

function validateExecutionRequest(input: unknown): ExecOsExecutionAuditV1["request"] | null {
  const obj = asRecord(input);
  if (!obj || !hasOnlyKeys(obj, ["id", "correlationId", "project", "question", "expectedOutput", "classification", "scope", "requestedBy", "createdAt"])) return null;
  const scope = validateScope(obj.scope);
  const requestedBy = validateActor(obj.requestedBy);
  if (!text(obj.id) || !text(obj.correlationId) || obj.project !== "kiddoquest" || !text(obj.question)) return null;
  if (obj.expectedOutput !== "direct_answer_with_evidence" || !member(obj.classification, ACTION_CLASSIFICATIONS) || !scope || !requestedBy || !iso(obj.createdAt)) return null;
  return {
    id: obj.id,
    correlationId: obj.correlationId,
    project: obj.project,
    question: obj.question,
    expectedOutput: obj.expectedOutput,
    classification: obj.classification,
    scope,
    requestedBy,
    createdAt: obj.createdAt,
  } as ExecOsExecutionAuditV1["request"];
}

function validateScope(input: unknown): ExecOsExecutionAuditV1["request"]["scope"] | null {
  const obj = asRecord(input);
  if (!obj || !hasOnlyKeys(obj, ["readOnly", "paths", "repos"]) || typeof obj.readOnly !== "boolean") return null;
  if (!stringArray(obj.paths) || !stringArray(obj.repos)) return null;
  return { readOnly: obj.readOnly, paths: obj.paths, repos: obj.repos };
}

function validateExecutionRuns(input: unknown): ExecOsExecutionAuditV1["runs"] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const seen = new Set<string>();
  const rows = input.map((row) => {
    const obj = asRecord(row);
    if (!obj || !hasOnlyKeys(obj, ["runId", "track", "adapterId", "runtimeId", "actor", "startedAt", "completedAt"])) return null;
    const actor = validateActor(obj.actor);
    if (!text(obj.runId) || !track(obj.track) || !text(obj.adapterId) || !text(obj.runtimeId) || !actor || !iso(obj.startedAt)) return null;
    if (obj.completedAt !== undefined && !iso(obj.completedAt)) return null;
    if (seen.has(obj.runId)) return null;
    seen.add(obj.runId);
    return {
      runId: obj.runId,
      track: obj.track,
      adapterId: obj.adapterId,
      runtimeId: obj.runtimeId,
      actor,
      startedAt: obj.startedAt,
      ...(obj.completedAt === undefined ? {} : { completedAt: obj.completedAt }),
    } as ExecOsExecutionAuditV1["runs"][number];
  });
  return rows.every((row): row is ExecOsExecutionAuditV1["runs"][number] => row !== null) ? rows : null;
}

function validateExecutionEvents(input: unknown): ExecOsExecutionAuditV1["events"] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const seen = new Set<string>();
  const rows = input.map((row) => {
    const obj = asRecord(row);
    if (!obj || !hasOnlyKeys(obj, ["id", "requestId", "runId", "track", "adapterId", "type", "occurredAt", "sourceRef", "payload"])) return null;
    const payload = asRecord(obj.payload);
    if (!text(obj.id) || !text(obj.requestId) || !text(obj.runId) || !track(obj.track) || !text(obj.adapterId)) return null;
    if (!member(obj.type, EXECUTION_STATUSES) || !iso(obj.occurredAt) || !text(obj.sourceRef) || !payload) return null;
    if (seen.has(obj.id)) return null;
    seen.add(obj.id);
    return {
      id: obj.id,
      requestId: obj.requestId,
      runId: obj.runId,
      track: obj.track,
      adapterId: obj.adapterId,
      type: obj.type,
      occurredAt: obj.occurredAt,
      sourceRef: obj.sourceRef,
      payload,
    } as ExecOsExecutionAuditV1["events"][number];
  });
  return rows.every((row): row is ExecOsExecutionAuditV1["events"][number] => row !== null) ? rows : null;
}

function validateExecutionEvidence(input: unknown): ExecOsExecutionAuditV1["evidence"] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const seen = new Set<string>();
  const rows = input.map((row) => {
    const obj = asRecord(row);
    if (!obj || !hasOnlyKeys(obj, ["id", "requestId", "runId", "track", "adapterId", "kind", "summary", "sourceRef", "observedAt", "method", "byteSize", "sha256", "truncated", "sourceUrl", "excerpt"])) return null;
    if (!text(obj.id) || !text(obj.requestId) || !text(obj.runId) || !track(obj.track) || !text(obj.adapterId)) return null;
    if (!text(obj.kind) || !text(obj.summary) || !text(obj.sourceRef) || !iso(obj.observedAt) || !member(obj.method, EVIDENCE_METHODS)) return null;
    if (!Number.isSafeInteger(obj.byteSize) || (obj.byteSize as number) < 0 || !hash(obj.sha256) || typeof obj.truncated !== "boolean") return null;
    if (obj.sourceUrl !== undefined && !text(obj.sourceUrl)) return null;
    if (obj.excerpt !== undefined && !text(obj.excerpt)) return null;
    if (seen.has(obj.id)) return null;
    seen.add(obj.id);
    return {
      id: obj.id,
      requestId: obj.requestId,
      runId: obj.runId,
      track: obj.track,
      adapterId: obj.adapterId,
      kind: obj.kind,
      summary: obj.summary,
      sourceRef: obj.sourceRef,
      observedAt: obj.observedAt,
      method: obj.method,
      byteSize: obj.byteSize,
      sha256: obj.sha256,
      truncated: obj.truncated,
      ...(obj.sourceUrl === undefined ? {} : { sourceUrl: obj.sourceUrl }),
      ...(obj.excerpt === undefined ? {} : { excerpt: obj.excerpt }),
    } as ExecOsExecutionAuditV1["evidence"][number];
  });
  return rows.every((row): row is ExecOsExecutionAuditV1["evidence"][number] => row !== null) ? rows : null;
}

function validateActor(input: unknown): { actorType: string; actorId: string } | null {
  const obj = asRecord(input);
  if (!obj || !hasOnlyKeys(obj, ["actorType", "actorId"]) || !member(obj.actorType, REQUEST_ACTOR_TYPES) || !text(obj.actorId)) return null;
  return { actorType: obj.actorType, actorId: obj.actorId };
}

function validateRuntime(input: unknown): ExecOsExecutionAuditV1["runtimeIdentity"] | null {
  const obj = asRecord(input);
  if (!obj || !hasOnlyKeys(obj, ["track", "adapterId", "runtimeId"]) || !track(obj.track) || !text(obj.adapterId) || !text(obj.runtimeId)) return null;
  return { track: obj.track, adapterId: obj.adapterId, runtimeId: obj.runtimeId };
}

function validateCannotAnswer(input: unknown): { reason: string; at: string } | null {
  const obj = asRecord(input);
  if (!obj || !hasOnlyKeys(obj, ["reason", "at"]) || !text(obj.reason) || !iso(obj.at)) return null;
  return { reason: obj.reason, at: obj.at };
}

function validateUnsupported(input: unknown[]): Array<Record<string, unknown>> | null {
  const rows: Array<Record<string, unknown>> = [];
  for (const row of input) {
    const obj = asRecord(row);
    if (!obj || !hasOnlyKeys(obj, ["adapterId", "track", "capability", "targetRef", "status", "reason"])) return null;
    if (!text(obj.adapterId) || !track(obj.track) || !member(obj.capability, ["execution", "direct_session_control", "observed_pane_control"] as const)) return null;
    if (!text(obj.targetRef) || obj.status !== "unsupported" || !text(obj.reason)) return null;
    rows.push(obj);
  }
  for (const required of REQUIRED_UNSUPPORTED) {
    if (!rows.some((row) => (
      row.adapterId === required.adapterId &&
      row.capability === required.capability &&
      row.targetRef === required.targetRef &&
      row.status === required.status
    ))) return null;
  }
  return rows;
}

function validateEventEvidenceBindings(
  requestId: string,
  runs: ExecOsExecutionAuditV1["runs"],
  events: ExecOsExecutionAuditV1["events"],
  evidence: ExecOsExecutionAuditV1["evidence"],
): boolean {
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  for (const event of events) {
    if (event.requestId !== requestId) return false;
    const run = runsById.get(event.runId);
    if (!run || run.track !== event.track || run.adapterId !== event.adapterId) return false;
  }
  for (const row of evidence) {
    if (row.requestId !== requestId) return false;
    const run = runsById.get(row.runId);
    if (!run || run.track !== row.track || run.adapterId !== row.adapterId) return false;
  }
  return true;
}

function validateChronology(
  requestCreatedAt: string,
  acceptedAt: string,
  completedAt: unknown,
  runs: ExecOsExecutionAuditV1["runs"],
  events: ExecOsExecutionAuditV1["events"],
  evidence: ExecOsExecutionAuditV1["evidence"],
): boolean {
  const requestCreated = Date.parse(requestCreatedAt);
  const accepted = Date.parse(acceptedAt);
  const completed = completedAt === undefined ? null : Date.parse(completedAt as string);
  if (requestCreated > accepted || (completed !== null && accepted > completed)) return false;
  for (const run of runs) {
    const started = Date.parse(run.startedAt);
    if (started < accepted || (completed !== null && started > completed)) return false;
    if (run.completedAt !== undefined) {
      const runCompleted = Date.parse(run.completedAt);
      if (started > runCompleted || runCompleted < accepted || (completed !== null && runCompleted > completed)) return false;
    }
  }
  for (const event of events) {
    const occurred = Date.parse(event.occurredAt);
    if (occurred < accepted || (completed !== null && occurred > completed)) return false;
  }
  for (const row of evidence) {
    const observed = Date.parse(row.observedAt);
    if (observed < accepted || (completed !== null && observed > completed)) return false;
  }
  return true;
}

function validateTerminalAnswerInvariant(
  terminalStatus: unknown,
  directAnswer: unknown,
  cannotAnswer: { reason: string; at: string } | undefined,
): boolean {
  if (!member(terminalStatus, TERMINAL_EXECUTION_STATUSES)) return false;
  if (terminalStatus === "completed") return text(directAnswer) && cannotAnswer === undefined;
  if (terminalStatus === "cannot_answer") return directAnswer === undefined && cannotAnswer !== undefined;
  return directAnswer === undefined && cannotAnswer === undefined;
}

function hasOnlyKeys(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(obj).every((key) => allowed.has(key));
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text);
}

function track(value: unknown): value is "agentdash" | "local_claude" {
  return member(value, EXECUTION_TRACKS);
}

function member<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 2000;
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function iso(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value);
}
