import { describe, expect, it } from "vitest";
import { parseExecOsExecutionAuditV1FromResult, projectExecOsAudit } from "./execos-audit";

const timestamp = "2026-08-21T08:00:00.000Z";

const strictUnsupported = [
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
      runs: [],
      events: [
        {
          id: "evt_1",
          requestId: "req_1",
          runId: "local_1",
          track: "local_claude",
          adapterId: "execos-0",
          type: "completed",
          occurredAt: timestamp,
          sourceRef: "execos://runner/runs/local_1",
          payload: {},
        },
      ],
      evidence: [
        {
          id: "ev_1",
          requestId: "req_1",
          runId: "local_1",
          track: "local_claude",
          adapterId: "execos-0",
          kind: "read_only_command",
          summary: "git status",
          sourceRef: "execos://read-only-evidence/1",
          observedAt: timestamp,
          method: "read",
          byteSize: 123,
          sha256: "a".repeat(64),
          truncated: false,
        },
      ],
      actorIdentity: { actorType: "execos", actorId: "execos-0" },
      runtimeIdentity: {
        track: "local_claude",
        adapterId: "execos-0",
        runtimeId: "$0:@2:%2",
      },
      terminalStatus: "completed",
      acceptedAt: timestamp,
      completedAt: timestamp,
      directAnswer: "commit abc123; tree clean",
      unsupported: [
        {
          adapterId: "hermes",
          track: "agentdash",
          capability: "direct_session_control",
          targetRef: "hermes",
          status: "unsupported",
          reason: "not implemented",
        },
      ],
    },
  };
}

function strictResultJson() {
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
          sha256: "a".repeat(64),
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
          sha256: "b".repeat(64),
          truncated: false,
        },
      ],
      actorIdentity: { actorType: "execos", actorId: "execos-0" },
      runtimeIdentity: { track: "local_claude", adapterId: "execos-0", runtimeId: "$0:@2:%2" },
      terminalStatus: "completed",
      acceptedAt: timestamp,
      completedAt: timestamp,
      directAnswer: "commit abc123; tree clean",
      unsupported: strictUnsupported,
    },
  };
}

describe("projectExecOsAudit", () => {
  it("projects the complete attributable audit for the issue card", () => {
    expect(projectExecOsAudit(resultJson())).toEqual({
      requestId: "req_1",
      correlationId: "corr_1",
      question: "What is the current repository state?",
      status: "completed",
      answer: "commit abc123; tree clean",
      answerKind: "direct",
      actor: "execos:execos-0",
      runtime: "local_claude:execos-0",
      runtimeId: "$0:@2:%2",
      paneId: "%2",
      acceptedAt: timestamp,
      completedAt: timestamp,
      evidence: [{
        kind: "read_only_command",
        summary: "git status",
        sourceRef: "execos://read-only-evidence/1",
        observedAt: timestamp,
        byteSize: 123,
        sha256: "a".repeat(64),
      }],
      transitions: [{
        status: "completed",
        occurredAt: timestamp,
        sourceRef: "execos://runner/runs/local_1",
      }],
      unsupported: [{
        adapterId: "hermes",
        capability: "direct_session_control",
        targetRef: "hermes",
        reason: "not implemented",
      }],
    });
  });

  it("preserves an explicit cannot-answer result", () => {
    const value = resultJson();
    Reflect.deleteProperty(value.audit, "directAnswer");
    value.audit.terminalStatus = "cannot_answer";
    Object.assign(value.audit, { cannotAnswer: { reason: "source unavailable", at: timestamp } });

    expect(projectExecOsAudit(value)).toMatchObject({
      status: "cannot_answer",
      answerKind: "cannot_answer",
      answer: "source unavailable",
    });
  });

  it("rejects missing, malformed, or unattributable audit payloads", () => {
    expect(projectExecOsAudit({})).toBeNull();
    expect(projectExecOsAudit({ audit: { terminalStatus: "completed" } })).toBeNull();
    const value = resultJson();
    value.audit.runtimeIdentity.runtimeId = "";
    expect(projectExecOsAudit(value)).toBeNull();
  });
});

describe("parseExecOsExecutionAuditV1FromResult", () => {
  it("accepts the strict execution contract used for voice-audit binding", () => {
    const parsed = parseExecOsExecutionAuditV1FromResult(strictResultJson());

    expect(parsed?.request.id).toBe("req_1");
    expect(parsed?.runs.map((run) => run.track).sort()).toEqual(["agentdash", "local_claude"]);
  });

  it("rejects drift in strict enums, unsupported entries, and terminal answer invariants", () => {
    for (const mutate of [
      (result: ReturnType<typeof strictResultJson>) => { result.audit.unsupported = [{ adapterId: "hermes", status: "unsupported" }] as typeof result.audit.unsupported; },
      (result: ReturnType<typeof strictResultJson>) => { result.audit.request.classification = "routine-ish"; },
      (result: ReturnType<typeof strictResultJson>) => { result.audit.events[0]!.type = "done"; },
      (result: ReturnType<typeof strictResultJson>) => { result.audit.evidence[0]!.method = "guessed"; },
      (result: ReturnType<typeof strictResultJson>) => { Reflect.deleteProperty(result.audit, "directAnswer"); },
      (result: ReturnType<typeof strictResultJson>) => { Object.assign(result.audit, { cannotAnswer: { reason: "conflict", at: timestamp } }); },
      (result: ReturnType<typeof strictResultJson>) => {
        result.audit.terminalStatus = "cannot_answer";
        Reflect.deleteProperty(result.audit, "directAnswer");
      },
      (result: ReturnType<typeof strictResultJson>) => {
        result.audit.terminalStatus = "failed";
        result.audit.directAnswer = "must not answer";
      },
    ]) {
      const result = strictResultJson();
      mutate(result);
      expect(parseExecOsExecutionAuditV1FromResult(result)).toBeNull();
    }
  });
});
