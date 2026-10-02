import { QueryClient } from "@tanstack/react-query";
// @vitest-environment node

const { getCommentMock } = vi.hoisted(() => ({
  getCommentMock: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    getComment: getCommentMock,
  },
}));

import { describe, expect, it, vi } from "vitest";
import { __liveUpdatesTestUtils } from "./LiveUpdatesProvider";
import { queryKeys } from "../lib/queryKeys";

describe("LiveUpdatesProvider issue invalidation", () => {
  it("refreshes touched inbox queries and only the changed issue data for issue updates", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.updated",
        details: null,
      },
      { userId: null, agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.listMineByMe("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.listTouchedByMe("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.listUnreadTouchedByMe("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activity("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.comments("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.runs("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.documents("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.attachments("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.approvals("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.liveRuns("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.activeRun("issue-1"),
    });
  });

  it("still refreshes comments when a comment activity event arrives", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.comment_added",
        details: null,
      },
      { userId: null, agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.comments("issue-1"),
    });
  });

  it("keeps self-authored comment events from refetching the active issue tree", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.comment_added",
        actorType: "user",
        actorId: "user-1",
        details: null,
      },
      { userId: "user-1", agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activity("issue-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.comments("issue-1"),
      refetchType: "inactive",
    });
  });

  it("treats self-authored comment-driven issue updates as inactive-only refreshes", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.updated",
        actorType: "user",
        actorId: "user-1",
        details: { source: "comment" },
      },
      { userId: "user-1", agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activity("issue-1"),
      refetchType: "inactive",
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.comments("issue-1"),
      refetchType: "inactive",
    });
  });

  it("keeps visible issue detail refetches inactive for downstream agent updates", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.updated",
        actorType: "system",
        actorId: "heartbeat",
        details: {
          identifier: "PAP-759",
          source: "deferred_comment_wake",
        },
      },
      { userId: null, agentId: null },
      { pathname: "/PAP/issues/PAP-759", isForegrounded: true },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activity("issue-1"),
      refetchType: "inactive",
    });
  });

  it("still actively refetches visible issue detail for board-authored updates", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.updated",
        actorType: "user",
        actorId: "user-2",
        details: {
          identifier: "PAP-759",
          status: "in_progress",
        },
      },
      { userId: "user-1", agentId: null },
      { pathname: "/PAP/issues/PAP-759", isForegrounded: true },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activity("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
      refetchType: "inactive",
    });
  });

  it("keeps visible issue comment updates inactive-only instead of active refetching", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.comment_added",
        actorType: "agent",
        actorId: "agent-1",
        details: {
          identifier: "PAP-759",
          commentId: "comment-1",
          bodySnippet: "New agent comment",
        },
      },
      { userId: null, agentId: null },
      { pathname: "/PAP/issues/PAP-759", isForegrounded: true },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activity("issue-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.comments("issue-1"),
      refetchType: "inactive",
    });
  });

  it("refreshes visible issue run queries when the displayed run changes status", () => {
    const invalidations: unknown[] = [];
    const cache = new Map<string, unknown>([
      [JSON.stringify(queryKeys.issues.detail("PAP-759")), {
        id: "issue-1",
        identifier: "PAP-759",
        assigneeAgentId: "agent-1",
        executionRunId: "run-1",
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date("2026-04-08T21:00:00.000Z"),
      }],
      [JSON.stringify(queryKeys.issues.activeRun("PAP-759")), {
        id: "run-1",
      }],
      [JSON.stringify(queryKeys.issues.liveRuns("PAP-759")), [{ id: "run-1" }]],
      [JSON.stringify(queryKeys.issues.runs("PAP-759")), [{ runId: "run-1" }]],
    ]);
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: (key: unknown) => {
        return cache.get(JSON.stringify(key));
      },
      setQueryData: (key: unknown, updater: unknown) => {
        const cacheKey = JSON.stringify(key);
        const current = cache.get(cacheKey);
        cache.set(cacheKey, typeof updater === "function" ? updater(current) : updater);
      },
    };

    const invalidated = __liveUpdatesTestUtils.invalidateVisibleIssueRunQueries(
      queryClient as never,
      "/PAP/issues/PAP-759",
      {
        runId: "run-1",
        agentId: "agent-1",
        status: "succeeded",
      },
      { isForegrounded: true },
    );

    expect(invalidated).toBe(true);
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("PAP-759"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activity("PAP-759"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.runs("PAP-759"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.liveRuns("PAP-759"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activeRun("PAP-759"),
    });
    expect(cache.get(JSON.stringify(queryKeys.issues.activeRun("PAP-759")))).toBeNull();
    expect(cache.get(JSON.stringify(queryKeys.issues.liveRuns("PAP-759")))).toEqual([]);
    expect(cache.get(JSON.stringify(queryKeys.issues.detail("PAP-759")))).toMatchObject({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
  });

  it("ignores run status events for other issues", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.activeRun("PAP-759"))) {
          return {
            id: "run-1",
          };
        }
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.liveRuns("PAP-759"))) {
          return [{ id: "run-1" }];
        }
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.runs("PAP-759"))) {
          return [{ runId: "run-1" }];
        }
        return undefined;
      },
      setQueryData: vi.fn(),
    };

    const invalidated = __liveUpdatesTestUtils.invalidateVisibleIssueRunQueries(
      queryClient as never,
      "/PAP/issues/PAP-759",
      {
        runId: "run-2",
        agentId: "agent-2",
        status: "succeeded",
      },
      { isForegrounded: true },
    );

    expect(invalidated).toBe(false);
    expect(invalidations).toEqual([]);
  });
});

