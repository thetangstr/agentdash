import { describe, expect, it } from "vitest";
import { projectExecOsAudit } from "./execos-audit";

const timestamp = "2026-08-21T08:00:00.000Z";

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
