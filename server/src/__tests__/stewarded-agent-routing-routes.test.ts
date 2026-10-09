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
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { buildPaperclipTaskMarkdown, STEWARD_ROUTED_TASK_NOTE } from "../services/heartbeat.js";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash: "have a colleague do X". Steward A's agent used to assign the issue
 * to the colleague (Steward B) as a decision item, while Agent B — the agent
 * Steward B stewards and the one that does their work — never woke. People
 * remember names, not agents: any assignment of a person who stewards an
 * active agent — by a person or an agent, including a person assigning
 * themselves — now goes to that agent, which takes the first pass.
 */
describeEmbeddedPostgres("a person assignment is routed to the agent that person stewards", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const COMPANY = randomUUID();
  const AGENT_A = randomUUID(); // stewarded by steward-a; the caller
  const AGENT_B = randomUUID(); // stewarded by steward-b
  const PAUSED_AGENT = randomUUID(); // stewarded by steward-c, paused
  const TERMINATED_AGENT = randomUUID(); // stewarded by steward-t
  const PENDING_AGENT = randomUUID(); // stewarded by steward-p
  const AGENT_E = randomUUID(); // no tasks:assign, no steward; does work for others
  const OTHER_COMPANY = randomUUID();
  const OTHER_COMPANY_AGENT = randomUUID(); // member-d stewards it, in another company
  const AGENT_A_RUN = randomUUID();
  const AGENT_A_KEY = randomUUID();
  const AGENT_E_RUN = randomUUID();
  const AGENT_E_KEY = randomUUID();

  // Wakes are recorded but no run starts: on-demand wakes are switched off, so
  // the heartbeat writes a skipped wake request naming the issue.
  const noRunRuntime = { heartbeat: { enabled: false, wakeOnDemand: false } };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stewarded-routing-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({ id: COMPANY, name: "Steward Routing Co", issuePrefix: "SRC" });
    await db.insert(companyMemberships).values(
      ["owner", "steward-a", "steward-b", "steward-c", "member-d", "steward-t", "steward-p"].map((principalId) => ({
        companyId: COMPANY,
        principalType: "user",
        principalId,
        status: "active",
        membershipRole: principalId === "owner" ? "owner" : "member",
      })),
    );
    await db.insert(agents).values([
      // canCreateAgents carries legacy tasks:assign authority.
      { id: AGENT_A, companyId: COMPANY, name: "Agent A", role: "general", status: "idle", permissions: { canCreateAgents: true }, runtimeConfig: noRunRuntime },
      { id: AGENT_B, companyId: COMPANY, name: "Agent B", role: "general", status: "idle", runtimeConfig: noRunRuntime },
      { id: PAUSED_AGENT, companyId: COMPANY, name: "Agent C", role: "general", status: "paused", runtimeConfig: noRunRuntime },
      { id: TERMINATED_AGENT, companyId: COMPANY, name: "Agent T", role: "general", status: "terminated", runtimeConfig: noRunRuntime },
      { id: PENDING_AGENT, companyId: COMPANY, name: "Agent P", role: "general", status: "pending_approval", runtimeConfig: noRunRuntime },
      { id: AGENT_E, companyId: COMPANY, name: "Agent E", role: "general", status: "idle", runtimeConfig: noRunRuntime },
    ]);
    await db.insert(companies).values({ id: OTHER_COMPANY, name: "Other Co", issuePrefix: "OTH" });
    await db.insert(agents).values({ id: OTHER_COMPANY_AGENT, companyId: OTHER_COMPANY, name: "Agent D", role: "general", status: "idle", runtimeConfig: noRunRuntime });
    await db.insert(agentStewardships).values([
      { companyId: COMPANY, agentId: AGENT_A, userId: "steward-a" },
      { companyId: COMPANY, agentId: AGENT_B, userId: "steward-b" },
      { companyId: COMPANY, agentId: PAUSED_AGENT, userId: "steward-c" },
      { companyId: COMPANY, agentId: TERMINATED_AGENT, userId: "steward-t" },
      { companyId: COMPANY, agentId: PENDING_AGENT, userId: "steward-p" },
      { companyId: OTHER_COMPANY, agentId: OTHER_COMPANY_AGENT, userId: "member-d" },
    ]);
    await db.insert(heartbeatRuns).values({ id: AGENT_A_RUN, companyId: COMPANY, agentId: AGENT_A, status: "running" });
    // PATCH re-reads the caller's credential, so Agent A needs a real key row.
    await db.insert(agentApiKeys).values({ id: AGENT_A_KEY, agentId: AGENT_A, companyId: COMPANY, name: "test", keyHash: "unused" });
    await db.insert(heartbeatRuns).values({ id: AGENT_E_RUN, companyId: COMPANY, agentId: AGENT_E, status: "running" });
    await db.insert(agentApiKeys).values({ id: AGENT_E_KEY, agentId: AGENT_E, companyId: COMPANY, name: "test", keyHash: "unused-e" });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const boardActor = {
    type: "board",
    source: "session",
    userId: "owner",
    companyIds: [COMPANY],
    memberships: [{ companyId: COMPANY, membershipRole: "owner", status: "active" }],
  };
  const agentAActor = { type: "agent", agentId: AGENT_A, companyId: COMPANY, source: "agent_key", keyId: AGENT_A_KEY, runId: AGENT_A_RUN };
  const agentEActor = { type: "agent", agentId: AGENT_E, companyId: COMPANY, source: "agent_key", keyId: AGENT_E_KEY, runId: AGENT_E_RUN };

  function memberActor(userId: string, companyId = COMPANY) {
    return {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "member", status: "active" }],
    };
  }

  /**
   * A steward and the agent they steward, made for one test so no other test's
   * issues or wakes are in its way.
   */
  async function freshSteward(options: { withKey?: boolean; companyId?: string; visibility?: "owner" } = {}) {
    const companyId = options.companyId ?? COMPANY;
    const userId = `steward-${randomUUID()}`;
    const agentId = randomUUID();
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId, companyId, name: `Agent ${agentId.slice(0, 8)}`, role: "general", status: "idle", runtimeConfig: noRunRuntime,
      ...(options.visibility ? { visibility: options.visibility } : {}),
    });
    await db.insert(agentStewardships).values({ companyId, agentId, userId });
    if (!options.withKey) return { userId, agentId, actor: null };
    const runId = randomUUID();
    const keyId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    await db.insert(agentApiKeys).values({ id: keyId, agentId, companyId, name: "test", keyHash: `unused-${keyId}` });
    return { userId, agentId, actor: { type: "agent", agentId, companyId, source: "agent_key", keyId, runId } };
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

  async function activityDetails(issueId: string, action: string) {
    const rows = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, action)));
    return rows.map((row) => row.details as Record<string, unknown>);
  }

  async function waitForWake(agentId: string, issueId: string) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      const wake = rows.find((row) => (row.payload as Record<string, unknown> | null)?.issueId === issueId);
      if (wake) return wake;
      if (Date.now() > deadline) throw new Error(`no wake for agent ${agentId} on issue ${issueId}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it("routes an agent's assignment of a person to the agent that person stewards, and wakes it", async () => {
    const res = await request(app(agentAActor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Steward B: draft the plan", status: "todo", assigneeUserId: "steward-b" });
    expect(res.status).toBe(201);
    expect(res.body.assigneeAgentId).toBe(AGENT_B);
    expect(res.body.assigneeUserId).toBeNull();
    expect(res.body.routedToStewardedAgent).toEqual({ fromUserId: "steward-b", toAgentId: AGENT_B });

    const [created] = await activityDetails(res.body.id, "issue.created");
    expect(created).toMatchObject({ routedToStewardedAgent: { fromUserId: "steward-b", toAgentId: AGENT_B } });

    const wake = await waitForWake(AGENT_B, res.body.id);
    expect(wake.source).toBe("assignment");
    expect(wake.payload).toMatchObject({ routedFromStewardUserId: "steward-b" });
  });

  it("routes a child issue the same way", async () => {
    const parent = await request(app(agentAActor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Parent", status: "backlog" });
    const child = await request(app(agentAActor))
      .post(`/api/issues/${parent.body.id}/children`)
      .send({ title: "Steward B: check the numbers", status: "todo", assigneeUserId: "steward-b" });
    expect(child.status).toBe(201);
    expect(child.body.assigneeAgentId).toBe(AGENT_B);
    expect(child.body.assigneeUserId).toBeNull();
    const [created] = await activityDetails(child.body.id, "issue.child_created");
    expect(created).toMatchObject({ routedToStewardedAgent: { fromUserId: "steward-b", toAgentId: AGENT_B } });
    await waitForWake(AGENT_B, child.body.id);
  });

  it("routes a person's assignment of a person too, and wakes the agent with the steward context", async () => {
    const steward = await freshSteward();
    const res = await request(app(boardActor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "For the steward", status: "todo", assigneeUserId: steward.userId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.assigneeAgentId).toBe(steward.agentId);
    expect(res.body.assigneeUserId).toBeNull();
    expect(res.body.routedToStewardedAgent).toEqual({ fromUserId: steward.userId, toAgentId: steward.agentId });

    const wake = await waitForWake(steward.agentId, res.body.id);
    expect(wake.source).toBe("assignment");
    expect(wake.payload).toMatchObject({ issueId: res.body.id, routedFromStewardUserId: steward.userId });
  });

  it("routes a person assigning themselves to their own agent", async () => {
    const steward = await freshSteward();
    const res = await request(app(memberActor(steward.userId)))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Mine", status: "todo", assigneeUserId: steward.userId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.assigneeAgentId).toBe(steward.agentId);
    expect(res.body.assigneeUserId).toBeNull();
    expect(res.body.routedToStewardedAgent).toEqual({ fromUserId: steward.userId, toAgentId: steward.agentId });
    const wake = await waitForWake(steward.agentId, res.body.id);
    expect(wake.payload).toMatchObject({ routedFromStewardUserId: steward.userId, mutation: "create" });
  });

  it("routes a person's PATCH reassignment and wakes the agent with the steward context", async () => {
    const steward = await freshSteward();
    const created = await request(app(boardActor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Unassigned (board)", status: "todo" });
    expect(created.status).toBe(201);
    // The local board operator: PATCH re-reads a session credential this
    // harness does not mint, and the rule does not depend on the source.
    const res = await request(app({ type: "board", source: "local_implicit", userId: "owner", companyIds: [COMPANY] }))
      .patch(`/api/issues/${created.body.id}`)
      .send({ assigneeUserId: steward.userId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.assigneeAgentId).toBe(steward.agentId);
    expect(res.body.assigneeUserId).toBeNull();
    const wake = await waitForWake(steward.agentId, created.body.id);
    expect(wake.payload).toMatchObject({ routedFromStewardUserId: steward.userId, mutation: "update" });
  });

  it("keeps the person when a person opts out with assignToPerson", async () => {
    const steward = await freshSteward();
    const res = await request(app(boardActor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "The steward must sign this", status: "todo", assigneeUserId: steward.userId, assignToPerson: true });
    expect(res.status).toBe(201);
    expect(res.body.assigneeUserId).toBe(steward.userId);
    expect(res.body.assigneeAgentId).toBeNull();
    expect(res.body.routedToStewardedAgent).toBeUndefined();
  });

  it("lets a steward's own agent hand an issue to its steward without routing it back", async () => {
    const steward = await freshSteward({ withKey: true });
    const [issue] = await db
      .insert(issues)
      .values({ companyId: COMPANY, title: "Needs the steward", status: "todo", assigneeAgentId: steward.agentId })
      .returning();
    const res = await request(app(steward.actor!))
      .patch(`/api/issues/${issue!.id}`)
      .send({ assigneeAgentId: null, assigneeUserId: steward.userId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.assigneeUserId).toBe(steward.userId);
    expect(res.body.assigneeAgentId).toBeNull();
    expect(res.body.routedToStewardedAgent).toBeUndefined();
  });

  it("keeps the person when the caller cannot see their agent", async () => {
    // Agent visibility: work is never given to an agent the caller cannot see.
    const company = randomUUID();
    await db.insert(companies).values({ id: company, name: "Visibility Co", issuePrefix: `V${company.slice(0, 3).toUpperCase()}` });
    const hidden = await freshSteward({ companyId: company, visibility: "owner" });
    const viewer = `viewer-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId: company, principalType: "user", principalId: viewer, status: "active", membershipRole: "member" });
    const res = await request(app(memberActor(viewer, company)))
      .post(`/api/companies/${company}/issues`)
      .send({ title: "For the hidden steward", status: "todo", assigneeUserId: hidden.userId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.assigneeUserId).toBe(hidden.userId);
    expect(res.body.assigneeAgentId).toBeNull();
  });

  it("keeps the person when the agent opts out with assignToPerson", async () => {
    const res = await request(app(agentAActor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Steward B must sign this", status: "todo", assigneeUserId: "steward-b", assignToPerson: true });
    expect(res.status).toBe(201);
    expect(res.body.assigneeUserId).toBe("steward-b");
    expect(res.body.assigneeAgentId).toBeNull();
    expect(res.body).not.toHaveProperty("assignToPerson");
    const [created] = await activityDetails(res.body.id, "issue.created");
    expect(created).not.toHaveProperty("routedToStewardedAgent");
  });

  it("does not route the calling agent's own steward back to it", async () => {
    const res = await request(app(agentAActor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Steward A: approve this", status: "todo", assigneeUserId: "steward-a" });
    expect(res.status).toBe(201);
    expect(res.body.assigneeUserId).toBe("steward-a");
    expect(res.body.assigneeAgentId).toBeNull();
  });

  it("keeps the person when their agent is paused", async () => {
    const res = await request(app(agentAActor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Steward C: review", status: "todo", assigneeUserId: "steward-c" });
    expect(res.status).toBe(201);
    expect(res.body.assigneeUserId).toBe("steward-c");
    expect(res.body.assigneeAgentId).toBeNull();
  });

  for (const [label, userId] of [["terminated", "steward-t"], ["pending approval", "steward-p"]] as const) {
    it(`keeps the person when their agent is ${label}`, async () => {
      const res = await request(app(agentAActor))
        .post(`/api/companies/${COMPANY}/issues`)
        .send({ title: `Review (${label})`, status: "todo", assigneeUserId: userId });
      expect(res.status).toBe(201);
      expect(res.body.assigneeUserId).toBe(userId);
      expect(res.body.assigneeAgentId).toBeNull();
    });
  }

  it("ignores a stewardship the person holds in another company", async () => {
    const res = await request(app(agentAActor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Member D: cross-company", status: "todo", assigneeUserId: "member-d" });
    expect(res.status).toBe(201);
    expect(res.body.assigneeUserId).toBe("member-d");
    expect(res.body.assigneeAgentId).toBeNull();
  });

  it("lets an agent without tasks:assign hand its issue back to the person who created it", async () => {
    // Steward B created the issue for Agent E. Handing it back for review is
    // the return-to-creator exemption, not delegation: it stays with Steward B
    // rather than going to Agent B, and needs no tasks:assign.
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: COMPANY,
        title: "Draft for Steward B",
        status: "todo",
        assigneeAgentId: AGENT_E,
        createdByUserId: "steward-b",
      })
      .returning();
    const res = await request(app(agentEActor))
      .patch(`/api/issues/${issue!.id}`)
      .send({ status: "in_review", assigneeAgentId: null, assigneeUserId: "steward-b" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.assigneeUserId).toBe("steward-b");
    expect(res.body.assigneeAgentId).toBeNull();
    expect(res.body.routedToStewardedAgent).toBeUndefined();
  });

  it("keeps the person when they steward no agent", async () => {
    const res = await request(app(agentAActor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Member D: review", status: "todo", assigneeUserId: "member-d" });
    expect(res.status).toBe(201);
    expect(res.body.assigneeUserId).toBe("member-d");
    expect(res.body.assigneeAgentId).toBeNull();
  });

  it("routes a PATCH reassignment to the person's agent and wakes it", async () => {
    const created = await request(app(agentAActor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Unassigned for now", status: "backlog" });
    expect(created.status).toBe(201);

    const res = await request(app(agentAActor))
      .patch(`/api/issues/${created.body.id}`)
      .send({ assigneeUserId: "steward-b", status: "todo" });
    expect(res.status).toBe(200);
    expect(res.body.assigneeAgentId).toBe(AGENT_B);
    expect(res.body.assigneeUserId).toBeNull();
    expect(res.body.routedToStewardedAgent).toEqual({ fromUserId: "steward-b", toAgentId: AGENT_B });

    const updates = await activityDetails(created.body.id, "issue.updated");
    expect(updates.some((details) => (details.routedToStewardedAgent as { toAgentId?: string } | undefined)?.toAgentId === AGENT_B)).toBe(true);
    expect(updates.every((details) => !("assignToPerson" in details))).toBe(true);

    await waitForWake(AGENT_B, created.body.id);
  });

  it("keeps a PATCH person assignment when the agent opts out", async () => {
    const created = await request(app(agentAActor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Decision for Steward B", status: "backlog" });
    const res = await request(app(agentAActor))
      .patch(`/api/issues/${created.body.id}`)
      .send({ assigneeUserId: "steward-b", assignToPerson: true });
    expect(res.status).toBe(200);
    expect(res.body.assigneeUserId).toBe("steward-b");
    expect(res.body.assigneeAgentId).toBeNull();
  });

  it("leaves a person who already holds the issue alone when an agent patches it", async () => {
    const created = await request(app(boardActor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Steward B's own call", status: "todo", assigneeUserId: "steward-b", assignToPerson: true });
    const res = await request(app(agentAActor))
      .patch(`/api/issues/${created.body.id}`)
      .send({ assigneeUserId: "steward-b", priority: "high" });
    expect(res.status).toBe(200);
    expect(res.body.assigneeUserId).toBe("steward-b");
    expect(res.body.assigneeAgentId).toBeNull();
    expect(res.body.routedToStewardedAgent).toBeUndefined();
  });

  it("drafts a suggested task for the person's agent, and acceptance assigns and wakes it", async () => {
    const parent = await request(app(agentAActor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Plan", status: "backlog" });
    const suggested = await request(app(agentAActor))
      .post(`/api/issues/${parent.body.id}/interactions`)
      .send({
        kind: "suggest_tasks",
        payload: {
          version: 1,
          tasks: [
            { clientKey: "b-task", title: "Steward B: model the options", assigneeUserId: "steward-b" },
            { clientKey: "b-decision", title: "Steward B: choose an option", assigneeUserId: "steward-b", assignToPerson: true },
          ],
        },
      });
    expect(suggested.status).toBe(201);
    const [routedTask, keptTask] = suggested.body.payload.tasks;
    expect(routedTask).toMatchObject({ assigneeAgentId: AGENT_B, assigneeUserId: null });
    expect(keptTask).toMatchObject({ assigneeUserId: "steward-b" });
    expect(keptTask).not.toHaveProperty("assignToPerson");
    expect(suggested.body.routedToStewardedAgent).toEqual([{ clientKey: "b-task", fromUserId: "steward-b", toAgentId: AGENT_B }]);

    const accepted = await request(app(boardActor))
      .post(`/api/issues/${parent.body.id}/interactions/${suggested.body.id}/accept`)
      .send({});
    expect(accepted.status).toBe(200);
    const createdTasks = accepted.body.result.createdTasks as Array<{ clientKey: string; issueId: string }>;
    const agentBIssueId = createdTasks.find((task) => task.clientKey === "b-task")!.issueId;
    await waitForWake(AGENT_B, agentBIssueId);
  });

  it("routes a person's suggested-task draft, and acceptance wakes the agent with the steward context", async () => {
    const steward = await freshSteward();
    const parent = await request(app(boardActor))
      .post(`/api/companies/${COMPANY}/issues`)
      .send({ title: "Plan (board)", status: "backlog" });
    const suggested = await request(app(boardActor))
      .post(`/api/issues/${parent.body.id}/interactions`)
      .send({
        kind: "suggest_tasks",
        payload: {
          version: 1,
          tasks: [
            { clientKey: "s-task", title: "Steward: model the options", assigneeUserId: steward.userId },
            // A client cannot claim a draft came via a steward.
            { clientKey: "s-decision", title: "Steward: choose", assigneeUserId: steward.userId, assignToPerson: true, routedFromStewardUserId: "someone-else" },
          ],
        },
      });
    expect(suggested.status, JSON.stringify(suggested.body)).toBe(201);
    const [routedTask, keptTask] = suggested.body.payload.tasks;
    expect(routedTask).toMatchObject({ assigneeAgentId: steward.agentId, assigneeUserId: null, routedFromStewardUserId: steward.userId });
    expect(keptTask).toMatchObject({ assigneeUserId: steward.userId });
    expect(keptTask).not.toHaveProperty("routedFromStewardUserId");
    expect(suggested.body.routedToStewardedAgent).toEqual([{ clientKey: "s-task", fromUserId: steward.userId, toAgentId: steward.agentId }]);

    const accepted = await request(app(boardActor))
      .post(`/api/issues/${parent.body.id}/interactions/${suggested.body.id}/accept`)
      .send({});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const createdTasks = accepted.body.result.createdTasks as Array<{ clientKey: string; issueId: string }>;
    const routedIssueId = createdTasks.find((task) => task.clientKey === "s-task")!.issueId;
    const keptIssueId = createdTasks.find((task) => task.clientKey === "s-decision")!.issueId;
    const wake = await waitForWake(steward.agentId, routedIssueId);
    expect(wake.payload).toMatchObject({ mutation: "interaction_accept", routedFromStewardUserId: steward.userId });
    const [kept] = await db.select().from(issues).where(eq(issues.id, keptIssueId));
    expect(kept).toMatchObject({ assigneeUserId: steward.userId, assigneeAgentId: null });
  });
});

describe("the steward context reaches the run prompt", () => {
  it("names the steward in the task context and the wake prompt", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: { id: "issue-1", identifier: "SRC-1", title: "Draft the plan" },
      routedFromStewardUserId: "steward-a",
    });
    expect(markdown).toContain(STEWARD_ROUTED_TASK_NOTE);
    expect(markdown!.indexOf(STEWARD_ROUTED_TASK_NOTE)).toBeLessThan(markdown!.indexOf("user-authored"));
    expect(buildPaperclipTaskMarkdown({ issue: { id: "issue-1", identifier: "SRC-1", title: "Draft the plan" } }))
      .not.toContain(STEWARD_ROUTED_TASK_NOTE);

    const prompt = renderPaperclipWakePrompt({
      reason: "issue_assigned",
      routedFromStewardUserId: "steward-a",
      issue: { id: "issue-1", identifier: "SRC-1", title: "Draft the plan", status: "todo", priority: "medium" },
    });
    expect(prompt).toContain("- assigned to: your steward (user steward-a)");
    expect(renderPaperclipWakePrompt({ reason: "issue_assigned", issue: { id: "issue-1", title: "Draft the plan" } }))
      .not.toContain("your steward");
  });
});
