// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { ExecutionWorkspace, HeartbeatRun, Issue, ProjectWorkspace } from "@paperclipai/shared";
import {
  DEFAULT_INBOX_ISSUE_COLUMNS,
  buildInboxDismissedAtByKey,
  getAvailableInboxIssueColumns,
  getLatestFailedRunsByAgent,
  isInboxEntityDismissed,
  normalizeInboxIssueColumns,
  resolveIssueWorkspaceName,
} from "./inbox";

function makeRun(id: string, status: HeartbeatRun["status"], createdAt: string, agentId = "agent-1"): HeartbeatRun {
  return {
    id,
    companyId: "company-1",
    agentId,
    invocationSource: "assignment",
    triggerDetail: null,
    status,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    lastOutputAt: null,
    lastOutputSeq: 0,
    lastOutputStream: null,
    lastOutputBytes: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processGroupId: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    livenessState: null,
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: null,
    nextAction: null,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    contextSnapshot: null,
    startedAt: new Date(createdAt),
    finishedAt: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function makeIssue(id: string, isUnreadForMe: boolean): Issue {
  return {
    id,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: `Issue ${id}`,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: `PAP-${id}`,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: new Date("2026-03-11T00:00:00.000Z"),
    lastExternalCommentAt: new Date("2026-03-11T01:00:00.000Z"),
    lastActivityAt: new Date("2026-03-11T01:00:00.000Z"),
    isUnreadForMe,
  };
}

function makeProjectWorkspace(overrides: Partial<ProjectWorkspace> = {}): ProjectWorkspace {
  return {
    id: "project-workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    name: "Primary workspace",
    sourceType: "local_path",
    cwd: "/tmp/project",
    repoUrl: null,
    repoRef: null,
    defaultRef: null,
    visibility: "default",
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    runtimeConfig: null,
    isPrimary: true,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    ...overrides,
  };
}

function makeExecutionWorkspace(overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  return {
    id: "execution-workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    sourceIssueId: "issue-1",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "PAP-1 branch",
    status: "active",
    cwd: "/tmp/project/worktree",
    repoUrl: null,
    baseRef: null,
    branchName: "pap-1",
    providerType: "git_worktree",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-03-11T00:00:00.000Z"),
    openedAt: new Date("2026-03-11T00:00:00.000Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    ...overrides,
  };
}

describe("inbox helpers", () => {
  it("resurfaces non-issue items when they change after dismissal", () => {
    const dismissedAtByKey = buildInboxDismissedAtByKey([
      {
        id: "dismissal-1",
        companyId: "company-1",
        userId: "user-1",
        itemKey: "approval:approval-1",
        dismissedAt: new Date("2026-03-11T01:00:00.000Z"),
        createdAt: new Date("2026-03-11T01:00:00.000Z"),
        updatedAt: new Date("2026-03-11T01:00:00.000Z"),
      },
    ]);

    expect(
      isInboxEntityDismissed(
        dismissedAtByKey,
        "approval:approval-1",
        new Date("2026-03-11T00:30:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isInboxEntityDismissed(
        dismissedAtByKey,
        "approval:approval-1",
        new Date("2026-03-11T01:30:00.000Z"),
      ),
    ).toBe(false);
  });

  it("hides the workspace column option unless isolated workspaces are enabled", () => {
    expect(getAvailableInboxIssueColumns(false)).toEqual(["status", "id", "assignee", "steward", "project", "parent", "labels", "updated"]);
    expect(getAvailableInboxIssueColumns(true)).toEqual([
      "status",
      "id",
      "assignee",
      "steward",
      "project",
      "workspace",
      "parent",
      "labels",
      "updated",
    ]);
  });

  it("shows explicit workspace names but leaves the default workspace blank", () => {
    const issue = makeIssue("1", true);
    issue.projectId = "project-1";
    issue.projectWorkspaceId = "project-workspace-1";
    issue.executionWorkspaceId = "execution-workspace-1";

    const executionWorkspace = makeExecutionWorkspace();
    const defaultWorkspace = makeProjectWorkspace();
    const secondaryWorkspace = makeProjectWorkspace({
      id: "project-workspace-2",
      name: "Secondary workspace",
      isPrimary: false,
    });

    expect(
      resolveIssueWorkspaceName(issue, {
        executionWorkspaceById: new Map([[executionWorkspace.id, executionWorkspace]]),
        projectWorkspaceById: new Map([
          [defaultWorkspace.id, defaultWorkspace],
          [secondaryWorkspace.id, secondaryWorkspace],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([[issue.projectId!, defaultWorkspace.id]]),
      }),
    ).toBe("PAP-1 branch");

    issue.executionWorkspaceId = null;
    expect(
      resolveIssueWorkspaceName(issue, {
        projectWorkspaceById: new Map([
          [defaultWorkspace.id, defaultWorkspace],
          [secondaryWorkspace.id, secondaryWorkspace],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([[issue.projectId!, defaultWorkspace.id]]),
      }),
    ).toBeNull();

    issue.projectWorkspaceId = secondaryWorkspace.id;
    expect(
      resolveIssueWorkspaceName(issue, {
        projectWorkspaceById: new Map([
          [defaultWorkspace.id, defaultWorkspace],
          [secondaryWorkspace.id, secondaryWorkspace],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([[issue.projectId!, defaultWorkspace.id]]),
      }),
    ).toBe("Secondary workspace");

    issue.projectWorkspaceId = null;
    expect(
      resolveIssueWorkspaceName(issue, {
        projectWorkspaceById: new Map([
          [defaultWorkspace.id, defaultWorkspace],
          [secondaryWorkspace.id, secondaryWorkspace],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([[issue.projectId!, defaultWorkspace.id]]),
      }),
    ).toBeNull();

    issue.executionWorkspaceId = "execution-workspace-shared-default";
    issue.projectWorkspaceId = defaultWorkspace.id;
    expect(
      resolveIssueWorkspaceName(issue, {
        executionWorkspaceById: new Map([[
          issue.executionWorkspaceId,
          makeExecutionWorkspace({
            id: issue.executionWorkspaceId,
            mode: "shared_workspace",
            strategyType: "project_primary",
            projectWorkspaceId: defaultWorkspace.id,
            name: "PAP-1067",
          }),
        ]]),
        projectWorkspaceById: new Map([
          [defaultWorkspace.id, defaultWorkspace],
          [secondaryWorkspace.id, secondaryWorkspace],
        ]),
        defaultProjectWorkspaceIdByProjectId: new Map([[issue.projectId!, defaultWorkspace.id]]),
      }),
    ).toBeNull();
  });

  it("normalizes issue columns to valid values in canonical order", () => {
    expect(normalizeInboxIssueColumns(["project", "workspace", "wat", "id"])).toEqual(["id", "project", "workspace"]);
    expect(normalizeInboxIssueColumns([])).toEqual([]);
    expect(DEFAULT_INBOX_ISSUE_COLUMNS).toEqual(["status", "id", "assignee", "steward", "updated"]);
  });

  it("keeps each agent's latest run only when it failed or timed out", () => {
    const runs = [
      makeRun("a-old", "failed", "2026-03-11T00:00:00.000Z", "agent-a"),
      makeRun("a-new", "succeeded", "2026-03-11T01:00:00.000Z", "agent-a"),
      makeRun("b-old", "succeeded", "2026-03-11T00:00:00.000Z", "agent-b"),
      makeRun("b-new", "timed_out", "2026-03-11T02:00:00.000Z", "agent-b"),
      makeRun("c-new", "failed", "2026-03-11T03:00:00.000Z", "agent-c"),
    ];
    expect(getLatestFailedRunsByAgent(runs).map((run: HeartbeatRun) => run.id).sort()).toEqual(["b-new", "c-new"]);
  });
});
