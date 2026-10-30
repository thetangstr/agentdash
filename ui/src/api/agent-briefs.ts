import {
  AGENT_SCENARIO_MANIFEST_DOCUMENT_KEY,
  AGENT_WORK_BRIEF_DOCUMENT_KEY,
  AGENT_WORK_BRIEF_ORIGIN_KIND,
  type AgentBriefResult,
  type CreateAgentBrief,
  type DocumentRevision,
  type Issue,
  type IssueDocument,
  type PerformanceManagerView,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * AgentDash: Agent Performance Management gate 5 (P5.2) — start from a brief.
 *
 * Kept apart on purpose, as the server keeps them:
 * - `create` saves the brief as a planning issue (backlog, unassigned) with
 *   an `agent-work-brief` document. It assigns nothing and wakes no one;
 * - `submit` assigns it to the performance manager (the planner) — an
 *   ordinary assignment, which wakes the planner the normal way;
 * - editing the brief is the issue-document revision API (`baseRevisionId`).
 * The planner writes the `scenario-manifest` document and unbound draft
 * profiles. Nothing here hires an agent.
 */

function briefsBase(companyId: string): string {
  return `/companies/${encodeURIComponent(companyId)}/agent-briefs`;
}

function documentPath(issueId: string, key: string): string {
  return `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`;
}

export const agentBriefQueryKeys = {
  list: (companyId: string) => ["companies", companyId, "agent-briefs"] as const,
  issue: (issueId: string) => ["agent-briefs", issueId, "issue"] as const,
  brief: (issueId: string) => ["agent-briefs", issueId, "document", AGENT_WORK_BRIEF_DOCUMENT_KEY] as const,
  briefRevisions: (issueId: string) => ["agent-briefs", issueId, "document", AGENT_WORK_BRIEF_DOCUMENT_KEY, "revisions"] as const,
  manifest: (issueId: string) => ["agent-briefs", issueId, "document", AGENT_SCENARIO_MANIFEST_DOCUMENT_KEY] as const,
  performanceManager: (companyId: string) => ["companies", companyId, "performance-manager"] as const,
};

export const agentBriefsApi = {
  /** Save the brief. Assigns nothing and wakes no one. */
  create: (companyId: string, input: CreateAgentBrief) => api.post<AgentBriefResult>(briefsBase(companyId), input),
  /** Send it to the planner: assigns the performance manager, which wakes it. 409 when there is none or it was already sent. */
  submit: (companyId: string, issueId: string) =>
    api.post<AgentBriefResult>(`${briefsBase(companyId)}/${encodeURIComponent(issueId)}/submit`, {}),
  /** The company's briefs: planning issues created from a brief. */
  list: (companyId: string) =>
    api.get<Issue[]>(
      `/companies/${encodeURIComponent(companyId)}/issues?originKind=${encodeURIComponent(AGENT_WORK_BRIEF_ORIGIN_KIND)}`,
    ),
  issue: (issueId: string) => api.get<Issue>(`/issues/${encodeURIComponent(issueId)}`),
  brief: (issueId: string) => api.get<IssueDocument>(documentPath(issueId, AGENT_WORK_BRIEF_DOCUMENT_KEY)),
  briefRevisions: (issueId: string) =>
    api.get<DocumentRevision[]>(`${documentPath(issueId, AGENT_WORK_BRIEF_DOCUMENT_KEY)}/revisions`),
  /**
   * A new revision of the brief. `baseRevisionId` is the revision the editor
   * loaded; a stale one answers 409 and overwrites nothing.
   */
  saveBrief: (issueId: string, input: { body: string; baseRevisionId: string | null; title?: string | null; changeSummary?: string | null }) =>
    api.put<IssueDocument>(documentPath(issueId, AGENT_WORK_BRIEF_DOCUMENT_KEY), {
      format: "markdown",
      body: input.body,
      baseRevisionId: input.baseRevisionId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.changeSummary ? { changeSummary: input.changeSummary } : {}),
    }),
  /** The planner's plan. 404 until it writes one. */
  manifest: (issueId: string) => api.get<IssueDocument>(documentPath(issueId, AGENT_SCENARIO_MANIFEST_DOCUMENT_KEY)),
  /** Who would plan it: the company's effective performance manager (read-only here). */
  performanceManager: (companyId: string) =>
    api.get<PerformanceManagerView>(`/companies/${encodeURIComponent(companyId)}/performance-manager`),
};
