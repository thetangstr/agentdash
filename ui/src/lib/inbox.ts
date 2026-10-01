import type { HeartbeatRun, InboxDismissal, Issue } from "@paperclipai/shared";

// AgentDash: one UX — what is left of the old Inbox's helpers. The issue-list
// column set (IssuesList, IssueColumns), workspace-name resolution for the
// workspace column, and the failed-run + dismissal rules Decisions reuses for
// its Failed runs section (the dismissal keys are unchanged, so dismissals a
// person made in the old Inbox still hold).

export const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);
export const inboxIssueColumns = [
  "status",
  "id",
  "assignee",
  // AgentDash: age-2 — accountable human for the assigned agent.
  "steward",
  "project",
  "workspace",
  "parent",
  "labels",
  "updated",
] as const;
export type InboxIssueColumn = (typeof inboxIssueColumns)[number];
export const DEFAULT_INBOX_ISSUE_COLUMNS: InboxIssueColumn[] = ["status", "id", "assignee", "steward", "updated"];

export interface InboxProjectWorkspaceLookup {
  name: string;
}

export interface InboxExecutionWorkspaceLookup {
  name: string;
  mode: "shared_workspace" | "isolated_workspace" | "operator_branch" | "adapter_managed" | "cloud_sandbox";
  projectWorkspaceId: string | null;
}

export interface InboxWorkspaceGroupingOptions {
  executionWorkspaceById?: ReadonlyMap<string, InboxExecutionWorkspaceLookup>;
  projectWorkspaceById?: ReadonlyMap<string, InboxProjectWorkspaceLookup>;
  defaultProjectWorkspaceIdByProjectId?: ReadonlyMap<string, string>;
}

export function normalizeTimestamp(value: string | Date | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function buildInboxDismissedAtByKey(dismissals: InboxDismissal[]): Map<string, number> {
  return new Map(
    dismissals.map((dismissal) => [dismissal.itemKey, normalizeTimestamp(dismissal.dismissedAt)]),
  );
}

export function isInboxEntityDismissed(
  dismissedAtByKey: ReadonlyMap<string, number>,
  itemKey: string,
  activityAt: string | Date | null | undefined,
): boolean {
  const dismissedAt = dismissedAtByKey.get(itemKey);
  if (dismissedAt == null) return false;
  return dismissedAt >= normalizeTimestamp(activityAt);
}

export function normalizeInboxIssueColumns(columns: Iterable<string | InboxIssueColumn>): InboxIssueColumn[] {
  const selected = new Set(columns);
  return inboxIssueColumns.filter((column) => selected.has(column));
}

export function getAvailableInboxIssueColumns(enableWorkspaceColumn: boolean): InboxIssueColumn[] {
  if (enableWorkspaceColumn) return [...inboxIssueColumns];
  return inboxIssueColumns.filter((column) => column !== "workspace");
}

export function resolveIssueWorkspaceName(
  issue: Pick<Issue, "executionWorkspaceId" | "projectId" | "projectWorkspaceId">,
  {
    executionWorkspaceById,
    projectWorkspaceById,
    defaultProjectWorkspaceIdByProjectId,
  }: InboxWorkspaceGroupingOptions,
): string | null {
  const defaultProjectWorkspaceId = issue.projectId
    ? defaultProjectWorkspaceIdByProjectId?.get(issue.projectId) ?? null
    : null;

  if (issue.executionWorkspaceId) {
    const executionWorkspace = executionWorkspaceById?.get(issue.executionWorkspaceId) ?? null;
    const linkedProjectWorkspaceId =
      executionWorkspace?.projectWorkspaceId ?? issue.projectWorkspaceId ?? null;
    const isDefaultSharedExecutionWorkspace =
      executionWorkspace?.mode === "shared_workspace" && linkedProjectWorkspaceId === defaultProjectWorkspaceId;
    if (isDefaultSharedExecutionWorkspace) return null;

    const workspaceName = executionWorkspace?.name;
    if (workspaceName) return workspaceName;
  }

  if (issue.projectWorkspaceId) {
    if (issue.projectWorkspaceId === defaultProjectWorkspaceId) return null;
    const workspaceName = projectWorkspaceById?.get(issue.projectWorkspaceId)?.name;
    if (workspaceName) return workspaceName;
  }

  return null;
}

export function getLatestFailedRunsByAgent(runs: HeartbeatRun[]): HeartbeatRun[] {
  const sorted = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const latestByAgent = new Map<string, HeartbeatRun>();

  for (const run of sorted) {
    if (!latestByAgent.has(run.agentId)) {
      latestByAgent.set(run.agentId, run);
    }
  }

  return Array.from(latestByAgent.values()).filter((run) => FAILED_RUN_STATUSES.has(run.status));
}
