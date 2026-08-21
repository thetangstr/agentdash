export const EXECOS_VOICE_TURN_AUDIT_MARKER = "EXECOS_VOICE_TURN_AUDIT_V1" as const;

export interface ExecOsVoiceTurnAuditComment {
  version: "execos.voice.turn.v1";
  voiceSessionId: string;
  voiceTurnId: string;
  deviceId: string;
  participantId: string;
  workerId: string;
  requestId: string;
  correlationId: string;
  issueId: string;
  issueRef: string;
  runId: string;
  commentId: string;
  tool: "ask_project_lead";
  toolArgumentsSha256: string;
  userTranscript: ExecOsVoiceExcerpt;
  spokenResponse: ExecOsVoiceExcerpt;
  events: ExecOsVoiceTurnEvent[];
  terminalStatus: "completed" | "cannot_answer" | "failed";
  createdAt: string;
}

export interface ExecOsVoiceExcerpt {
  excerpt: string;
  sha256: string;
  byteSize: number;
}

export interface ExecOsVoiceTurnEvent {
  type:
    | "connected"
    | "transcript_final"
    | "tool_started"
    | "tool_finished"
    | "speech_started"
    | "speech_finished"
    | "muted"
    | "unmuted"
    | "reconnecting"
    | "reconnected"
    | "disconnected";
  occurredAt: string;
}

export interface ExecOsVoiceTurnAuditView {
  session: { id: string; deviceId: string };
  turn: { id: string; status: ExecOsVoiceTurnAuditComment["terminalStatus"]; createdAt: string };
  transcript: ExecOsVoiceExcerpt;
  response: ExecOsVoiceExcerpt;
  tool: { name: "ask_project_lead"; argumentsSha256: string };
  refs: {
    requestId: string;
    correlationId: string;
    issueId: string;
    issueRef: string;
    runId: string;
    resultCommentId: string;
    voiceAuditCommentId: string;
  };
  timeline: ExecOsVoiceTurnEvent[];
  participant: { pseudonym: string };
  worker: { pseudonym: string };
  rawAudioStored: false;
  rawAudioBoundary: "raw-audio-not-stored";
}