describe("LiveUpdatesProvider visible issue comment hydration", () => {
  it("hydrates the visible issue comments cache with only the new comment", async () => {
    getCommentMock.mockResolvedValueOnce({
      id: "comment-2",
      companyId: "company-1",
      issueId: "issue-1",
      authorAgentId: "agent-1",
      authorUserId: null,
      body: "Second comment",
      createdAt: "2026-04-13T15:00:00.000Z",
      updatedAt: "2026-04-13T15:00:00.000Z",
    });

    const setCalls: Array<{ key: unknown; value: unknown }> = [];
    const queryClient = {
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.comments("PAP-759"))) {
          return {
            pages: [[{
              id: "comment-1",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: null,
              authorUserId: "user-1",
              body: "First comment",
              createdAt: "2026-04-13T14:00:00.000Z",
              updatedAt: "2026-04-13T14:00:00.000Z",
            }]],
            pageParams: [null],
          };
        }
        return undefined;
      },
      setQueryData: (key: unknown, updater: (value: unknown) => unknown) => {
        const current = queryClient.getQueryData(key);
        setCalls.push({ key, value: updater(current) });
      },
      invalidateQueries: vi.fn(),
    };

    await __liveUpdatesTestUtils.hydrateVisibleIssueComment(
      queryClient as never,
      "/PAP/issues/PAP-759",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.comment_added",
        details: {
          identifier: "PAP-759",
          commentId: "comment-2",
        },
      },
      { isForegrounded: true },
    );

    expect(getCommentMock).toHaveBeenCalledWith("PAP-759", "comment-2");
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]?.key).toEqual(queryKeys.issues.comments("PAP-759"));
    expect(setCalls[0]?.value).toEqual({
      pages: [[
        {
          id: "comment-2",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: "agent-1",
          authorUserId: null,
          body: "Second comment",
          createdAt: "2026-04-13T15:00:00.000Z",
          updatedAt: "2026-04-13T15:00:00.000Z",
        },
        {
          id: "comment-1",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: null,
          authorUserId: "user-1",
          body: "First comment",
          createdAt: "2026-04-13T14:00:00.000Z",
          updatedAt: "2026-04-13T14:00:00.000Z",
        },
      ]],
      pageParams: [null],
    });
  });
});

