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
      runs: [],
      events: [
        {
          id: "evt_1",
          requestId: "req_1",
          runId: "ad_run_1",
          track: "agentdash",
          adapterId: "execos_local",
          type: "completed",
          occurredAt: timestamp,
          sourceRef: "paperclip://issues/issue_1/runs/ad_run_1",
          payload: {},
        },
      ],
      evidence: [],
      actorIdentity: { actorType: "execos", actorId: "execos-0" },
      runtimeIdentity: { track: "local_claude", adapterId: "execos-0", runtimeId: "$0:@2:%2" },
      terminalStatus: "completed",
      acceptedAt: timestamp,
      completedAt: timestamp,
      directAnswer: "commit abc123; tree clean",
      unsupported: [],
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
    const executionAudit = projectExecOsAudit(resultJson());
    const view = projectExecOsVoiceTurnAudit({
      executionAudit,
      comments: [
        { id: "regular_comment", body: "Normal user-visible comment" },
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
      executionAudit: projectExecOsAudit(resultJson()),
      comments: [
        { id: "bad_json", body: `${EXECOS_VOICE_TURN_AUDIT_MARKER}\n{not json}` },
        { id: "unmarked", body: JSON.stringify(voiceAudit()) },
        { id: "unknown", body: serializeExecOsVoiceTurnAuditComment({ ...voiceAudit(), extra: "nope" } as ExecOsVoiceTurnAuditComment) },
      ],
    })).toBeNull();
    expect(projectExecOsVoiceTurnAudit({
      executionAudit: null,
      comments: [{ id: "voice_comment_1", body: serializeExecOsVoiceTurnAuditComment(voiceAudit()) }],
    })).toBeNull();
  });

  it("rejects correlation mismatches and never sources voice fields from resultJson.audit", () => {
    const result = resultJson();
    Object.assign(result.audit, {
      voiceSessionId: "vs_from_result_json",
      voiceTurnId: "vt_from_result_json",
    });
    const executionAudit = projectExecOsAudit(result);

    expect(projectExecOsVoiceTurnAudit({
      executionAudit,
      comments: [{ id: "voice_comment_1", body: serializeExecOsVoiceTurnAuditComment(voiceAudit({ requestId: "req_other" })) }],
    })).toBeNull();

    expect(projectExecOsVoiceTurnAudit({
      executionAudit,
      comments: [{ id: "voice_comment_1", body: serializeExecOsVoiceTurnAuditComment(voiceAudit()) }],
    })?.session.id).toBe("vs_12345678");
  });
});