interface ExecutionAuditV1 {
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

export function serializeExecOsVoiceTurnAuditComment(audit: ExecOsVoiceTurnAuditComment): string {
  return `${EXECOS_VOICE_TURN_AUDIT_MARKER}\n${canonicalJson(audit as unknown as Record<string, unknown>)}`;
}

export function projectExecOsVoiceTurnAudit(input: {
  executionAuditResultJson: unknown;
  issue: { id: string; ref?: string | null };
  run: { id: string };
  comments: Array<{ id: string; body: string }>;
}): ExecOsVoiceTurnAuditView | null {
  const executionAudit = validateExecutionAuditFromResult(input.executionAuditResultJson);
  if (!executionAudit) return null;
  for (const comment of input.comments) {
    const audit = parseVoiceAuditComment(comment.body);
    if (!audit) continue;
    if (!matchesExecutionAudit(audit, executionAudit, input.issue, input.run, input.comments, comment.id)) continue;
    return {
      session: { id: audit.voiceSessionId, deviceId: audit.deviceId },
      turn: { id: audit.voiceTurnId, status: audit.terminalStatus, createdAt: audit.createdAt },
      transcript: audit.userTranscript,
      response: audit.spokenResponse,
      tool: { name: audit.tool, argumentsSha256: audit.toolArgumentsSha256 },
      refs: {
        requestId: audit.requestId,
        correlationId: audit.correlationId,
        issueId: audit.issueId,
        issueRef: audit.issueRef,
        runId: audit.runId,
        resultCommentId: audit.commentId,
        voiceAuditCommentId: comment.id,
      },
      timeline: audit.events,
      participant: { pseudonym: pseudonym("participant", audit.participantId) },
      worker: { pseudonym: pseudonym("worker", audit.workerId) },
      rawAudioStored: false,
      rawAudioBoundary: "raw-audio-not-stored",
    };
  }
  return null;
}

function parseVoiceAuditComment(body: string): ExecOsVoiceTurnAuditComment | null {
  if (typeof body !== "string") return null;
  const lines = body.split("\n");
  if (lines.length !== 2 || lines[0] !== EXECOS_VOICE_TURN_AUDIT_MARKER || lines[1].trim() !== lines[1] || !lines[1]) {
    return null;
  }
  try {
    return validateVoiceAudit(JSON.parse(lines[1]));
  } catch {
    return null;
  }
}

function validateVoiceAudit(input: unknown): ExecOsVoiceTurnAuditComment | null {
  const obj = asRecord(input);
  if (!obj) return null;
  const allowed = [
    "version",
    "voiceSessionId",
    "voiceTurnId",
    "deviceId",
    "participantId",
    "workerId",
    "requestId",
    "correlationId",
    "issueId",
    "issueRef",
    "runId",
    "commentId",
    "tool",
    "toolArgumentsSha256",
    "userTranscript",
    "spokenResponse",
    "events",
    "terminalStatus",
    "createdAt",
  ];
  if (!hasOnlyKeys(obj, allowed)) return null;
  if (obj.version !== "execos.voice.turn.v1" || obj.tool !== "ask_project_lead") return null;
  for (const key of ["voiceSessionId", "voiceTurnId", "deviceId", "participantId", "workerId", "requestId", "correlationId", "issueId", "issueRef", "runId", "commentId", "createdAt"] as const) {
    if (!text(obj[key])) return null;
  }
  if (!hash(obj.toolArgumentsSha256)) return null;
  const userTranscript = validateExcerpt(obj.userTranscript);
  const spokenResponse = validateExcerpt(obj.spokenResponse);
  const events = validateEvents(obj.events);
  if (!userTranscript || !spokenResponse || !events) return null;
  if (obj.terminalStatus !== "completed" && obj.terminalStatus !== "cannot_answer" && obj.terminalStatus !== "failed") return null;
  if (!iso(obj.createdAt)) return null;
  return {
    version: "execos.voice.turn.v1",
    voiceSessionId: obj.voiceSessionId as string,
    voiceTurnId: obj.voiceTurnId as string,
    deviceId: obj.deviceId as string,
    participantId: obj.participantId as string,
    workerId: obj.workerId as string,
    requestId: obj.requestId as string,
    correlationId: obj.correlationId as string,
    issueId: obj.issueId as string,
    issueRef: obj.issueRef as string,
    runId: obj.runId as string,
    commentId: obj.commentId as string,
    tool: "ask_project_lead",
    toolArgumentsSha256: obj.toolArgumentsSha256 as string,
    userTranscript,
    spokenResponse,
    events,
    terminalStatus: obj.terminalStatus as ExecOsVoiceTurnAuditComment["terminalStatus"],
    createdAt: obj.createdAt as string,
  };
}

function validateExecutionAuditFromResult(input: unknown): ExecutionAuditV1 | null {
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
    terminalStatus: audit.terminalStatus as ExecutionAuditV1["terminalStatus"],
    acceptedAt: audit.acceptedAt as string,
    ...(audit.completedAt === undefined ? {} : { completedAt: audit.completedAt as string }),
    ...(audit.directAnswer === undefined ? {} : { directAnswer: audit.directAnswer as string }),
    ...(cannotAnswer === undefined ? {} : { cannotAnswer }),
    unsupported,
  };
}

function matchesExecutionAudit(
  audit: ExecOsVoiceTurnAuditComment,
  executionAudit: ExecutionAuditV1,
  issue: { id: string; ref?: string | null },
  run: { id: string },
  comments: Array<{ id: string; body: string }>,
  voiceCommentId: string,
): boolean {
  if (audit.requestId !== executionAudit.request.id) return false;
  if (audit.correlationId !== executionAudit.request.correlationId) return false;
  if (audit.issueId !== issue.id) return false;
  if (audit.issueRef !== (issue.ref ?? issue.id)) return false;
  if (audit.runId !== run.id) return false;
  if (audit.terminalStatus !== executionAudit.terminalStatus) return false;
  if (!comments.some((comment) => comment.id === audit.commentId && comment.id !== voiceCommentId)) return false;
  if (!executionAudit.runs.some((candidate) => candidate.track === "agentdash" && candidate.runId === audit.runId)) return false;
  const expectedSourceRef = agentDashSourceRef(audit.issueId, audit.runId);
  if (!executionAudit.events.some((event) => (
    event.requestId === audit.requestId &&
    event.runId === audit.runId &&
    event.track === "agentdash" &&
    event.type === "accepted" &&
    event.sourceRef === expectedSourceRef
  ))) return false;
  return executionAudit.evidence.some((evidence) => (
    evidence.requestId === audit.requestId &&
    evidence.runId === audit.runId &&
    evidence.track === "agentdash" &&
    evidence.sourceRef === expectedSourceRef
  ));
}

