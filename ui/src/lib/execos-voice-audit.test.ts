import { describe, expect, it } from "vitest";
import { projectExecOsAudit } from "./execos-audit";
import {
  EXECOS_VOICE_TURN_AUDIT_MARKER,
  projectExecOsVoiceTurnAudit,
  serializeExecOsVoiceTurnAuditComment,
  type ExecOsVoiceTurnAuditComment,
} from "./execos-voice-audit";

const timestamp = "2026-08-21T08:00:00.000Z";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

const unsupported = [
  {
    adapterId: "hermes",
    track: "agentdash",
    capability: "execution",
    targetRef: "hermes",
    status: "unsupported",
    reason: "Hermes is observed through AgentDash evidence only; ExecOS does not execute work inside Hermes.",
  },
  {
    adapterId: "hermes",
    track: "agentdash",
    capability: "direct_session_control",
    targetRef: "hermes",
    status: "unsupported",
    reason: "Hermes direct-session control is outside the controlled execos-0 adapter surface.",
  },
  {
    adapterId: "execos-0",
    track: "local_claude",
    capability: "observed_pane_control",
    targetRef: "%0",
    status: "unsupported",
    reason: "Pane %0 is observed for evidence only; the controlled local adapter must not drive that pane.",
  },
];

function resultJson() {
  return {
    audit: {
      request: {
        id: "req_1",
        correlationId: "corr_1",
        project: "kiddoquest",
        question: "What is the current repository state?",
        expectedOutput: "direct_answer_with_evidence",
        classification: "routine_read_only",
        scope: { readOnly: true, paths: ["leads/kiddoquest"], repos: ["agent_bus"] },
        requestedBy: { actorType: "ceo", actorId: "ceo_1" },
        createdAt: timestamp,
      },
      runs: [
        {
          runId: "ad_run_1",
          track: "agentdash",
          adapterId: "execos_local",
          runtimeId: "agentdash-runtime:1",
          actor: { actorType: "agentdash_agent", actorId: "agent_1" },
          startedAt: timestamp,
          completedAt: timestamp,
        },
        {
          runId: "local_run_1",
          track: "local_claude",
          adapterId: "execos-0",
          runtimeId: "$0:@2:%2",
          actor: { actorType: "execos", actorId: "execos-0" },
          startedAt: timestamp,
          completedAt: timestamp,
        },
      ],
      events: [
        {
          id: "evt_1",
          requestId: "req_1",
          runId: "ad_run_1",
          track: "agentdash",
          adapterId: "execos_local",
          type: "accepted",
          occurredAt: timestamp,
          sourceRef: "paperclip://issues/issue_1/runs/ad_run_1",
          payload: {},
        },
        {
          id: "evt_2",
          requestId: "req_1",
          runId: "local_run_1",
          track: "local_claude",
          adapterId: "execos-0",
          type: "completed",
          occurredAt: timestamp,
          sourceRef: "tmux://execos-0/$0/@2/%2/stdout",
          payload: {},
        },
      ],
      evidence: [
        {
          id: "ev_1",
          requestId: "req_1",
          runId: "ad_run_1",
          track: "agentdash",
          adapterId: "execos_local",
          kind: "issue_comment",
          summary: "AgentDash result comment.",
          sourceRef: "paperclip://issues/issue_1/runs/ad_run_1",
          observedAt: timestamp,
          method: "reported",
          byteSize: 7,
          sha256: hashA,
          truncated: false,
        },
        {
          id: "ev_2",
          requestId: "req_1",
          runId: "local_run_1",
          track: "local_claude",
          adapterId: "execos-0",
          kind: "claude_stdout",
          summary: "Local stdout.",
          sourceRef: "tmux://execos-0/$0/@2/%2/stdout",
          observedAt: timestamp,
          method: "derived",
          byteSize: 20,
          sha256: hashB,
          truncated: false,
        },
      ],
      actorIdentity: { actorType: "execos", actorId: "execos-0" },
      runtimeIdentity: { track: "local_claude", adapterId: "execos-0", runtimeId: "$0:@2:%2" },
      terminalStatus: "completed",
      acceptedAt: timestamp,
      completedAt: timestamp,
      directAnswer: "commit abc123; tree clean",
      unsupported,
    },
  };
}

