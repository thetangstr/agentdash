import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, costEvents, createDb, heartbeatRuns, issues, verdicts } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dashboardService, getUtcMonthStart } from "../services/dashboard.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dashboard service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function utcDay(offsetDays: number): Date {
  const now = new Date();
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays, 12);
  return new Date(day);
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("getUtcMonthStart", () => {
  it("anchors the monthly spend window to UTC month boundaries", () => {
    expect(getUtcMonthStart(new Date("2026-03-31T20:30:00.000-05:00")).toISOString()).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect(getUtcMonthStart(new Date("2026-04-01T00:30:00.000+14:00")).toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });
});

describeEmbeddedPostgres("dashboard service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(verdicts);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("aggregates the full 14-day run activity window without recent-run truncation", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const today = utcDay(0);
    const weekAgo = utcDay(-7);

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherAgent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      ...Array.from({ length: 105 }, () => ({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: today,
      })),
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "timed_out",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "cancelled",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        agentId: otherAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: weekAgo,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.runActivity).toHaveLength(14);
    const todayBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(today));
    const weekAgoBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(weekAgo));

    expect(todayBucket).toMatchObject({
      succeeded: 105,
      failed: 0,
      other: 0,
      total: 105,
    });
    expect(weekAgoBucket).toMatchObject({
      succeeded: 0,
      failed: 2,
      other: 1,
      total: 3,
    });
  });

  it("summarizes recent harness failure rate by adapter and failure category", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const codexAgentId = randomUUID();
    const secondCodexAgentId = randomUUID();
    const claudeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const now = new Date();
    const recent = new Date(now.getTime() - 30 * 60 * 1000);
    const older = new Date(now.getTime() - 26 * 60 * 60 * 1000);

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: codexAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: secondCodexAgentId,
        companyId,
        name: "CodexReviewer",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: claudeAgentId,
        companyId,
        name: "ClaudeCoder",
        role: "engineer",
        status: "running",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherAgent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId: codexAgentId,
        invocationSource: "assignment",
        status: "failed",
        resultJson: { failureClassification: { category: "rate_limited" } },
        createdAt: recent,
      },
      {
        id: randomUUID(),
        companyId,
        agentId: secondCodexAgentId,
        invocationSource: "assignment",
        status: "failed",
        resultJson: { failureClassification: { category: "rate_limited" } },
        createdAt: new Date(now.getTime() - 20 * 60 * 1000),
      },
      {
        id: randomUUID(),
        companyId,
        agentId: secondCodexAgentId,
        invocationSource: "assignment",
        status: "timed_out",
        resultJson: { failureClassification: { category: "timeout" } },
        createdAt: new Date(now.getTime() - 10 * 60 * 1000),
      },
      {
        id: randomUUID(),
        companyId,
        agentId: codexAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: recent,
      },
      {
        id: randomUUID(),
        companyId,
        agentId: claudeAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: recent,
      },
      {
        id: randomUUID(),
        companyId,
        agentId: codexAgentId,
        invocationSource: "assignment",
        status: "failed",
        resultJson: { failureClassification: { category: "auth_expired" } },
        createdAt: older,
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        agentId: otherAgentId,
        invocationSource: "assignment",
        status: "failed",
        resultJson: { failureClassification: { category: "missing_credential" } },
        createdAt: recent,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.harness).toMatchObject({
      windowHours: 24,
      overallStatus: "critical",
      totalRuns: 5,
      failedRuns: 3,
      failureRatePercent: 60,
    });
    expect(summary.harness.adapters[0]).toMatchObject({
      adapterType: "codex_local",
      status: "critical",
      totalRuns: 4,
      failedRuns: 3,
      failureRatePercent: 75,
      affectedAgents: 2,
      topFailureCategory: "rate_limited",
    });
    expect(summary.harness.adapters[0]?.latestFailureAt).toBe(
      new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
    );
    expect(summary.harness.adapters[1]).toMatchObject({
      adapterType: "claude_local",
      status: "ok",
      totalRuns: 1,
      failedRuns: 0,
      failureRatePercent: 0,
      affectedAgents: 0,
      topFailureCategory: null,
    });
  });

  it("summarizes task outcome quality from DoD coverage, verdicts, and issue-linked spend", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const passedIssueId = randomUUID();
    const failedIssueId = randomUUID();
    const unreviewedIssueId = randomUUID();
    const noDodIssueId = randomUUID();
    const malformedDodIssueId = randomUUID();
    const passedRunId = randomUUID();
    const unreviewedRunId = randomUUID();
    const now = new Date();
    const recent = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    const definitionOfDone = {
      summary: "Customer-visible task outcome",
      criteria: [{ id: "c1", text: "Acceptance criteria met", done: false }],
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Operator",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: passedIssueId,
        companyId,
        title: "Accepted task",
        status: "done",
        definitionOfDone,
        completedAt: recent,
        updatedAt: recent,
      },
      {
        id: failedIssueId,
        companyId,
        title: "Rejected task",
        status: "done",
        definitionOfDone,
        completedAt: recent,
        updatedAt: recent,
      },
      {
        id: unreviewedIssueId,
        companyId,
        title: "Green run but no verdict",
        status: "done",
        definitionOfDone,
        completedAt: recent,
        updatedAt: recent,
      },
      {
        id: noDodIssueId,
        companyId,
        title: "No acceptance criteria",
        status: "todo",
        updatedAt: recent,
      },
      {
        id: malformedDodIssueId,
        companyId,
        title: "Malformed acceptance criteria",
        status: "todo",
        definitionOfDone: { summary: "", criteria: [] },
        updatedAt: recent,
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: passedRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        contextSnapshot: { issueId: passedIssueId },
        createdAt: recent,
      },
      {
        id: unreviewedRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        contextSnapshot: { issueId: unreviewedIssueId },
        createdAt: recent,
      },
    ]);

    await db.insert(verdicts).values([
      {
        companyId,
        entityType: "issue",
        issueId: passedIssueId,
        reviewerUserId: "local-board",
        outcome: "passed",
        justification: "Meets acceptance criteria",
        createdAt: recent,
      },
      {
        companyId,
        entityType: "issue",
        issueId: failedIssueId,
        reviewerUserId: "local-board",
        outcome: "failed",
        justification: "Does not meet acceptance criteria",
        createdAt: recent,
      },
    ]);

    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: passedIssueId,
        heartbeatRunId: passedRunId,
        provider: "openai",
        biller: "openai",
        billingType: "metered",
        model: "gpt-5.5",
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 300,
        costCents: 1200,
        occurredAt: recent,
      },
      {
        companyId,
        agentId,
        issueId: failedIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered",
        model: "gpt-5.5",
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 200,
        costCents: 800,
        occurredAt: recent,
      },
      {
        companyId,
        agentId,
        issueId: unreviewedIssueId,
        heartbeatRunId: unreviewedRunId,
        provider: "openai",
        biller: "openai",
        billingType: "metered",
        model: "gpt-5.5",
        inputTokens: 300,
        cachedInputTokens: 0,
        outputTokens: 100,
        costCents: 300,
        occurredAt: recent,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.taskQuality).toMatchObject({
      windowDays: 30,
      issuesInScope: 5,
      issuesWithDefinitionOfDone: 3,
      dodCoveragePercent: 60,
      reviewedIssues: 2,
      passedIssues: 1,
      failedIssues: 1,
      acceptanceRatePercent: 50,
      unreviewedDoneIssues: 1,
      greenRunsPendingReview: 1,
      issueLinkedSpendCents: 2300,
      issueLinkedTokens: 2600,
      spendPerAcceptedIssueCents: 2300,
    });
  });
});
