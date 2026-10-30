import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agentCorrections,
  agents,
  approvals,
  assistantConversations,
  assistantMessages,
  authUsers,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  evaluationEvents,
  evaluationScorecards,
  goals,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  projects,
  routineRuns,
  routineTriggers,
  routines,
  verdicts,
  workforceEnrollments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentPerformanceRoutes } from "../routes/agent-performance.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { truncateWithRetry } from "./helpers/truncate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const DAY = 24 * 60 * 60 * 1000;
const FORBIDDEN = "Only the agent's accountable person, its steward and company admins can see this.";

/**
 * AgentDash: APM gate 1 — the derived profile and the performance projection
 * routes. Authorization follows the gate 1 spec table; nothing is written.
 */
describeEmbeddedPostgres("agent performance routes (APM gate 1)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-performance-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function addUser(companyId: string, membershipRole: string) {
    const userId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: `User ${membershipRole}`, email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole });
    return userId;
  }

  async function addCompany(label: string) {
    return db
      .insert(companies)
      .values({ name: `${label} ${randomUUID()}`, issuePrefix: `AP${randomUUID().slice(0, 6).toUpperCase()}`, productProfile: "agentdash_mk" })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function addAgent(companyId: string, values: Partial<typeof agents.$inferInsert> & { name: string }) {
    return db
      .insert(agents)
      .values({ companyId, role: "engineer", status: "idle", adapterType: "process", adapterConfig: { command: "echo" }, ...values })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seed() {
    const now = Date.now();
    const company = await addCompany("Perf");
    const ownerUserId = await addUser(company.id, "owner");
    const stewardUserId = await addUser(company.id, "member");
    const accountableUserId = await addUser(company.id, "member");
    const outsiderUserId = await addUser(company.id, "member");
    const chief = await addAgent(company.id, { name: "Chief", role: "chief_of_staff" });
    const analyst = await addAgent(company.id, {
      name: "Analyst",
      title: "Pipeline Analyst",
      reportsTo: chief.id,
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 900 } },
      budgetMonthlyCents: 10_000,
    });
    const autonomous = await addAgent(company.id, { name: "Solo", autonomy: "autonomous", accountableUserId });
    const reviewer = await addAgent(company.id, { name: "Reviewer" });
    const evaluator = await addAgent(company.id, { name: "Evaluator", role: "evaluator" });
    await agentStewardshipService(db).assign(company.id, { agentId: analyst.id, userId: stewardUserId, assignedByUserId: ownerUserId });

    // Plan card: entry 1 is the Analyst (positional with confirmedAgentIds).
    const conversation = await db
      .insert(assistantConversations)
      .values({ companyId: company.id, userId: ownerUserId })
      .returning()
      .then((rows) => rows[0]!);
    const planMessage = await db
      .insert(assistantMessages)
      .values({
        conversationId: conversation.id,
        role: "assistant",
        content: "Here is the team",
        cardKind: "agent_plan_proposal_v1",
        cardPayload: {
          rationale: "Grow pipeline",
          alignmentToShortTerm: "Q4",
          alignmentToLongTerm: "Growth",
          agents: [
            { name: "Chief", role: "chief_of_staff", adapterType: "process", responsibilities: ["Coordinate"], kpis: [] },
            { name: "Analyst", role: "research", adapterType: "process", responsibilities: ["Weekly pipeline report"], kpis: ["Report on time"] },
          ],
          confirmedAt: new Date(now - 20 * DAY).toISOString(),
          confirmedAgentIds: [chief.id, analyst.id],
        },
      })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(workforceEnrollments).values({ companyId: company.id, agentId: analyst.id, templateId: "sales-support", templateVersion: 1, objective: "Keep the pipeline honest" });

    // Q1: a daily 09:00 UTC routine created long before the window, one run linked to a done issue.
    const routine = await db
      .insert(routines)
      .values({ companyId: company.id, title: "Weekly pipeline report", assigneeAgentId: analyst.id, status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    const trigger = await db
      .insert(routineTriggers)
      .values({ companyId: company.id, routineId: routine.id, kind: "schedule", cronExpression: "0 9 * * *", timezone: "UTC", createdAt: new Date(now - 60 * DAY) })
      .returning()
      .then((rows) => rows[0]!);
    const routineIssue = await db
      .insert(issues)
      .values({ companyId: company.id, title: "Report", status: "done", assigneeAgentId: analyst.id })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(routineRuns).values({ companyId: company.id, routineId: routine.id, triggerId: trigger.id, source: "schedule", status: "completed", triggeredAt: new Date(now - DAY), linkedIssueId: routineIssue.id });

    // Q2: verdicts on an issue assigned to the analyst.
    const reviewed = await db
      .insert(issues)
      .values({ companyId: company.id, title: "Draft", status: "in_review", assigneeAgentId: analyst.id })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(verdicts).values([
      { companyId: company.id, entityType: "issue", issueId: reviewed.id, reviewerAgentId: reviewer.id, outcome: "passed", createdAt: new Date(now - DAY) },
      { companyId: company.id, entityType: "issue", issueId: reviewed.id, reviewerUserId: ownerUserId, outcome: "failed", createdAt: new Date(now - DAY) },
      // Outside a 30-day window.
      { companyId: company.id, entityType: "issue", issueId: reviewed.id, reviewerUserId: ownerUserId, outcome: "passed", createdAt: new Date(now - 40 * DAY) },
    ]);

    // Q4: spend, runs, a question answered by a person after 30 minutes, an open question, a correction.
    await db.insert(costEvents).values({ companyId: company.id, agentId: analyst.id, provider: "anthropic", model: "claude", costCents: 500, occurredAt: new Date(now - DAY) });
    await db.insert(heartbeatRuns).values([
      { companyId: company.id, agentId: analyst.id, status: "succeeded", contextSnapshot: { issueId: reviewed.id } },
      { companyId: company.id, agentId: analyst.id, status: "failed", contextSnapshot: {} },
    ]);
    const askedAt = new Date(now - 2 * DAY);
    await db.insert(issueThreadInteractions).values([
      {
        companyId: company.id,
        issueId: reviewed.id,
        kind: "ask_user_questions",
        status: "answered",
        createdByAgentId: analyst.id,
        resolvedByUserId: ownerUserId,
        resolvedAt: new Date(askedAt.getTime() + 30 * 60 * 1000),
        payload: { questions: [] } as never,
        createdAt: askedAt,
      },
      { companyId: company.id, issueId: reviewed.id, kind: "ask_user_questions", status: "pending", createdByAgentId: analyst.id, payload: { questions: [] } as never },
    ]);
    await db.insert(agentCorrections).values({ companyId: company.id, agentId: analyst.id, kind: "steward_send_back", summary: "Tighten it", sourceActorType: "user", sourceActorId: stewardUserId });

    // Q5/Q6: a refused attempt and a pending approval.
    await db.insert(activityLog).values({
      companyId: company.id,
      actorType: "agent",
      actorId: analyst.id,
      agentId: analyst.id,
      action: "authz.refused",
      entityType: "company",
      entityId: company.id,
      details: { reasonCode: "AGENT_CROSS_COMPANY" },
    });
    await db.insert(approvals).values({ companyId: company.id, type: "connector_send", requestedByAgentId: analyst.id, status: "pending", payload: {} });

    // Q3: a project it leads with a stored card, a goal it owns without one; one ledger event.
    const project = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Launch", leadAgentId: analyst.id })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(goals).values({ companyId: company.id, title: "Grow", ownerAgentId: analyst.id });
    await db.insert(evaluationScorecards).values({
      companyId: company.id,
      milestoneKind: "project",
      milestoneId: project.id,
      version: 2,
      contractVersion: "contract/v1",
      formulaVersion: "formula/v1",
      throughSeq: 1,
      card: { outcome: { O1: { key: "O1", name: "Acceptance satisfied", unit: "share", value: 1, headline: "1 of 1 met" } } },
      cardHash: "hash",
    });
    await db.insert(evaluationEvents).values({
      companyId: company.id,
      actorType: "system",
      sourceTable: "issues",
      sourceId: reviewed.id,
      sourceVersion: "1",
      eventType: "issue.transition",
      eventTime: new Date(now - DAY),
      dedupeKey: `${company.id}:issues:${reviewed.id}:1`,
    });

    const otherCompany = await addCompany("Other");
    const otherOwnerUserId = await addUser(otherCompany.id, "owner");
    const otherAgent = await addAgent(otherCompany.id, { name: "Elsewhere" });

    return {
      company, ownerUserId, stewardUserId, accountableUserId, outsiderUserId,
      chief, analyst, autonomous, reviewer, evaluator, planMessage, routine, trigger, project,
      otherCompany, otherOwnerUserId, otherAgent,
    };
  }

  /** Work of the analyst's inside a restricted project that only admins (and its access list) can read. */
  async function addRestrictedWork(s: Awaited<ReturnType<typeof seed>>) {
    const now = Date.now();
    const project = await db
      .insert(projects)
      .values({ companyId: s.company.id, name: "Secret acquisition", visibility: "restricted", leadAgentId: s.analyst.id })
      .returning()
      .then((rows) => rows[0]!);
    const issue = await db
      .insert(issues)
      .values({ companyId: s.company.id, projectId: project.id, title: "Target shortlist", status: "blocked", assigneeAgentId: s.analyst.id })
      .returning()
      .then((rows) => rows[0]!);
    const routine = await db
      .insert(routines)
      .values({ companyId: s.company.id, projectId: project.id, title: "Secret digest", assigneeAgentId: s.analyst.id, status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(routineTriggers).values({ companyId: s.company.id, routineId: routine.id, kind: "schedule", cronExpression: "0 9 * * *", timezone: "UTC", createdAt: new Date(now - 60 * DAY) });
    await db.insert(verdicts).values({ companyId: s.company.id, entityType: "issue", issueId: issue.id, reviewerAgentId: s.reviewer.id, outcome: "passed", createdAt: new Date(now - DAY) });
    await db.insert(costEvents).values({ companyId: s.company.id, agentId: s.analyst.id, projectId: project.id, provider: "anthropic", model: "claude", costCents: 700, occurredAt: new Date(now - DAY) });
    await db.insert(heartbeatRuns).values({ companyId: s.company.id, agentId: s.analyst.id, status: "succeeded", contextSnapshot: { issueId: issue.id } });
    await db.insert(issueThreadInteractions).values({ companyId: s.company.id, issueId: issue.id, kind: "ask_user_questions", status: "pending", createdByAgentId: s.analyst.id, payload: { questions: [] } as never });
    await db.insert(agentCorrections).values({ companyId: s.company.id, agentId: s.analyst.id, issueId: issue.id, kind: "task_reopened", summary: "Reopened", sourceActorType: "user", sourceActorId: s.ownerUserId });
    return { project, issue, routine };
  }

  function member(companyId: string, userId: string, membershipRole = "member") {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole, status: "active" }],
    };
  }

  function agentActor(agent: { id: string; companyId: string }, extra: Record<string, unknown> = {}) {
    return { type: "agent", agentId: agent.id, companyId: agent.companyId, source: "agent_key", ...extra };
  }

  async function send(actor: Record<string, unknown>, path: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use("/api", agentPerformanceRoutes(db));
    app.use(errorHandler);
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      return await request(`http://127.0.0.1:${address.port}`).get(path);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }

  const projectionPath = (companyId: string, agentId: string, query = "") =>
    `/api/companies/${companyId}/evaluation/agents/${agentId}/projection${query}`;

  // AgentDash: APM gate 2 — the profile read routes and their tests moved to
  // routes/agent-profiles.ts and __tests__/agent-profile-routes.test.ts.

  describe("GET /companies/:companyId/evaluation/agents/:agentId/projection", () => {
    it("admits the company owner, the steward and the accountable person, and refuses everyone else", async () => {
      const s = await seed();
      const owner = member(s.company.id, s.ownerUserId, "owner");
      const steward = member(s.company.id, s.stewardUserId);
      const accountable = member(s.company.id, s.accountableUserId);
      const outsider = member(s.company.id, s.outsiderUserId);

      expect((await send(owner, projectionPath(s.company.id, s.analyst.id))).status).toBe(200);
      expect((await send(steward, projectionPath(s.company.id, s.analyst.id))).status).toBe(200);
      expect((await send(accountable, projectionPath(s.company.id, s.autonomous.id))).status).toBe(200);

      for (const [actor, agentId] of [
        [outsider, s.analyst.id],
        [steward, s.autonomous.id],
        [accountable, s.analyst.id],
      ] as const) {
        const res = await send(actor, projectionPath(s.company.id, agentId));
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.error).toBe(FORBIDDEN);
      }
      // An agent, even about itself, and the evaluator principal.
      expect((await send(agentActor(s.analyst), projectionPath(s.company.id, s.analyst.id))).status).toBe(403);
      const evaluator = agentActor(s.evaluator, { principalKind: "evaluator", readOnly: true });
      expect((await send(evaluator, projectionPath(s.company.id, s.analyst.id))).status).toBe(403);
    });

    it("is 404 for another company's agent", async () => {
      const s = await seed();
      const otherOwner = member(s.otherCompany.id, s.otherOwnerUserId, "owner");
      expect((await send(otherOwner, projectionPath(s.otherCompany.id, s.analyst.id))).status).toBe(404);
    });

    it("validates windowDays as an integer from 1 to 365", async () => {
      const s = await seed();
      const owner = member(s.company.id, s.ownerUserId, "owner");
      for (const query of ["?windowDays=0", "?windowDays=366", "?windowDays=abc", "?windowDays=1.5", "?windowDays="]) {
        expect((await send(owner, projectionPath(s.company.id, s.analyst.id, query))).status, query).toBe(400);
      }
      const res = await send(owner, projectionPath(s.company.id, s.analyst.id, "?windowDays=365"));
      expect(res.status).toBe(200);
      expect(new Date(res.body.window.to).getTime() - new Date(res.body.window.from).getTime()).toBe(365 * DAY);
    });

    it("projects the six answers from live rows", async () => {
      const s = await seed();
      const res = await send(member(s.company.id, s.ownerUserId, "owner"), projectionPath(s.company.id, s.analyst.id));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const p = res.body;
      expect(p).toMatchObject({ kind: "agent_performance_projection", sideEffectFree: true, agentId: s.analyst.id });
      expect(new Date(p.window.to).getTime() - new Date(p.window.from).getTime()).toBe(30 * DAY);
      expect(p.throughSeq).toEqual(expect.any(Number));

      const [routineRow] = p.owed.routines;
      expect(routineRow).toMatchObject({ routineId: s.routine.id, triggerId: s.trigger.id, enabled: true });
      // A daily schedule owes 30 fire times in a 30-day window.
      expect(routineRow.owedInWindow).toBe(30);
      expect(routineRow.runs).toMatchObject({ total: 1, completed: 1 });
      expect(routineRow.linkedIssues).toEqual({ done: 1, open: 0, cancelled: 0 });
      expect(p.owed.assigned).toMatchObject({ inReview: 1, done: 1 });

      expect(p.quality).toEqual({
        verdicts: { passed: 1, failed: 1, changesRequested: 0, escalated: 0, other: 0 },
        byJudge: { person: 1, independentAgent: 1, nonIndependent: 0 },
      });
      expect(p.acceptance.automated).toMatchObject({ value: 1, of: 1 });
      expect(p.acceptance.human).toMatchObject({ value: 0, of: 1 });
      expect(p.acceptance.use.value).toBeNull();
      expect(p.acceptance.outcome.value).toBeNull();
      expect(p.acceptance.accountable).toEqual([
        expect.objectContaining({ kind: "project", id: s.project.id, note: "Evaluator card version 2 (ledger through seq 1)", outcome: expect.objectContaining({ acceptance: expect.objectContaining({ value: 1 }) }) }),
        expect.objectContaining({ kind: "goal", title: "Grow", outcome: null, note: "No evaluator card" }),
      ]);

      expect(p.cost).toEqual({
        spendCents: 500,
        runs: { total: 2, succeeded: 1, failed: 1, withoutIssue: 1 },
        peopleProxies: {
          questionsAsked: 2,
          questionsAnswered: 1,
          medianAnswerWaitMinutes: 30,
          humanCorrections: { value: 1, of: null, note: "Corrections recorded by people" },
        },
      });
      expect(p.bounds).toEqual({ refusedAttempts: 1, byCode: { AGENT_CROSS_COMPANY: 1 } });
      expect(p.decisions).toEqual({ pendingApprovals: 1, openQuestionsToPeople: 1 });
      expect(p.gaps.map((g: { code: string }) => g.code)).toContain("ATTRIBUTION_CURRENT_ASSIGNEE");
      expect(p.withheld).toEqual([{ section: "paired-harness assessments", reason: "Shown once evidence access rules ship (gate 3)" }]);
    });

    it("leaves restricted-project work the viewer can't read out of every count and never names it; an admin sees it", async () => {
      const s = await seed();
      const secret = await addRestrictedWork(s);
      // A steward who may read spend (so the spend filter is observable) but is not on the project's list.
      await db.insert(principalPermissionGrants).values({ companyId: s.company.id, principalType: "user", principalId: s.stewardUserId, permissionKey: "agents:create" });
      const steward = await send(member(s.company.id, s.stewardUserId), projectionPath(s.company.id, s.analyst.id));
      const owner = await send(member(s.company.id, s.ownerUserId, "owner"), projectionPath(s.company.id, s.analyst.id));
      expect(steward.status, JSON.stringify(steward.body)).toBe(200);
      expect(owner.status, JSON.stringify(owner.body)).toBe(200);

      const hiddenText = [secret.project.id, secret.project.name, secret.routine.id, secret.routine.title, secret.issue.id];
      const stewardPayload = JSON.stringify(steward.body);
      for (const text of hiddenText) expect(stewardPayload).not.toContain(text);
      expect(steward.body.owed.routines.map((r: { routineId: string }) => r.routineId)).toEqual([s.routine.id]);
      expect(steward.body.owed.assigned.blocked).toBe(0);
      expect(steward.body.quality.verdicts.passed).toBe(1);
      expect(steward.body.acceptance.accountable.map((a: { id: string }) => a.id)).not.toContain(secret.project.id);
      expect(steward.body.cost).toMatchObject({ spendCents: 500, runs: { total: 2 }, peopleProxies: { questionsAsked: 2, humanCorrections: { value: 1 } } });
      expect(steward.body.decisions.openQuestionsToPeople).toBe(1);
      expect(steward.body.withheld).toContainEqual({
        section: "work in projects you can't see",
        reason: "Issues, verdicts, runs, spend and questions in restricted projects you can't read are left out of every count",
      });

      const ownerPayload = JSON.stringify(owner.body);
      for (const text of [secret.project.id, secret.project.name, secret.routine.title]) expect(ownerPayload).toContain(text);
      expect(owner.body.owed.routines).toHaveLength(2);
      expect(owner.body.owed.assigned.blocked).toBe(1);
      expect(owner.body.quality.verdicts.passed).toBe(2);
      expect(owner.body.cost).toMatchObject({ spendCents: 1200, runs: { total: 3 }, peopleProxies: { questionsAsked: 3, humanCorrections: { value: 2 } } });
      expect(owner.body.decisions.openQuestionsToPeople).toBe(2);
      expect(owner.body.withheld.map((w: { section: string }) => w.section)).toEqual(["paired-harness assessments"]);
    });

    it("withholds spend from a steward who cannot read spend, as null rather than 0", async () => {
      const s = await seed();
      const res = await send(member(s.company.id, s.stewardUserId), projectionPath(s.company.id, s.analyst.id));
      expect(res.status).toBe(200);
      expect(res.body.cost.spendCents).toBeNull();
      expect(res.body.withheld.map((w: { section: string }) => w.section)).toEqual([
        "paired-harness assessments",
        "work in projects you can't see",
        "agent spend",
      ]);
    });
  });

  it("writes nothing: row counts are unchanged after every route", async () => {
    const s = await seed();
    const tables = { activityLog, evaluationEvents, evaluationScorecards, issues, approvals, agentConfigRevisions };
    const counts = async () =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(tables).map(async ([name, table]) => [
            name,
            await db.select({ n: sql<number>`count(*)::int` }).from(table).then((rows) => rows[0]!.n),
          ]),
        ),
      );
    const before = await counts();
    const owner = member(s.company.id, s.ownerUserId, "owner");
    const steward = member(s.company.id, s.stewardUserId);
    const calls: Array<[Record<string, unknown>, string, number]> = [
      [owner, projectionPath(s.company.id, s.analyst.id, "?windowDays=365"), 200],
      [steward, projectionPath(s.company.id, s.analyst.id), 200],
      [member(s.company.id, s.outsiderUserId), projectionPath(s.company.id, s.analyst.id), 403],
      [agentActor(s.analyst), projectionPath(s.company.id, s.analyst.id), 403],
    ];
    for (const [actor, path, status] of calls) {
      expect((await send(actor, path)).status, path).toBe(status);
    }
    expect(await counts()).toEqual(before);
    expect(before.activityLog).toBeGreaterThan(0);
  });
});