function voiceAudit(overrides: Partial<ExecOsVoiceTurnAuditComment> = {}): ExecOsVoiceTurnAuditComment {
  return {
    version: "execos.voice.turn.v1",
    voiceSessionId: "vs_12345678",
    voiceTurnId: "vt_12345678",
    deviceId: "android_pixel_1",
    participantId: "ceo_livekit_participant",
    workerId: "execos_voice_worker",
    requestId: "req_1",
    correlationId: "corr_1",
    issueId: "issue_1",
    issueRef: "AGE-1",
    runId: "ad_run_1",
    commentId: "comment_1",
    tool: "ask_project_lead",
    toolArgumentsSha256: hashC,
    userTranscript: { excerpt: "What changed?", sha256: hashA, byteSize: 13 },
    spokenResponse: { excerpt: "Shipped.", sha256: hashB, byteSize: 8 },
    events: [
      { type: "connected", occurredAt: timestamp },
      { type: "transcript_final", occurredAt: "2026-08-21T08:00:01.000Z" },
      { type: "tool_finished", occurredAt: "2026-08-21T08:00:02.000Z" },
    ],
    terminalStatus: "completed",
    createdAt: "2026-08-21T08:00:03.000Z",
    ...overrides,
  };
}

describe("projectExecOsVoiceTurnAudit", () => {
  it("projects one valid marked voice audit comment when an execution audit separately validates", () => {
    const result = resultJson();
    const executionAudit = projectExecOsAudit(result);
    const view = projectExecOsVoiceTurnAudit({
      executionAuditResultJson: result,
      issue: { id: "issue_1", ref: "AGE-1" },
      run: { id: "ad_run_1" },
      comments: [
        { id: "comment_1", body: "Normal result comment" },
        { id: "voice_comment_1", body: serializeExecOsVoiceTurnAuditComment(voiceAudit()) },
      ],
    });

    expect(view).toEqual({
      session: { id: "vs_12345678", deviceId: "android_pixel_1" },
      turn: { id: "vt_12345678", status: "completed", createdAt: "2026-08-21T08:00:03.000Z" },
      transcript: { excerpt: "What changed?", sha256: hashA, byteSize: 13 },
      response: { excerpt: "Shipped.", sha256: hashB, byteSize: 8 },
      tool: { name: "ask_project_lead", argumentsSha256: hashC },
      refs: {
        requestId: "req_1",
        correlationId: "corr_1",
        issueId: "issue_1",
        issueRef: "AGE-1",
        runId: "ad_run_1",
        resultCommentId: "comment_1",
        voiceAuditCommentId: "voice_comment_1",
      },
      timeline: [
        { type: "connected", occurredAt: timestamp },
        { type: "transcript_final", occurredAt: "2026-08-21T08:00:01.000Z" },
        { type: "tool_finished", occurredAt: "2026-08-21T08:00:02.000Z" },
      ],
      participant: { pseudonym: "participant:ceo_livekit_par" },
      worker: { pseudonym: "worker:execos_voice_wo" },
      rawAudioStored: false,
      rawAudioBoundary: "raw-audio-not-stored",
    });
  });

  it("rejects malformed JSON, unknown fields, unmarked comments, and absent execution audit", () => {
    expect(projectExecOsVoiceTurnAudit({
      executionAuditResultJson: resultJson(),
      issue: { id: "issue_1", ref: "AGE-1" },
      run: { id: "ad_run_1" },
      comments: [
        { id: "bad_json", body: `${EXECOS_VOICE_TURN_AUDIT_MARKER}\n{not json}` },
        { id: "unmarked", body: JSON.stringify(voiceAudit()) },
        { id: "unknown", body: serializeExecOsVoiceTurnAuditComment({ ...voiceAudit(), extra: "nope" } as ExecOsVoiceTurnAuditComment) },
      ],
    })).toBeNull();
    expect(projectExecOsVoiceTurnAudit({
      executionAuditResultJson: null,
      issue: { id: "issue_1", ref: "AGE-1" },
      run: { id: "ad_run_1" },
      comments: [{ id: "voice_comment_1", body: serializeExecOsVoiceTurnAuditComment(voiceAudit()) }],
    })).toBeNull();
  });

  it("rejects correlation mismatches and never sources voice fields from resultJson.audit", () => {
    const result = resultJson();
    const executionAudit = projectExecOsAudit(result);

    expect(projectExecOsVoiceTurnAudit({
      executionAuditResultJson: result,
      issue: { id: "issue_1", ref: "AGE-1" },
      run: { id: "ad_run_1" },
      comments: [
        { id: "comment_1", body: "Normal result comment" },
        { id: "voice_comment_1", body: serializeExecOsVoiceTurnAuditComment(voiceAudit({ requestId: "req_other" })) },
      ],
    })).toBeNull();

    expect(projectExecOsVoiceTurnAudit({
      executionAuditResultJson: result,
      issue: { id: "issue_1", ref: "AGE-1" },
      run: { id: "ad_run_1" },
      comments: [
        { id: "comment_1", body: "Normal result comment" },
        { id: "voice_comment_1", body: serializeExecOsVoiceTurnAuditComment(voiceAudit()) },
      ],
    })?.session.id).toBe("vs_12345678");
    expect(executionAudit?.requestId).toBe("req_1");
    expect(projectExecOsVoiceTurnAudit({
      executionAuditResultJson: result,
      issue: { id: "issue_1", ref: "AGE-1" },
      run: { id: "ad_run_1" },
      comments: [],
    })).toBeNull();
  });

  it("rejects missing required ExecutionAuditV1 fields before accepting a voice card", () => {
    const result = resultJson();
    Reflect.deleteProperty(result.audit.request, "expectedOutput");

    expect(projectExecOsVoiceTurnAudit({
      executionAuditResultJson: result,
      issue: { id: "issue_1", ref: "AGE-1" },
      run: { id: "ad_run_1" },
      comments: [
        { id: "comment_1", body: "Normal result comment" },
        { id: "voice_comment_1", body: serializeExecOsVoiceTurnAuditComment(voiceAudit()) },
      ],
    })).toBeNull();
  });

  it("treats right-request voice comments with wrong issue, run, or result comment as ordinary comments", () => {
    for (const audit of [
      voiceAudit({ issueId: "issue_other" }),
      voiceAudit({ issueRef: "AGE-OTHER" }),
      voiceAudit({ runId: "run_other" }),
      voiceAudit({ commentId: "comment_other" }),
    ]) {
      expect(projectExecOsVoiceTurnAudit({
        executionAuditResultJson: resultJson(),
        issue: { id: "issue_1", ref: "AGE-1" },
        run: { id: "ad_run_1" },
        comments: [
          { id: "comment_1", body: "Normal result comment" },
          { id: "voice_comment_1", body: serializeExecOsVoiceTurnAuditComment(audit) },
        ],
      })).toBeNull();
    }
  });

  it("rejects loose unsupported entries, invalid enums, and invalid terminal answer invariants", () => {
    for (const mutate of [
      (result: ReturnType<typeof resultJson>) => { result.audit.unsupported = [{ adapterId: "hermes", status: "unsupported" }] as typeof result.audit.unsupported; },
      (result: ReturnType<typeof resultJson>) => { result.audit.request.classification = "routine-ish"; },
      (result: ReturnType<typeof resultJson>) => { result.audit.events[0]!.type = "done"; },
      (result: ReturnType<typeof resultJson>) => { result.audit.evidence[0]!.method = "guessed"; },
      (result: ReturnType<typeof resultJson>) => { Reflect.deleteProperty(result.audit, "directAnswer"); },
      (result: ReturnType<typeof resultJson>) => { Object.assign(result.audit, { cannotAnswer: { reason: "conflict", at: timestamp } }); },
      (result: ReturnType<typeof resultJson>) => {
        result.audit.terminalStatus = "cannot_answer";
        Reflect.deleteProperty(result.audit, "directAnswer");
      },
      (result: ReturnType<typeof resultJson>) => {
        result.audit.terminalStatus = "failed";
        result.audit.directAnswer = "must not answer";
      },
    ]) {
      const result = resultJson();
      mutate(result);
      expect(projectExecOsVoiceTurnAudit({
        executionAuditResultJson: result,
        issue: { id: "issue_1", ref: "AGE-1" },
        run: { id: "ad_run_1" },
        comments: [
          { id: "comment_1", body: "Normal result comment" },
          { id: "voice_comment_1", body: serializeExecOsVoiceTurnAuditComment(voiceAudit()) },
        ],
      })).toBeNull();
    }
  });

  it("uses exact sourceRef and result-comment matching, not substring collisions", () => {
    const issueCollision = resultJson();
    issueCollision.audit.events[0]!.sourceRef = "paperclip://issues/issue_10/runs/ad_run_1";
    issueCollision.audit.evidence[0]!.sourceRef = "paperclip://issues/issue_10/runs/ad_run_1";
    expect(projectExecOsVoiceTurnAudit({
      executionAuditResultJson: issueCollision,
      issue: { id: "issue_1", ref: "AGE-1" },
      run: { id: "ad_run_1" },
      comments: [
        { id: "comment_1", body: "Normal result comment" },
        { id: "voice_comment_1", body: serializeExecOsVoiceTurnAuditComment(voiceAudit()) },
      ],
    })).toBeNull();

    expect(projectExecOsVoiceTurnAudit({
      executionAuditResultJson: resultJson(),
      issue: { id: "issue_1", ref: "AGE-1" },
      run: { id: "ad_run_1" },
      comments: [
        { id: "comment_10", body: "Normal result comment" },
        { id: "voice_comment_1", body: serializeExecOsVoiceTurnAuditComment(voiceAudit()) },
      ],
    })).toBeNull();
  });
});
