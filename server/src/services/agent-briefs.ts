import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import {
  AGENT_BRIEF_ALREADY_SUBMITTED,
  AGENT_BRIEF_NO_PERFORMANCE_MANAGER,
  AGENT_WORK_BRIEF_DOCUMENT_KEY,
  AGENT_WORK_BRIEF_ORIGIN_KIND,
  type AgentBriefResult,
} from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { documentService } from "./documents.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { issueService } from "./issues.js";
import { resolvePerformanceManager } from "./performance-manager.js";

/**
 * AgentDash: Agent Performance Management gate 5 (P5.1) — start from a brief.
 *
 * Creating a brief writes a planning issue (backlog, unassigned, origin
 * `agent_work_brief`) and its `agent-work-brief` issue document. Nothing is
 * assigned and nobody is woken: a backlog issue with no assignee wakes no
 * one. Editing the brief afterwards is the ordinary issue-document revision
 * API.
 *
 * Submitting assigns the issue to the company's effective performance
 * manager and moves it to `todo` — an ordinary assignment, waking the
 * planner with the same `issue_assigned` wake as any assignment. With no
 * effective manager it is 409 `AGENT_BRIEF_NO_PERFORMANCE_MANAGER` and
 * nothing changes.
 *
 * Who may: the routes require a board user; submitting also needs
 * `tasks:assign`, the permission assigning any issue needs.
 */

export interface AgentBriefActor {
  userId: string;
  /** Set when the write came via an assistant grant. */
  via?: string;
}

const BRIEF_DESCRIPTION =
  "Agent-work brief. The brief itself is the `agent-work-brief` document on this issue. Submitting assigns it to the performance manager to plan: a `scenario-manifest` document and draft profiles. Nothing is hired until a person approves a hire.";

function toResult(
  issue: { id: string; companyId: string; identifier: string | null; title: string; status: string; assigneeAgentId: string | null },
  document: { id: string; latestRevisionId: string | null; latestRevisionNumber: number },
): AgentBriefResult {
  return {
    kind: "agent_brief",
    companyId: issue.companyId,
    issueId: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title,
    status: issue.status,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    document: {
      id: document.id,
      key: AGENT_WORK_BRIEF_DOCUMENT_KEY,
      latestRevisionId: document.latestRevisionId ?? null,
      latestRevisionNumber: document.latestRevisionNumber,
    },
  };
}

/** `POST /api/companies/:companyId/agent-briefs`. Assigns nothing and wakes no one. */
export async function createAgentBrief(
  db: Db,
  input: { companyId: string; title: string; markdown: string },
  actor: AgentBriefActor,
): Promise<AgentBriefResult> {
  const issue = await issueService(db).create(input.companyId, {
    title: input.title,
    description: BRIEF_DESCRIPTION,
    status: "backlog",
    originKind: AGENT_WORK_BRIEF_ORIGIN_KIND,
    createdByAgentId: null,
    createdByUserId: actor.userId,
  });
  const { document } = await documentService(db).upsertIssueDocument({
    issueId: issue.id,
    key: AGENT_WORK_BRIEF_DOCUMENT_KEY,
    title: "Agent-work brief",
    format: "markdown",
    body: input.markdown,
    changeSummary: "Brief pasted",
    createdByUserId: actor.userId,
  });
  const via = actor.via ? { via: actor.via } : {};
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "user",
    actorId: actor.userId,
    action: "issue.created",
    entityType: "issue",
    entityId: issue.id,
    details: { title: issue.title, identifier: issue.identifier, originKind: AGENT_WORK_BRIEF_ORIGIN_KIND, ...via },
  });
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "user",
    actorId: actor.userId,
    action: "agent_brief.created",
    entityType: "issue",
    entityId: issue.id,
    details: {
      identifier: issue.identifier,
      documentId: document.id,
      key: AGENT_WORK_BRIEF_DOCUMENT_KEY,
      revisionNumber: document.latestRevisionNumber,
      ...via,
    },
  });
  return toResult(issue, document);
}

async function loadBriefIssue(db: Db, companyId: string, issueId: string) {
  const issue = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue || issue.originKind !== AGENT_WORK_BRIEF_ORIGIN_KIND) throw notFound("Brief not found");
  return issue;
}

/**
 * `POST /api/companies/:companyId/agent-briefs/:issueId/submit`: assign the
 * planning issue to the effective performance manager (`todo`) and wake it
 * the normal way.
 */
export async function submitAgentBrief(
  db: Db,
  heartbeat: IssueAssignmentWakeupDeps,
  input: { companyId: string; issueId: string },
  actor: AgentBriefActor,
): Promise<AgentBriefResult> {
  const issue = await loadBriefIssue(db, input.companyId, input.issueId);
  if (issue.assigneeAgentId || issue.assigneeUserId || issue.status !== "backlog") {
    throw conflict("This brief was already submitted", {
      code: AGENT_BRIEF_ALREADY_SUBMITTED,
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId ?? null,
    });
  }
  const document = await documentService(db).getIssueDocumentByKey(issue.id, AGENT_WORK_BRIEF_DOCUMENT_KEY);
  if (!document) throw conflict("This brief has no agent-work-brief document to plan from");
  const manager = (await resolvePerformanceManager(db, input.companyId))?.effective ?? null;
  if (!manager) {
    throw conflict("No performance manager is set. An admin can choose one in Company settings, or the company needs a Chief of Staff.", {
      code: AGENT_BRIEF_NO_PERFORMANCE_MANAGER,
    });
  }
  const updated = await issueService(db).update(issue.id, {
    assigneeAgentId: manager.agentId,
    assigneeUserId: null,
    status: "todo",
    actorUserId: actor.userId,
  });
  if (!updated) throw notFound("Brief not found");
  const via = actor.via ? { via: actor.via } : {};
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "user",
    actorId: actor.userId,
    action: "issue.updated",
    entityType: "issue",
    entityId: issue.id,
    details: {
      identifier: issue.identifier,
      assigneeAgentId: manager.agentId,
      status: updated.status,
      source: "agent_brief.submit",
      _previous: { status: issue.status, assigneeAgentId: null, assigneeUserId: null },
      ...via,
    },
  });
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "user",
    actorId: actor.userId,
    agentId: manager.agentId,
    action: "agent_brief.submitted",
    entityType: "issue",
    entityId: issue.id,
    details: {
      identifier: issue.identifier,
      performanceManagerAgentId: manager.agentId,
      briefRevisionId: document.latestRevisionId ?? null,
      briefRevisionNumber: document.latestRevisionNumber,
      ...via,
    },
  });
  // The ordinary assignment wake (issue_assigned), exactly as an issue PATCH that assigns.
  await queueIssueAssignmentWakeup({
    heartbeat,
    issue: updated,
    reason: "issue_assigned",
    mutation: "update",
    contextSource: "agent_brief.submit",
    requestedByActorType: "user",
    requestedByActorId: actor.userId,
  });
  return toResult(updated, document);
}
