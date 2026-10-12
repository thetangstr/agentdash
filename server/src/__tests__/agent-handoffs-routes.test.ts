import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  agentStewardships,
  agentWakeupRequests,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  featureFlags,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import {
  AGENT_HANDOFF_ACTION,
  AGENT_HANDOFF_CAP_CODE,
  AGENT_HANDOFF_REFUSED_ACTION,
  AGENT_HANDOFF_RETURNED_ACTION,
  AGENT_HANDOFF_ROUND_CAP,
  COWORKER_BRIDGE_FLAG,
  emitHandoffReturned,
  recordAgentHandoff,
} from "../services/agent-handoffs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * Agent-to-agent hand-offs (O5, O7). Agents hand work to each other directly —
 * a child issue assigned to the other agent — and the receiving agent decides
 * from its own mandate when to involve its person. A request may go through at
 * most three agent-to-agent rounds (a round is an agent handing an issue in the
 * request to another agent, or a hand-off sent back); the fourth hand-off is
 * refused and the agent is told to ask its person. The person-facing side
 * (people assigning, reassigning) is never capped.
 */
describeEmbeddedPostgres("agent-to-agent hand-offs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const noRunRuntime = { heartbeat: { enabled: false, wakeOnDemand: false } };

  type AgentFixture = {
    agentId: string;
    userId: string;
    runId: string;
    actor: Record<string, unknown>;
  };
  let agentA!: AgentFixture;
  let agentB!: AgentFixture;
  let agentC!: AgentFixture;

  async function makeAgent(name: string): Promise<AgentFixture> {
    const agentId = randomUUID();
    const userId = `person-${randomUUID()}`;
    const runId = randomUUID();
    const keyId = randomUUID();
    await db.insert(companyMemberships).values({ companyId: COMPANY, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId, companyId: COMPANY, name, role: "general", status: "idle",
      // canCreateAgents carries legacy tasks:assign authority.
      permissions: { canCreateAgents: true }, runtimeConfig: noRunRuntime,
    });
    await db.insert(agentStewardships).values({ companyId: COMPANY, agentId, userId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: COMPANY, agentId, status: "running" });
    await db.insert(agentApiKeys).values({ id: keyId, agentId, companyId: COMPANY, name: "test", keyHash: `unused-${keyId}` });
    return { agentId, userId, runId, actor: { type: "agent", agentId, companyId: COMPANY, source: "agent_key", keyId, runId } };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-handoffs-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: COMPANY, name: "Hand-off Co", issuePrefix: "HOC" });
    await db.insert(companyMemberships).values({ companyId: COMPANY, principalType: "user", principalId: "owner", status: "active", membershipRole: "owner" });
    // The co-worker feature is behind a company flag; this company has it on.
    await db.insert(featureFlags).values({ companyId: COMPANY, flagKey: COWORKER_BRIDGE_FLAG, enabled: true });
    agentA = await makeAgent("Agent A");
    agentB = await makeAgent("Agent B");
    agentC = await makeAgent("Agent C");
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const ownerActor = { type: "board", source: "local_implicit", userId: "owner", companyIds: [COMPANY] };
  function memberActor(userId: string) {
    return {
      type: "board",
      source: "session",
      userId,
      companyIds: [COMPANY],
      memberships: [{ companyId: COMPANY, membershipRole: "member", status: "active" }],
    };
  }

  function app(actor: Record<string, unknown>) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    server.use("/api", issueRoutes(db, {} as never));
    server.use(errorHandler);
    return server;
  }

  async function rows(entityId: string, action: string) {
    return db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, entityId), eq(activityLog.action, action)));
  }

  /** A request issue assigned to Agent A, the agent of the person it was assigned to. */
  async function rootRequest(title = "Request for Person A") {
    const [root] = await db
      .insert(issues)
      .values({ companyId: COMPANY, title, status: "in_progress", assigneeAgentId: agentA.agentId })
      .returning();
    return root!;
  }

  async function handOffChild(from: AgentFixture, parentId: string, to: { assigneeAgentId?: string; assigneeUserId?: string }, title = "Hand-off") {
    return request(app(from.actor))
      .post(`/api/issues/${parentId}/children`)
      .send({ title, status: "todo", ...to });
  }

  /**
   * The parent's completion wake. Agents here have on-demand wakes switched
   * off, so the heartbeat records a skipped wake request (its `reason` becomes
   * the skip reason) carrying the completion payload; that row is the wake.
   */
  async function waitForChildrenCompletedWake(agentId: string, parentIssueId: string, childIssueId: string) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      const wake = wakes.find((row) => {
        const payload = row.payload as Record<string, unknown> | null;
        return payload?.issueId === parentIssueId && payload?.completedChildIssueId === childIssueId;
      });
      if (wake) return wake;
      if (Date.now() > deadline) throw new Error(`no children-completed wake for agent ${agentId} on issue ${parentIssueId}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it("records an agent's hand-off to another agent as round 1 of the request", async () => {
    const root = await rootRequest();
    const res = await handOffChild(agentA, root.id, { assigneeAgentId: agentB.agentId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.assigneeAgentId).toBe(agentB.agentId);

    const [handoff] = await rows(res.body.id, AGENT_HANDOFF_ACTION);
    expect(handoff).toBeDefined();
    expect(handoff!.actorType).toBe("agent");
    expect(handoff!.details).toMatchObject({
      rootIssueId: root.id,
      parentIssueId: root.id,
      fromAgentId: agentA.agentId,
      toAgentId: agentB.agentId,
      round: 1,
      cap: AGENT_HANDOFF_ROUND_CAP,
    });
  });

  it("counts a person assignment that routes to the person's agent as a hand-off too", async () => {
    const root = await rootRequest();
    const res = await handOffChild(agentA, root.id, { assigneeUserId: agentB.userId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.assigneeAgentId).toBe(agentB.agentId);
    const [handoff] = await rows(res.body.id, AGENT_HANDOFF_ACTION);
    expect(handoff?.details).toMatchObject({ toAgentId: agentB.agentId, round: 1 });
  });

  it("does not count an agent creating work for itself, or a person assigning an agent", async () => {
    const root = await rootRequest();
    const own = await handOffChild(agentA, root.id, { assigneeAgentId: agentA.agentId });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(await rows(own.body.id, AGENT_HANDOFF_ACTION)).toHaveLength(0);

    const byPerson = await request(app(ownerActor))
      .post(`/api/issues/${root.id}/children`)
      .send({ title: "From a person", status: "todo", assigneeAgentId: agentB.agentId });
    expect(byPerson.status, JSON.stringify(byPerson.body)).toBe(201);
    expect(await rows(byPerson.body.id, AGENT_HANDOFF_ACTION)).toHaveLength(0);
  });

  it("refuses the fourth agent-to-agent round in a request and tells the agent to ask its person", async () => {
    const root = await rootRequest();
    const first = await handOffChild(agentA, root.id, { assigneeAgentId: agentB.agentId }, "Round 1");
    expect(first.status).toBe(201);
    // A grandchild is part of the same request.
    const second = await handOffChild(agentB, first.body.id, { assigneeAgentId: agentC.agentId }, "Round 2");
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    // So is the company-level create with a parent.
    const third = await request(app(agentA.actor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Round 3", status: "todo", parentId: root.id, assigneeAgentId: agentC.agentId });
    expect(third.status, JSON.stringify(third.body)).toBe(201);
    const [thirdHandoff] = await rows(third.body.id, AGENT_HANDOFF_ACTION);
    expect(thirdHandoff?.details).toMatchObject({ rootIssueId: root.id, round: 3 });

    const before = await db.select({ id: issues.id }).from(issues).where(eq(issues.parentId, second.body.id));
    const fourth = await handOffChild(agentC, second.body.id, { assigneeAgentId: agentA.agentId }, "Round 4");
    expect(fourth.status, JSON.stringify(fourth.body)).toBe(422);
    expect(fourth.body.details).toMatchObject({ code: AGENT_HANDOFF_CAP_CODE, rounds: 3, cap: 3, rootIssueId: root.id });
    expect(fourth.body.error).toMatch(/ask your person/i);
    expect(fourth.body.error).toMatch(/ask_user_questions/);
    const after = await db.select({ id: issues.id }).from(issues).where(eq(issues.parentId, second.body.id));
    expect(after).toHaveLength(before.length);

    // The refusal is on the record where the agent was working.
    const refusals = await rows(second.body.id, AGENT_HANDOFF_REFUSED_ACTION);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.details).toMatchObject({ rootIssueId: root.id, rounds: 3, cap: 3, toAgentId: agentA.agentId });

    // A routed person assignment is the same hand-off and is refused the same way.
    const routed = await handOffChild(agentA, root.id, { assigneeUserId: agentB.userId }, "Round 4, by name");
    expect(routed.status, JSON.stringify(routed.body)).toBe(422);
    expect(routed.body.details).toMatchObject({ code: AGENT_HANDOFF_CAP_CODE });

    // An unparented issue created from a run on the request is still the request.
    const unparented = await request(app(agentA.actor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Round 4, without a parent", status: "todo", assigneeAgentId: agentB.agentId });
    // Agent A's run has no issue context here, so this one is a new request.
    expect(unparented.status, JSON.stringify(unparented.body)).toBe(201);

    // People are never capped, and an agent may still create work for itself.
    const byPerson = await request(app(ownerActor))
      .post(`/api/issues/${root.id}/children`)
      .send({ title: "A person adds help", status: "todo", assigneeAgentId: agentB.agentId });
    expect(byPerson.status, JSON.stringify(byPerson.body)).toBe(201);
    const ownWork = await handOffChild(agentA, root.id, { assigneeAgentId: agentA.agentId }, "Agent A's own piece");
    expect(ownWork.status, JSON.stringify(ownWork.body)).toBe(201);
  });

  it("treats an unparented hand-off from a run on the request as part of that request", async () => {
    const root = await rootRequest();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: COMPANY, agentId: agentA.agentId, status: "running",
      contextSnapshot: { issueId: root.id, taskId: root.id },
    });
    const actor = { ...agentA.actor, runId };
    for (let round = 1; round <= AGENT_HANDOFF_ROUND_CAP; round += 1) {
      const res = await request(app(actor))
        .post(`/api/companies/${COMPANY}/issues`)
        .send({ title: `Unparented round ${round}`, status: "todo", assigneeAgentId: round % 2 ? agentB.agentId : agentC.agentId });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const [handoff] = await rows(res.body.id, AGENT_HANDOFF_ACTION);
      expect(handoff?.details).toMatchObject({ rootIssueId: root.id, round });
    }
    const refused = await request(app(actor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Unparented round 4", status: "todo", assigneeAgentId: agentB.agentId });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.details).toMatchObject({ code: AGENT_HANDOFF_CAP_CODE, rootIssueId: root.id });
  });

  it("refuses an agent reassigning an issue in a capped request to another agent", async () => {
    const root = await rootRequest();
    for (let round = 1; round <= AGENT_HANDOFF_ROUND_CAP; round += 1) {
      const res = await handOffChild(agentA, root.id, { assigneeAgentId: agentB.agentId }, `Round ${round}`);
      expect(res.status).toBe(201);
    }
    const [own] = await db
      .insert(issues)
      .values({ companyId: COMPANY, title: "Agent A's piece", status: "todo", parentId: root.id, assigneeAgentId: agentA.agentId })
      .returning();
    const res = await request(app(agentA.actor)).patch(`/api/issues/${own!.id}`).send({ assigneeAgentId: agentC.agentId });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: AGENT_HANDOFF_CAP_CODE, rounds: 3, cap: 3 });
    const [unchanged] = await db.select().from(issues).where(eq(issues.id, own!.id));
    expect(unchanged!.assigneeAgentId).toBe(agentA.agentId);
    expect(await rows(own!.id, AGENT_HANDOFF_REFUSED_ACTION)).toHaveLength(1);
  });

  it("records an agent's reassignment to another agent as a round", async () => {
    const root = await rootRequest();
    const [own] = await db
      .insert(issues)
      .values({ companyId: COMPANY, title: "Agent A's piece", status: "todo", parentId: root.id, assigneeAgentId: agentA.agentId })
      .returning();
    const res = await request(app(agentA.actor)).patch(`/api/issues/${own!.id}`).send({ assigneeAgentId: agentB.agentId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [handoff] = await rows(own!.id, AGENT_HANDOFF_ACTION);
    expect(handoff?.details).toMatchObject({ rootIssueId: root.id, fromAgentId: agentA.agentId, toAgentId: agentB.agentId, round: 1, via: "reassign" });
  });

  it("records a hand-off sent back to the agent that sent it, with the reason, and never refuses it", async () => {
    const root = await rootRequest();
    const child = await handOffChild(agentA, root.id, { assigneeAgentId: agentB.agentId }, "Round 1");
    expect(child.status).toBe(201);
    await handOffChild(agentA, root.id, { assigneeAgentId: agentC.agentId }, "Round 2");
    await handOffChild(agentA, root.id, { assigneeAgentId: agentC.agentId }, "Round 3");

    // At the cap, sending work back still goes through: refusing it would strand it.
    const sentBack = await request(app(agentB.actor))
      .patch(`/api/issues/${child.body.id}`)
      .send({ assigneeAgentId: agentA.agentId, comment: "The brief names no period; I cannot pick one for you." });
    expect(sentBack.status, JSON.stringify(sentBack.body)).toBe(200);
    expect(sentBack.body.assigneeAgentId).toBe(agentA.agentId);

    const returned = await rows(child.body.id, AGENT_HANDOFF_RETURNED_ACTION);
    expect(returned).toHaveLength(1);
    expect(returned[0]!.details).toMatchObject({
      rootIssueId: root.id,
      parentIssueId: root.id,
      fromAgentId: agentB.agentId,
      toAgentId: agentA.agentId,
      kind: "reassigned",
      reason: "The brief names no period; I cannot pick one for you.",
      round: 4,
    });
    expect(await rows(child.body.id, AGENT_HANDOFF_ACTION)).toHaveLength(1);
  });

  /**
   * A person assigned the piece to Agent B; no agent handed it over. Agent B
   * passing it to the parent's agent is a hand-off of its own, not work sent
   * back: it is capped, and the activity never says "sent back".
   */
  it("treats passing on work a person assigned as a hand-off, not a return", async () => {
    const root = await rootRequest();
    const [assignedByPerson] = await db
      .insert(issues)
      .values({ companyId: COMPANY, title: "Assigned by a person", status: "todo", parentId: root.id, assigneeAgentId: agentB.agentId })
      .returning();
    const passed = await request(app(agentB.actor))
      .patch(`/api/issues/${assignedByPerson!.id}`)
      .send({ assigneeAgentId: agentA.agentId, comment: "This is Agent A's area." });
    expect(passed.status, JSON.stringify(passed.body)).toBe(200);
    expect(await rows(assignedByPerson!.id, AGENT_HANDOFF_RETURNED_ACTION)).toHaveLength(0);
    const [handoff] = await rows(assignedByPerson!.id, AGENT_HANDOFF_ACTION);
    expect(handoff?.details).toMatchObject({ fromAgentId: agentB.agentId, toAgentId: agentA.agentId, via: "reassign", round: 1 });

    // At the cap the same move is refused, because nothing is being sent back.
    const capped = await rootRequest("Capped request");
    for (let round = 1; round <= AGENT_HANDOFF_ROUND_CAP; round += 1) {
      expect((await handOffChild(agentA, capped.id, { assigneeAgentId: agentC.agentId }, `Round ${round}`)).status).toBe(201);
    }
    const [cappedPiece] = await db
      .insert(issues)
      .values({ companyId: COMPANY, title: "Assigned by a person, capped", status: "todo", parentId: capped.id, assigneeAgentId: agentB.agentId })
      .returning();
    const refused = await request(app(agentB.actor))
      .patch(`/api/issues/${cappedPiece!.id}`)
      .send({ assigneeAgentId: agentA.agentId });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.details).toMatchObject({ code: AGENT_HANDOFF_CAP_CODE });
    expect(await rows(cappedPiece!.id, AGENT_HANDOFF_RETURNED_ACTION)).toHaveLength(0);
  });

  it("answers a create for an agent that does not exist with the create's own 404, not the cap, even at the cap", async () => {
    const root = await rootRequest();
    for (let round = 1; round <= AGENT_HANDOFF_ROUND_CAP; round += 1) {
      expect((await handOffChild(agentA, root.id, { assigneeAgentId: agentB.agentId }, `Round ${round}`)).status).toBe(201);
    }
    const ghost = randomUUID();
    const child = await handOffChild(agentA, root.id, { assigneeAgentId: ghost }, "To nobody");
    expect(child.status, JSON.stringify(child.body)).toBe(404);
    const companyLevel = await request(app(agentA.actor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "To nobody either", status: "todo", parentId: root.id, assigneeAgentId: ghost });
    expect(companyLevel.status, JSON.stringify(companyLevel.body)).toBe(404);
    const refusals = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, AGENT_HANDOFF_REFUSED_ACTION), eq(activityLog.entityId, root.id)));
    expect(refusals).toHaveLength(0);
  });

  it("records a declined hand-off (cancelled by the receiving agent) as returned, and wakes the parent's agent", async () => {
    const root = await rootRequest();
    const child = await handOffChild(agentA, root.id, { assigneeAgentId: agentB.agentId });
    const declined = await request(app(agentB.actor))
      .patch(`/api/issues/${child.body.id}`)
      .send({ status: "cancelled", comment: "Not my area: this needs the legal view." });
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    const returned = await rows(child.body.id, AGENT_HANDOFF_RETURNED_ACTION);
    expect(returned).toHaveLength(1);
    expect(returned[0]!.details).toMatchObject({
      kind: "declined",
      fromAgentId: agentB.agentId,
      toAgentId: agentA.agentId,
      reason: "Not my area: this needs the legal view.",
    });
    await waitForChildrenCompletedWake(agentA.agentId, root.id, child.body.id);
  });

  /**
   * Agent A hands a piece to Agent B and waits. When Agent B finishes, Agent A
   * must wake on its own request — the existing `issue_children_completed`
   * wake. Pinned here because the whole hand-off design leans on it.
   */
  it("wakes the parent's agent when the handed-off child is done", async () => {
    const root = await rootRequest();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, root.id));
    const child = await handOffChild(agentA, root.id, { assigneeAgentId: agentB.agentId });
    expect(child.status).toBe(201);
    const done = await request(app(agentB.actor))
      .patch(`/api/issues/${child.body.id}`)
      .send({ status: "done", comment: "Figures checked; the table is in the document." });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const wake = await waitForChildrenCompletedWake(agentA.agentId, root.id, child.body.id);
    expect(wake.source).toBe("automation");
    expect(wake.payload).toMatchObject({ issueId: root.id, completedChildIssueId: child.body.id, childIssueIds: [child.body.id] });
    expect(await rows(child.body.id, AGENT_HANDOFF_RETURNED_ACTION)).toHaveLength(0);
  });

  it("emitHandoffReturned records the reason on the issue activity", async () => {
    const root = await rootRequest();
    const [child] = await db
      .insert(issues)
      .values({ companyId: COMPANY, title: "Direct", status: "todo", parentId: root.id, assigneeAgentId: agentB.agentId })
      .returning();
    await emitHandoffReturned(db, {
      companyId: COMPANY,
      issueId: child!.id,
      parentIssueId: root.id,
      rootIssueId: root.id,
      fromAgentId: agentB.agentId,
      toAgentId: agentA.agentId,
      kind: "reassigned",
      reason: null,
      runId: null,
    });
    const [row] = await rows(child!.id, AGENT_HANDOFF_RETURNED_ACTION);
    expect(row?.details).toMatchObject({ reason: null, kind: "reassigned", round: 1 });
    expect(row?.actorType).toBe("agent");
    expect(row?.actorId).toBe(agentB.agentId);
  });

  it("neither records nor caps hand-offs while the company's co-worker flag is off", async () => {
    await db.update(featureFlags).set({ enabled: false })
      .where(and(eq(featureFlags.companyId, COMPANY), eq(featureFlags.flagKey, COWORKER_BRIDGE_FLAG)));
    try {
      const root = await rootRequest("Request in a company without the flag");
      for (let round = 1; round <= AGENT_HANDOFF_ROUND_CAP + 1; round += 1) {
        const res = await handOffChild(agentA, root.id, { assigneeAgentId: agentB.agentId }, `Unflagged ${round}`);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(await rows(res.body.id, AGENT_HANDOFF_ACTION)).toHaveLength(0);
      }
      const tally = await request(app(agentA.actor)).get(`/api/issues/${root.id}/agent-handoffs`);
      expect(tally.status).toBe(200);
      expect(tally.body).toMatchObject({ capEnforced: false, rounds: 0 });
    } finally {
      await db.update(featureFlags).set({ enabled: true })
        .where(and(eq(featureFlags.companyId, COMPANY), eq(featureFlags.flagKey, COWORKER_BRIDGE_FLAG)));
    }
  });

  describe("GET /issues/:id/agent-handoffs", () => {
    it("tells the agent the rounds used, the deliverable owner and the cost so far", async () => {
      const root = await rootRequest("Request with a tally");
      const child = await handOffChild(agentA, root.id, { assigneeAgentId: agentB.agentId });
      await db.insert(costEvents).values([
        { companyId: COMPANY, agentId: agentA.agentId, issueId: root.id, provider: "test", model: "test", costCents: 120, occurredAt: new Date() },
        { companyId: COMPANY, agentId: agentB.agentId, issueId: child.body.id, provider: "test", model: "test", costCents: 30, occurredAt: new Date() },
      ]);

      const res = await request(app(agentB.actor)).get(`/api/issues/${child.body.id}/agent-handoffs`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        capEnforced: true,
        request: { issueId: root.id },
        deliverableOwnerAgentId: agentA.agentId,
        rounds: 1,
        cap: AGENT_HANDOFF_ROUND_CAP,
        remaining: AGENT_HANDOFF_ROUND_CAP - 1,
        costCents: 150,
      });
      expect(res.body.handoffs).toEqual([
        expect.objectContaining({ issueId: child.body.id, kind: "handoff", fromAgentId: agentA.agentId, toAgentId: agentB.agentId, round: 1 }),
      ]);
    });

    it("leaves the cost out for a member who may not read spend", async () => {
      const root = await rootRequest("Request read by a member");
      await handOffChild(agentA, root.id, { assigneeAgentId: agentB.agentId });
      const res = await request(app(memberActor(agentA.userId))).get(`/api/issues/${root.id}/agent-handoffs`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.rounds).toBe(1);
      expect(res.body.costCents).toBeNull();
    });

    it("answers 404 for an issue that does not exist", async () => {
      const res = await request(app(agentA.actor)).get(`/api/issues/${randomUUID()}/agent-handoffs`);
      expect(res.status).toBe(404);
    });

    /**
     * The root sits in a restricted project the reader is not on; one piece
     * of the request is in the open. The reader gets 404 for the root, and
     * from the open piece neither the request nor its owner nor the restricted
     * piece's hand-off. The round count is the request's whole count, the one
     * the cap enforces (services/agent-handoffs.ts, summarizeRequestHandoffs).
     */
    it("keeps a restricted request's root, owner and restricted hand-offs from a reader who is not on the project", async () => {
      const [restricted] = await db
        .insert(projects)
        .values({ companyId: COMPANY, name: "Restricted work", visibility: "restricted" })
        .returning();
      const [root] = await db
        .insert(issues)
        .values({ companyId: COMPANY, title: "Restricted request", status: "in_progress", assigneeAgentId: agentA.agentId, projectId: restricted!.id })
        .returning();
      const [openPiece] = await db
        .insert(issues)
        .values({ companyId: COMPANY, title: "Open piece", status: "todo", parentId: root!.id, assigneeAgentId: agentB.agentId })
        .returning();
      const [hiddenPiece] = await db
        .insert(issues)
        .values({ companyId: COMPANY, title: "Restricted piece", status: "todo", parentId: root!.id, assigneeAgentId: agentC.agentId, projectId: restricted!.id })
        .returning();
      for (const [piece, toAgentId] of [[openPiece!, agentB.agentId], [hiddenPiece!, agentC.agentId]] as const) {
        await recordAgentHandoff(db, {
          companyId: COMPANY, issueId: piece.id, parentIssueId: root!.id, rootIssueId: root!.id,
          fromAgentId: agentA.agentId, toAgentId, runId: null, via: "child_create",
        });
      }

      const reader = memberActor(agentB.userId);
      const rootRes = await request(app(reader)).get(`/api/issues/${root!.id}/agent-handoffs`);
      expect(rootRes.status).toBe(404);
      const hiddenRes = await request(app(reader)).get(`/api/issues/${hiddenPiece!.id}/agent-handoffs`);
      expect(hiddenRes.status).toBe(404);

      const res = await request(app(reader)).get(`/api/issues/${openPiece!.id}/agent-handoffs`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.request).toBeNull();
      expect(res.body.deliverableOwnerAgentId).toBeNull();
      expect(res.body.handoffs).toEqual([expect.objectContaining({ issueId: openPiece!.id, toAgentId: agentB.agentId })]);
      expect(JSON.stringify(res.body)).not.toContain(hiddenPiece!.id);
      expect(JSON.stringify(res.body)).not.toContain(agentC.agentId);
      expect(res.body).toMatchObject({ rounds: 2, remaining: AGENT_HANDOFF_ROUND_CAP - 2 });

      // The owner reads the whole request.
      const full = await request(app(ownerActor)).get(`/api/issues/${openPiece!.id}/agent-handoffs`);
      expect(full.status, JSON.stringify(full.body)).toBe(200);
      expect(full.body).toMatchObject({ request: { issueId: root!.id }, deliverableOwnerAgentId: agentA.agentId, rounds: 2 });
      expect(full.body.handoffs).toHaveLength(2);
    });
  });
});