function validateExecutionRequest(input: unknown): ExecutionAuditV1["request"] | null {
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
  } as ExecutionAuditV1["request"];
}

function validateScope(input: unknown): ExecutionAuditV1["request"]["scope"] | null {
  const obj = asRecord(input);
  if (!obj || !hasOnlyKeys(obj, ["readOnly", "paths", "repos"]) || typeof obj.readOnly !== "boolean") return null;
  if (!stringArray(obj.paths) || !stringArray(obj.repos)) return null;
  return { readOnly: obj.readOnly, paths: obj.paths, repos: obj.repos };
}

function validateExecutionRuns(input: unknown): ExecutionAuditV1["runs"] | null {
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
    } as ExecutionAuditV1["runs"][number];
  });
  return rows.every((row): row is ExecutionAuditV1["runs"][number] => row !== null) ? rows : null;
}

function validateExecutionEvents(input: unknown): ExecutionAuditV1["events"] | null {
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
    } as ExecutionAuditV1["events"][number];
  });
  return rows.every((row): row is ExecutionAuditV1["events"][number] => row !== null) ? rows : null;
}

function validateExecutionEvidence(input: unknown): ExecutionAuditV1["evidence"] | null {
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
    } as ExecutionAuditV1["evidence"][number];
  });
  return rows.every((row): row is ExecutionAuditV1["evidence"][number] => row !== null) ? rows : null;
}

function validateActor(input: unknown): { actorType: string; actorId: string } | null {
  const obj = asRecord(input);
  if (!obj || !hasOnlyKeys(obj, ["actorType", "actorId"]) || !member(obj.actorType, REQUEST_ACTOR_TYPES) || !text(obj.actorId)) return null;
  return { actorType: obj.actorType, actorId: obj.actorId };
}

function validateRuntime(input: unknown): ExecutionAuditV1["runtimeIdentity"] | null {
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
  runs: ExecutionAuditV1["runs"],
  events: ExecutionAuditV1["events"],
  evidence: ExecutionAuditV1["evidence"],
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
  runs: ExecutionAuditV1["runs"],
  events: ExecutionAuditV1["events"],
  evidence: ExecutionAuditV1["evidence"],
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

function validateExcerpt(input: unknown): ExecOsVoiceExcerpt | null {
  const obj = asRecord(input);
  if (!obj || !hasOnlyKeys(obj, ["excerpt", "sha256", "byteSize"])) return null;
  if (!text(obj.excerpt) || !hash(obj.sha256) || !Number.isSafeInteger(obj.byteSize) || (obj.byteSize as number) < 0) return null;
  return { excerpt: obj.excerpt as string, sha256: obj.sha256 as string, byteSize: obj.byteSize as number };
}

function validateEvents(input: unknown): ExecOsVoiceTurnEvent[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const events: ExecOsVoiceTurnEvent[] = [];
  let previous = -Infinity;
  const seen = new Set<string>();
  for (const item of input) {
    const obj = asRecord(item);
    if (!obj || !hasOnlyKeys(obj, ["type", "occurredAt"]) || !text(obj.type) || !iso(obj.occurredAt)) return null;
    const type = obj.type as ExecOsVoiceTurnEvent["type"];
    if (![
      "connected",
      "transcript_final",
      "tool_started",
      "tool_finished",
      "speech_started",
      "speech_finished",
      "muted",
      "unmuted",
      "reconnecting",
      "reconnected",
      "disconnected",
    ].includes(type)) return null;
    const occurredAt = obj.occurredAt as string;
    const current = Date.parse(occurredAt);
    const dedupeKey = `${type}\0${occurredAt}`;
    if (current < previous || seen.has(dedupeKey)) return null;
    previous = current;
    seen.add(dedupeKey);
    events.push({ type, occurredAt });
  }
  return events;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = asRecord(value);
  if (obj) {
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

function agentDashSourceRef(issueId: string, runId: string): string {
  return `paperclip://issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}`;
}

function pseudonym(prefix: string, value: string): string {
  return `${prefix}:${value.slice(0, 15)}`;
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
