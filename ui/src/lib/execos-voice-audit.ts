import {
  agentDashExecutionSourceRef,
  parseExecOsExecutionAuditV1FromResult,
  type ExecOsExecutionAuditV1,
} from "./execos-audit";

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

export interface ExecOsVoiceAuditCommentRecord {
  id: string;
  body: string;
  authorAgentId: string | null;
  createdByRunId: string | null;
}

export function serializeExecOsVoiceTurnAuditComment(audit: ExecOsVoiceTurnAuditComment): string {
  return `${EXECOS_VOICE_TURN_AUDIT_MARKER}\n${canonicalJson(audit as unknown as Record<string, unknown>)}`;
}

export function projectExecOsVoiceTurnAudit(input: {
  executionAuditResultJson: unknown;
  issue: { id: string; ref?: string | null };
  run: { id: string };
  comments: ExecOsVoiceAuditCommentRecord[];
}): ExecOsVoiceTurnAuditView | null {
  const executionAudit = parseExecOsExecutionAuditV1FromResult(input.executionAuditResultJson);
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

function matchesExecutionAudit(
  audit: ExecOsVoiceTurnAuditComment,
  executionAudit: ExecOsExecutionAuditV1,
  issue: { id: string; ref?: string | null },
  run: { id: string },
  comments: ExecOsVoiceAuditCommentRecord[],
  voiceCommentId: string,
): boolean {
  if (audit.requestId !== executionAudit.request.id) return false;
  if (audit.correlationId !== executionAudit.request.correlationId) return false;
  if (audit.issueId !== issue.id) return false;
  if (audit.issueRef !== (issue.ref ?? issue.id)) return false;
  if (audit.runId !== run.id) return false;
  if (audit.terminalStatus !== executionAudit.terminalStatus) return false;
  const agentDashRun = executionAudit.runs.find((candidate) => candidate.track === "agentdash" && candidate.runId === audit.runId);
  if (!agentDashRun || agentDashRun.actor.actorType !== "agentdash_agent") return false;
  const resultComment = comments.find((comment) => comment.id === audit.commentId && comment.id !== voiceCommentId);
  const voiceComment = comments.find((comment) => comment.id === voiceCommentId);
  if (!resultComment || !voiceComment) return false;
  if (!matchesAgentDashCommentProvenance(resultComment, agentDashRun.actor.actorId, audit.runId)) return false;
  if (!matchesAgentDashCommentProvenance(voiceComment, agentDashRun.actor.actorId, audit.runId)) return false;
  const expectedSourceRef = agentDashExecutionSourceRef(audit.issueId, audit.runId);
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

function matchesAgentDashCommentProvenance(
  comment: ExecOsVoiceAuditCommentRecord,
  actorId: string,
  runId: string,
): boolean {
  return comment.authorAgentId === actorId && comment.createdByRunId === runId;
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
