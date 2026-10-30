import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agentStewardships,
  agents,
  approvals,
  authUsers,
  budgetPolicies,
  companies,
  companyMemberships,
  connections,
  costEvents,
  createDb,
  evaluationEvents,
  evaluationScorecards,
  issues,
  mandates,
  principalPermissionGrants,
  projectAccess,
  projects,
} from "@paperclipai/db";
import type { AgentAccessInventory } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { errorHandler } from "../middleware/index.js";
import { agentAccessRoutes } from "../routes/agent-access.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;
type Actor = Record<string, unknown>;

/**
 * AgentDash: Agent Performance Management gate 1. The access inventory routes:
 * who may read an agent's access, that agents read only their own, that an
 * agent from another company is nonexistent, and that reading writes nothing.
 */
describeEmbeddedPostgres("agent access inventory routes", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-access-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function addUser(companyId: string, membershipRole: string, name: string) {
    const userId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name, email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole });
    return userId;
  }

  async function addCompany(productProfile: "default" | "agentdash_mk" = "default") {
    return db
      .insert(companies)
      .values({ name: `Access ${randomUUID()}`, issuePrefix: `AC${randomUUID().slice(0, 6).toUpperCase()}`, productProfile })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function addAgent(companyId: string, values: Partial<typeof agents.$inferInsert> & { name: string }) {
    return db
      .insert(agents)
      .values({ companyId, role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: {}, ...values })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seed(productProfile: "default" | "agentdash_mk" = "default") {
    const company = await addCompany(productProfile);
    const ownerUserId = await addUser(company.id, "owner", "Olive Owner");
    const stewardUserId = await addUser(company.id, "member", "Sam Steward");
    const accountableUserId = await addUser(company.id, "member", "Ada Accountable");
    const outsiderUserId = await addUser(company.id, "member", "Otto Outsider");

    const writer = await addAgent(company.id, { name: "Writer" });
    const runner = await addAgent(company.id, { name: "Runner", autonomy: "autonomous", accountableUserId });
    const hidden = await addAgent(company.id, { name: "Hidden", visibility: "owner", createdByUserId: ownerUserId });
    await db.insert(agentStewardships).values({ companyId: company.id, agentId: writer.id, userId: stewardUserId, assignedByUserId: ownerUserId });

    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "agent", principalId: writer.id, status: "active", membershipRole: "member" });
    await db.insert(principalPermissionGrants).values({ companyId: company.id, principalType: "agent", principalId: writer.id, permissionKey: "tasks:assign" });

    await db.insert(projects).values({ companyId: company.id, name: "Open work" });
    const restricted = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Board pack", visibility: "restricted" })
      .returning()
      .then((rows) => rows[0]!);
    const secret = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Payroll", visibility: "restricted", leadAgentId: writer.id })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(projectAccess).values({ projectId: restricted.id, principalType: "agent", principalId: writer.id, grantedByUserId: ownerUserId });

    const gmail = await db
      .insert(connections)
      .values({ companyId: company.id, ownerType: "agent", ownerId: writer.id, provider: "gmail", accountLabel: "writer@example.test" })
      .returning()
      .then((rows) => rows[0]!);
    const slack = await db
      .insert(connections)
      .values({ companyId: company.id, ownerType: "user", ownerId: ownerUserId, provider: "slack", visibility: "workspace", status: "expired" })
      .returning()
      .then((rows) => rows[0]!);
    // Another person's private connection is not the agent's to resolve.
    await db.insert(connections).values({ companyId: company.id, ownerType: "user", ownerId: outsiderUserId, provider: "gmail" });

    const now = new Date();
    await db.insert(budgetPolicies).values({
      companyId: company.id,
      scopeType: "agent",
      scopeId: writer.id,
      windowKind: "calendar_month_utc",
      amount: 10_000,
      hardStopEnabled: true,
    });
    await db.insert(costEvents).values({ companyId: company.id, agentId: writer.id, provider: "anthropic", model: "claude", costCents: 1_234, occurredAt: now });

    await db.insert(mandates).values({
      companyId: company.id,
      grantorAgentId: runner.id,
      granteeAgentId: writer.id,
      scope: ["book_travel"],
      permissionKey: "travel:book",
      spendCapCents: 50_000,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    });

    const agentActivity = (action: string, entityType: string, entityId: string, details: Record<string, unknown>, createdAt = now) => ({
      companyId: company.id,
      actorType: "agent",
      actorId: writer.id,
      agentId: writer.id,
      action,
      entityType,
      entityId,
      details,
      origin: "server" as const,
      createdAt,
    });
    await db.insert(activityLog).values([
      agentActivity("agent.skills_synced", "agent", writer.id, { desiredSkills: ["research"] }),
      // Outside the 30-day window: not counted.
      agentActivity("agent.skills_synced", "agent", writer.id, { desiredSkills: ["old"] }, new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000)),
      agentActivity("agent.updated", "agent", writer.id, { changedTopLevelKeys: ["capabilities", "title"] }),
      agentActivity("issue.thread_interaction_created", "issue", randomUUID(), { interactionKind: "ask_user_questions" }),
      agentActivity("authz.refused", "company", randomUUID(), { reasonCode: "AGENT_CROSS_COMPANY", method: "GET", routePath: "/api/companies/:companyId/issues" }),
    ]);

    const otherCompany = await addCompany();
    const otherOwnerUserId = await addUser(otherCompany.id, "owner", "Other Owner");
    const foreign = await addAgent(otherCompany.id, { name: "Foreign" });

    return {
      company,
      ownerUserId,
      stewardUserId,
      accountableUserId,
      outsiderUserId,
      writer,
      runner,
      hidden,
      restricted,
      secret,
      gmail,
      slack,
      otherCompany,
      otherOwnerUserId,
      foreign,
    };
  }

  function member(companyId: string, userId: string, membershipRole = "member"): Actor {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole, status: "active" }],
    };
  }

  function agentActor(agentId: string, companyId: string, extra: Actor = {}): Actor {
    return { type: "agent", agentId, companyId, source: "agent_key", principalKind: "agent", readOnly: false, ...extra };
  }

  function app(actor: Actor) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as unknown as { actor: Actor }).actor = { ...actor };
      next();
    });
    server.use("/api", agentAccessRoutes(db));
    server.use(errorHandler);
    return server;
  }

  const accessPath = (companyId: string, agentId: string) => `/api/companies/${companyId}/agents/${agentId}/access`;

  function find(inventory: AgentAccessInventory, id: string) {
    const found = inventory.items.find((entry) => entry.id === id);
    expect(found, `item ${id}`).toBeTruthy();
    return found!;
  }

  it("serves a company admin the inventory built from the real records", async () => {
    const s = await seed();
    const res = await request(app(member(s.company.id, s.ownerUserId, "owner"))).get(accessPath(s.company.id, s.writer.id));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const inventory = res.body as AgentAccessInventory;

    expect(inventory).toMatchObject({
      kind: "agent_access_inventory",
      version: "agent-access/0",
      companyId: s.company.id,
      agentId: s.writer.id,
      agentName: "Writer",
      profileDefined: false,
      enforcementMode: "off",
    });
    const windowMs = Date.parse(inventory.window.to) - Date.parse(inventory.window.from);
    expect(windowMs).toBe(30 * 24 * 60 * 60 * 1000);

    expect(find(inventory, "see.projects.open").target?.count).toBe(1);
    expect(find(inventory, `see.project:${s.restricted.id}`).defined.allowed).toBe(true);
    const lead = find(inventory, `see.project:${s.secret.id}`);
    expect(lead.defined.allowed).toBe(false);
    expect(lead.defined.detail).toMatch(/Lead of this project/);

    const gmailRead = find(inventory, `see.connection:${s.gmail.id}`);
    expect(gmailRead.defined.allowed).toBe(true);
    expect(gmailRead.working.state).toBe("ok");
    const slackRead = find(inventory, `see.connection:${s.slack.id}`);
    expect(slackRead.working).toEqual({ state: "not_working", detail: "expired" });
    expect(inventory.gaps).toContainEqual(expect.objectContaining({ code: "CONNECTION_NOT_WORKING", itemId: `see.connection:${s.slack.id}` }));
    // Only the agent's own and workspace-visible connections are listed.
    expect(inventory.items.filter((entry) => entry.id.startsWith("see.connection:"))).toHaveLength(2);
    expect(find(inventory, `do.connection:${s.gmail.id}.send`).defined.allowed).toBe(false);

    expect(find(inventory, "do.permission:tasks:assign").defined).toMatchObject({ allowed: true, source: "permission_grant" });
    expect(find(inventory, "talk.agents.assign").target?.count).toBe(2);
    expect(find(inventory, "spend.budget").working).toEqual({ state: "ok", detail: "Spent $12.34 of $100.00 this month (UTC)" });
    expect(find(inventory, "do.governance").defined.allowed).toBe("unrestricted");
    expect(inventory.gaps.map((gap) => gap.code)).toContain("GOVERNANCE_PROFILE_ONLY");
    expect(inventory.items.some((entry) => entry.id.startsWith("do.mandate:"))).toBe(true);

    expect(find(inventory, "do.skills.self_add").used).toMatchObject({ state: "used", uses: 1, refusals: 0 });
    expect(find(inventory, "do.capabilities.self_edit").used).toMatchObject({ state: "used", uses: 1 });
    expect(find(inventory, "talk.people.questions").used).toMatchObject({ state: "used", uses: 1 });
    expect(find(inventory, "see.company").used).toMatchObject({ state: "refused", uses: null, refusals: 1 });
    expect(typeof find(inventory, "see.company").used.lastAt).toBe("string");

    expect(inventory.hostEnvironment).toMatchObject({ adapterType: "claude_local", kind: "local_host", hostPermissionsRestricted: false });
    expect(inventory.alwaysReachable).toEqual([
      { kind: "user", id: s.stewardUserId, label: "Sam Steward", role: "steward" },
      { kind: "user", id: s.ownerUserId, label: "Olive Owner", role: "admin" },
    ]);
    // Names only; no member email reaches the payload.
    const payload = JSON.stringify(inventory);
    for (const userId of [s.ownerUserId, s.stewardUserId, s.accountableUserId, s.outsiderUserId]) {
      expect(payload).not.toContain(`${userId}@example.test`);
    }
  });

  it("serves the active steward and the accountable person their own agents only", async () => {
    const s = await seed();
    const steward = app(member(s.company.id, s.stewardUserId));
    expect((await request(steward).get(accessPath(s.company.id, s.writer.id))).status).toBe(200);
    expect((await request(steward).get(accessPath(s.company.id, s.runner.id))).status).toBe(403);

    const accountable = app(member(s.company.id, s.accountableUserId));
    const runner = await request(accountable).get(accessPath(s.company.id, s.runner.id));
    expect(runner.status, JSON.stringify(runner.body)).toBe(200);
    expect(runner.body.alwaysReachable[0]).toEqual({ kind: "user", id: s.accountableUserId, label: "Ada Accountable", role: "accountable" });
    expect((await request(accountable).get(accessPath(s.company.id, s.writer.id))).status).toBe(403);
  });

  it("never names a restricted project the viewer can't read; an admin sees them all", async () => {
    const s = await seed();
    const steward = await request(app(member(s.company.id, s.stewardUserId))).get(accessPath(s.company.id, s.writer.id));
    expect(steward.status, JSON.stringify(steward.body)).toBe(200);
    const stewardPayload = JSON.stringify(steward.body);
    for (const project of [s.restricted, s.secret]) {
      expect(stewardPayload).not.toContain(project.id);
      expect(stewardPayload).not.toContain(project.name);
    }
    expect(find(steward.body, "see.projects.open").defined.detail).toBe("1 project. Restricted projects you can't see are not listed");

    const owner = await request(app(member(s.company.id, s.ownerUserId, "owner"))).get(accessPath(s.company.id, s.writer.id));
    const ownerPayload = JSON.stringify(owner.body);
    for (const project of [s.restricted, s.secret]) {
      expect(ownerPayload).toContain(project.id);
      expect(ownerPayload).toContain(project.name);
    }
    expect(find(owner.body, "see.projects.open").defined.detail).toBe("1 project");
    expect(owner.body.refusalsByCode).toEqual({ AGENT_CROSS_COMPANY: 1 });

    // The agent itself reads what it can read: the project it is listed on, not the one it only leads.
    const self = await request(app(agentActor(s.writer.id, s.company.id))).get("/api/agents/me/access");
    const selfPayload = JSON.stringify(self.body);
    expect(selfPayload).toContain(s.restricted.id);
    expect(selfPayload).not.toContain(s.secret.id);
  });

  it("serves an instance admin", async () => {
    const s = await seed();
    const res = await request(app({ ...member(s.company.id, randomUUID()), isInstanceAdmin: true })).get(accessPath(s.company.id, s.writer.id));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("refuses another member with 403", async () => {
    const s = await seed();
    const res = await request(app(member(s.company.id, s.outsiderUserId))).get(accessPath(s.company.id, s.writer.id));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the agent's accountable person, its steward and company admins can see this.");
  });

  it("answers 404 for an agent the member cannot see", async () => {
    const s = await seed();
    const res = await request(app(member(s.company.id, s.outsiderUserId))).get(accessPath(s.company.id, s.hidden.id));
    expect(res.status).toBe(404);
  });

  it("answers 404 for another company's agent, and the shared 403 for a company the viewer is not in", async () => {
    const s = await seed();
    const owner = app(member(s.company.id, s.ownerUserId, "owner"));
    expect((await request(owner).get(accessPath(s.company.id, s.foreign.id))).status).toBe(404);
    const otherOwner = app(member(s.otherCompany.id, s.otherOwnerUserId, "owner"));
    expect((await request(otherOwner).get(accessPath(s.otherCompany.id, s.writer.id))).status).toBe(404);
    expect((await request(owner).get(accessPath(s.otherCompany.id, s.foreign.id))).status).toBe(403);
  });

  it("serves an agent its own inventory at /agents/me/access", async () => {
    const s = await seed();
    const res = await request(app(agentActor(s.writer.id, s.company.id))).get("/api/agents/me/access");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ kind: "agent_access_inventory", agentId: s.writer.id, companyId: s.company.id });
  });

  it("refuses agents on the board route, including for themselves", async () => {
    const s = await seed();
    const writer = app(agentActor(s.writer.id, s.company.id));
    expect((await request(writer).get(accessPath(s.company.id, s.runner.id))).status).toBe(403);
    expect((await request(writer).get(accessPath(s.company.id, s.writer.id))).status).toBe(403);
  });

  it("refuses board callers and the evaluator principal on /agents/me/access", async () => {
    const s = await seed();
    expect((await request(app(member(s.company.id, s.ownerUserId, "owner"))).get("/api/agents/me/access")).status).toBe(403);
    const evaluator = app(agentActor(s.writer.id, s.company.id, { principalKind: "evaluator", readOnly: true }));
    expect((await request(evaluator).get("/api/agents/me/access")).status).toBe(403);
    expect((await request(app({ type: "none", source: "none" })).get("/api/agents/me/access")).status).toBe(401);
  });

  it("validates windowDays", async () => {
    const s = await seed();
    const owner = app(member(s.company.id, s.ownerUserId, "owner"));
    for (const bad of ["0", "366", "1.5", "abc"]) {
      expect((await request(owner).get(`${accessPath(s.company.id, s.writer.id)}?windowDays=${bad}`)).status, bad).toBe(400);
    }
    const week = await request(owner).get(`${accessPath(s.company.id, s.writer.id)}?windowDays=7`);
    expect(week.status).toBe(200);
    expect(Date.parse(week.body.window.to) - Date.parse(week.body.window.from)).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("reports the governance policy on the agentdash_mk profile", async () => {
    const s = await seed("agentdash_mk");
    const res = await request(app(member(s.company.id, s.ownerUserId, "owner"))).get(accessPath(s.company.id, s.writer.id));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const inventory = res.body as AgentAccessInventory;
    expect(find(inventory, "do.governance").defined.detail).toMatch(/destructiveActions: approval_required/);
    expect(find(inventory, "spend.governance_budget").defined.allowed).toBe("unrestricted");
    expect(find(inventory, "talk.external.hubspot").defined.allowed).toBe(true);
    expect(inventory.gaps.map((gap) => gap.code)).not.toContain("GOVERNANCE_PROFILE_ONLY");
  });

  it("writes nothing, whoever calls and whatever the answer", async () => {
    const s = await seed();
    const tables = { activityLog, evaluationEvents, evaluationScorecards, issues, approvals, agentConfigRevisions };
    async function counts() {
      const out: Record<string, number> = {};
      for (const [name, table] of Object.entries(tables)) {
        out[name] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(table)
          .then((rows) => Number(rows[0]?.n ?? 0));
      }
      return out;
    }
    const before = await counts();
    expect(before.activityLog).toBeGreaterThan(0);

    const calls: Array<[Actor, string, number]> = [
      [member(s.company.id, s.ownerUserId, "owner"), accessPath(s.company.id, s.writer.id), 200],
      [member(s.company.id, s.stewardUserId), accessPath(s.company.id, s.writer.id), 200],
      [member(s.company.id, s.accountableUserId), accessPath(s.company.id, s.runner.id), 200],
      [member(s.company.id, s.outsiderUserId), accessPath(s.company.id, s.writer.id), 403],
      [member(s.company.id, s.outsiderUserId), accessPath(s.company.id, s.hidden.id), 404],
      [member(s.company.id, s.ownerUserId, "owner"), accessPath(s.company.id, s.foreign.id), 404],
      [agentActor(s.writer.id, s.company.id), "/api/agents/me/access", 200],
      [agentActor(s.writer.id, s.company.id), accessPath(s.company.id, s.runner.id), 403],
    ];
    for (const [actor, path, status] of calls) {
      expect((await request(app(actor)).get(path)).status, path).toBe(status);
    }
    expect(await counts()).toEqual(before);
  });
});