describe("LiveUpdatesProvider visible issue toast suppression", () => {
  it("suppresses activity toasts for the issue page currently in view", () => {
    const queryClient = {
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    expect(
      __liveUpdatesTestUtils.shouldSuppressActivityToastForVisibleIssue(
        queryClient as never,
        "/PAP/issues/PAP-759",
        {
          entityType: "issue",
          entityId: "issue-1",
          details: { identifier: "PAP-759" },
        },
        { isForegrounded: true },
      ),
    ).toBe(true);

    expect(
      __liveUpdatesTestUtils.shouldSuppressActivityToastForVisibleIssue(
        queryClient as never,
        "/PAP/issues/PAP-759",
        {
          entityType: "issue",
          entityId: "issue-2",
          details: { identifier: "PAP-760" },
        },
        { isForegrounded: true },
      ),
    ).toBe(false);
  });

  it("suppresses run and agent status toasts for the assignee of the visible issue", () => {
    const queryClient = {
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    expect(
      __liveUpdatesTestUtils.shouldSuppressRunStatusToastForVisibleIssue(
        queryClient as never,
        "/PAP/issues/PAP-759",
        {
          runId: "run-1",
          agentId: "agent-1",
        },
        { isForegrounded: true },
      ),
    ).toBe(true);

    expect(
      __liveUpdatesTestUtils.shouldSuppressAgentStatusToastForVisibleIssue(
        queryClient as never,
        "/PAP/issues/PAP-759",
        {
          agentId: "agent-1",
          status: "running",
        },
        { isForegrounded: true },
      ),
    ).toBe(true);
  });
});

describe("LiveUpdatesProvider run lifecycle toasts", () => {
  it("does not build start or success toasts for agent runs", () => {
    const queryClient = {
      getQueryData: () => [],
    };

    expect(
      __liveUpdatesTestUtils.buildAgentStatusToast(
        {
          agentId: "agent-1",
          status: "running",
        },
        () => "CodexCoder",
        queryClient as never,
        "company-1",
      ),
    ).toBeNull();

    expect(
      __liveUpdatesTestUtils.buildRunStatusToast(
        {
          runId: "run-1",
          agentId: "agent-1",
          status: "succeeded",
        },
        () => "CodexCoder",
      ),
    ).toBeNull();
  });

  it("still builds failure toasts for agent errors and failed runs", () => {
    const queryClient = {
      getQueryData: () => [
        {
          id: "agent-1",
          title: "Software Engineer",
        },
      ],
    };

    expect(
      __liveUpdatesTestUtils.buildAgentStatusToast(
        {
          agentId: "agent-1",
          status: "error",
        },
        () => "CodexCoder",
        queryClient as never,
        "company-1",
      ),
    ).toMatchObject({
      title: "CodexCoder errored",
      body: "Software Engineer",
      tone: "error",
    });

    expect(
      __liveUpdatesTestUtils.buildRunStatusToast(
        {
          runId: "run-1",
          agentId: "agent-1",
          status: "failed",
          error: "boom",
        },
        () => "CodexCoder",
      ),
    ).toMatchObject({
      title: "CodexCoder run failed",
      body: "boom",
      tone: "error",
    });
  });
});

describe('workforce question attention invalidation', () => {
  it.each(['created', 'answered', 'cancelled'])('invalidates only the affected company attention on question %s', (event) => {
    const client = new QueryClient();
    for (const company of ['company-1', 'company-2']) {
      client.setQueryData(queryKeys.home.waitingOnYou(company), { pendingQuestionsTotal: 1 });
      client.setQueryData(['workforce', company, 'a', 'readiness'], { phase: 'needs_input' });
    }
    __liveUpdatesTestUtils.invalidateActivityQueries(client, 'company-1', { entityType: 'issue', entityId: 'issue-1', action: `issue.thread_interaction_${event}`, details: null }, { userId: null, agentId: null });
    expect(client.getQueryState(queryKeys.home.waitingOnYou('company-1'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(['workforce', 'company-1', 'a', 'readiness'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.home.waitingOnYou('company-2'))?.isInvalidated).toBe(false);
    client.clear();
  });
});

describe('review waiting invalidation', () => {
  it.each(['issue.updated', 'issue.work_product_created', 'issue.work_product_updated'])('invalidates only the affected company Waiting on you on %s', (action) => {
    const client = new QueryClient();
    for (const company of ['company-1', 'company-2']) {
      client.setQueryData(queryKeys.home.waitingOnYou(company), { reviewsWaitingTotal: 1 });
    }
    __liveUpdatesTestUtils.invalidateActivityQueries(client, 'company-1', { entityType: 'issue', entityId: 'issue-1', action, details: null }, { userId: null, agentId: null });
    expect(client.getQueryState(queryKeys.home.waitingOnYou('company-1'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.home.waitingOnYou('company-2'))?.isInvalidated).toBe(false);
    client.clear();
  });

  it('leaves Waiting on you alone for a plain comment', () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.home.waitingOnYou('company-1'), { reviewsWaitingTotal: 1 });
    __liveUpdatesTestUtils.invalidateActivityQueries(client, 'company-1', { entityType: 'issue', entityId: 'issue-1', action: 'issue.comment_added', details: null }, { userId: null, agentId: null });
    expect(client.getQueryState(queryKeys.home.waitingOnYou('company-1'))?.isInvalidated).toBe(false);
    client.clear();
  });
});


describe('workforce readiness activity invalidation', () => {
  it.each([
    ['workforce', 'workforce.brief_updated'], ['workforce', 'workforce.learning_acknowledged'],
    ['workforce', 'workforce.enrolled'], ['workforce', 'workforce.first_job_started'],
    ['workforce', 'workforce.skills_installed'], ['workforce', 'workforce.skill_install_failed'],
    ['issue', 'verdict_recorded'], ['issue', 'dod_set'],
    ['issue', 'issue.document_created'], ['issue', 'issue.document_updated'], ['issue', 'issue.document_restored'], ['issue', 'issue.document_deleted'],
    ['issue', 'issue.work_product_created'], ['issue', 'issue.work_product_updated'], ['issue', 'issue.work_product_deleted'],
    ['issue', 'issue.created'], ['issue', 'issue.updated'], ['issue', 'issue.deleted'],
    ['issue', 'issue.checked_out'], ['issue', 'issue.released'], ['issue', 'issue.admin_force_release'],
  ])('refreshes only the affected company for %s %s', (entityType, action) => {
    const client = new QueryClient();
    for (const company of ['company-1', 'company-2']) {
      client.setQueryData(['workforce', company, 'a', 'readiness'], { phase: 'ready' });
      client.setQueryData(['workforce', company, 'a', 'enrollment'], { learnedBriefRevision: 1 });
      client.setQueryData(['workforce', company, 'brief'], { revision: 1 });
    }
    __liveUpdatesTestUtils.invalidateActivityQueries(client, 'company-1', { entityType, entityId: 'issue-1', action, details: null }, { userId: null, agentId: null });
    for (const suffix of [['a', 'readiness'], ['a', 'enrollment'], ['brief']]) {
      expect(client.getQueryState(['workforce', 'company-1', ...suffix])?.isInvalidated).toBe(true);
      expect(client.getQueryState(['workforce', 'company-2', ...suffix])?.isInvalidated).toBe(false);
    }
    client.clear();
  });
  it('does not refetch workforce on unrelated comments or cost activity', () => {
    const client = new QueryClient();
    client.setQueryData(['workforce', 'company-1', 'a', 'readiness'], { phase: 'ready' });
    for (const [entityType, action] of [['issue', 'issue.comment_added'], ['cost_event', 'cost.created']]) {
      __liveUpdatesTestUtils.invalidateActivityQueries(client, 'company-1', { entityType, entityId: 'issue-1', action, details: null }, { userId: null, agentId: null });
    }
    expect(client.getQueryState(['workforce', 'company-1', 'a', 'readiness'])?.isInvalidated).toBe(false);
    client.clear();
  });
});
