import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  agentStewardships,
  agentWakeupRequests,
  approvals,
  authUsers,
  bridgeEndpoints,
  companies,
  companyMemberships,
  createDb,
  humanChannelBindings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { agentStewardshipRoutes } from "../routes/agent-stewardships.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { agentService } from "../services/agents.js";
import { approvalService } from "../services/approvals.js";

/**
 * The steward lifecycle end to end, against a real Postgres: the properties
 * at stake are database properties — a partial unique index holding a slot
 * for a dead agent, a release refusing a terminated row — so mocking the
 * service layer would assert nothing about them.
 *
 *   - a member can mint a connect code for the agent they steward, without
 *     being made an administrator of every agent;
 *   - terminating an agent ends its stewardship, so its person can be paired
 *     again, and My Agent stops showing the dead agent;
 *   - a stale hire approval can no longer terminate an agent that is running.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;
type Profile = "default" | "agentdash_mk";

const MIGRATION_0139 = fileURLToPath(
  new URL(
    "../../../packages/db/src/migrations/0139_end_stewardships_of_terminated_agents.sql",
    import.meta.url,
  ),
);

async function createCompany(db: TestDb, productProfile: Profile = "agentdash_mk") {
  return db
    .insert(companies)
    .values({
      name: `Lifecycle ${randomUUID()}`,
      issuePrefix: `LC${randomUUID().slice(0, 6).toUpperCase()}`,
      productProfile,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createMember(db: TestDb, companyId: string, role: "admin" | "member" = "member") {
  const userId = randomUUID();
  const now = new Date();
  await db.insert(authUsers).values({
    id: userId,
    name: `Person ${userId.slice(0, 4)}`,
    email: `${userId}@example.test`,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: role,
  });
  return userId;
}

async function createAgent(
  db: TestDb,
  companyId: string,
  input: {
    status?: string;
    autonomy?: "stewarded" | "autonomous";
    accountableUserId?: string | null;
    createdByUserId?: string | null;
  } = {},
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID().slice(0, 8)}`,
      role: "engineer",
      status: input.status ?? "idle",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      ...(input.autonomy ? { autonomy: input.autonomy } : {}),
      ...(input.accountableUserId !== undefined ? { accountableUserId: input.accountableUserId } : {}),
      ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {}),
    })
    .returning()
    .then((rows) => rows[0]!);
}

function boardActor(companyId: string, userId: string, role: "admin" | "member") {
  return {
    type: "board",
    userId,
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
  };
}

function createApp(db: TestDb, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor, companyIds: [...((actor.companyIds as string[]) ?? [])] };
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use("/api", agentStewardshipRoutes(db));
  app.use(errorHandler);
  return app;
}

async function call(app: express.Express, build: (baseUrl: string) => request.Test) {
  const { createServer } = await import("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return await build(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

describeEmbeddedPostgres("steward lifecycle and steward-scoped connect codes", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-steward-lifecycle-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function stewarded(profile: Profile = "agentdash_mk") {
    const company = await createCompany(db, profile);
    const admin = await createMember(db, company.id, "admin");
    const member = await createMember(db, company.id, "member");
    const agent = await createAgent(db, company.id);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: member,
      assignedByUserId: admin,
    });
    return { company, admin, member, agent };
  }

  function mintCode(app: express.Express, agentId: string) {
    return call(app, (baseUrl) => request(baseUrl).post(`/api/agents/${agentId}/connect-codes`).send({}));
  }

  describe("POST /agents/:id/connect-codes", () => {
    it("lets a member mint a code for the agent they steward", async () => {
      const { company, member, agent } = await stewarded();
      const res = await mintCode(createApp(db, boardActor(company.id, member, "member")), agent.id);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.code).toBeTruthy();
    });

    it("refuses a member for an agent they do not steward", async () => {
      const { company, agent } = await stewarded();
      const bystander = await createMember(db, company.id, "member");
      const res = await mintCode(createApp(db, boardActor(company.id, bystander, "member")), agent.id);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/agents:create/);
    });

    it("lets a member mint for an agent they created, as the steward tier does elsewhere", async () => {
      const company = await createCompany(db);
      const member = await createMember(db, company.id, "member");
      const agent = await createAgent(db, company.id, { createdByUserId: member });
      const res = await mintCode(createApp(db, boardActor(company.id, member, "member")), agent.id);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it("refuses the creator once the agent has been handed to another steward", async () => {
      // A transfer is how an administrator takes an agent away from someone.
      // A creator who could still mint a code would keep a live key for it.
      const company = await createCompany(db);
      const admin = await createMember(db, company.id, "admin");
      const creator = await createMember(db, company.id, "member");
      const newSteward = await createMember(db, company.id, "member");
      const agent = await createAgent(db, company.id, { createdByUserId: creator });
      const svc = agentStewardshipService(db);
      await svc.assign(company.id, { agentId: agent.id, userId: creator, assignedByUserId: creator });
      expect((await mintCode(createApp(db, boardActor(company.id, creator, "member")), agent.id)).status).toBe(201);

      await svc.transfer(company.id, agent.id, {
        userId: newSteward,
        transferredByUserId: admin,
        transferReason: "changed team",
      });

      const creatorRes = await mintCode(createApp(db, boardActor(company.id, creator, "member")), agent.id);
      expect(creatorRes.status).toBe(403);
      expect(creatorRes.body.error).toMatch(/another steward/);
      const stewardRes = await mintCode(createApp(db, boardActor(company.id, newSteward, "member")), agent.id);
      expect(stewardRes.status, JSON.stringify(stewardRes.body)).toBe(201);
    });

    it("refuses a former steward who did not create the agent", async () => {
      const { company, admin, member, agent } = await stewarded();
      await agentStewardshipService(db).releaseForAgent(company.id, agent.id, {
        releasedByUserId: admin,
        releaseReason: "moved on",
      });
      const res = await mintCode(createApp(db, boardActor(company.id, member, "member")), agent.id);
      expect(res.status).toBe(403);
    });

    it("refuses the creator once an administrator releases their stewardship", async () => {
      // A release ends the pairing without handing the agent to anyone. The
      // creator fallback is for a never-stewarded agent, not a way back in.
      const company = await createCompany(db);
      const admin = await createMember(db, company.id, "admin");
      const creator = await createMember(db, company.id, "member");
      const agent = await createAgent(db, company.id, { createdByUserId: creator });
      const svc = agentStewardshipService(db);
      await svc.assign(company.id, { agentId: agent.id, userId: creator, assignedByUserId: creator });
      expect((await mintCode(createApp(db, boardActor(company.id, creator, "member")), agent.id)).status).toBe(201);

      await svc.releaseForAgent(company.id, agent.id, {
        releasedByUserId: admin,
        releaseReason: "stepping back",
      });

      const creatorRes = await mintCode(createApp(db, boardActor(company.id, creator, "member")), agent.id);
      expect(creatorRes.status).toBe(403);
      expect(creatorRes.body.error).toMatch(/released/);
      const adminRes = await mintCode(createApp(db, boardActor(company.id, admin, "admin")), agent.id);
      expect(adminRes.status, JSON.stringify(adminRes.body)).toBe(201);
    });

    it("refuses a member of another company, even one who stewards an agent there", async () => {
      const { agent } = await stewarded();
      const other = await stewarded();
      const res = await mintCode(createApp(db, boardActor(other.company.id, other.member, "member")), agent.id);
      expect(res.status).toBe(403);
    });

    it("refuses an agent key", async () => {
      // Minting is a person connecting a terminal. An agent — even this one —
      // must not be able to mint credentials for itself.
      const { company, agent } = await stewarded();
      const app = createApp(db, { type: "agent", agentId: agent.id, companyId: company.id, companyIds: [company.id] });
      const res = await mintCode(app, agent.id);
      expect(res.status).toBe(403);
    });

    it("keeps stewardship out of it for a default-profile company", async () => {
      // Steward authority is an agentdash_mk concept; off-profile the route
      // keeps its administrator-only rule.
      const { company, member, agent } = await stewarded("default");
      const res = await mintCode(createApp(db, boardActor(company.id, member, "member")), agent.id);
      expect(res.status).toBe(403);
    });

    it("still lets an administrator mint", async () => {
      const { company, admin, agent } = await stewarded();
      const res = await mintCode(createApp(db, boardActor(company.id, admin, "admin")), agent.id);
      expect(res.status).toBe(201);
    });

    it("still refuses terminated, pending and autonomous agents with 409", async () => {
      const company = await createCompany(db);
      const admin = await createMember(db, company.id, "admin");
      const app = createApp(db, boardActor(company.id, admin, "admin"));

      const terminated = await createAgent(db, company.id, { status: "terminated" });
      const pending = await createAgent(db, company.id, { status: "pending_approval" });
      const autonomous = await createAgent(db, company.id, {
        autonomy: "autonomous",
        accountableUserId: admin,
      });

      const deadRes = await mintCode(app, terminated.id);
      expect(deadRes.status).toBe(409);
      expect(deadRes.body.error).toMatch(/cannot be connected/);
      expect((await mintCode(app, pending.id)).status).toBe(409);
      const autonomousRes = await mintCode(app, autonomous.id);
      expect(autonomousRes.status).toBe(409);
      expect(autonomousRes.body.error).toMatch(/no key or connect code can be issued/);
    });

    it("does not widen the key routes to stewards", async () => {
      // Deliberately scoped: listing and minting raw keys stays admin-only.
      const { company, member, agent } = await stewarded();
      const app = createApp(db, boardActor(company.id, member, "member"));
      const res = await call(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agent.id}/keys`));
      expect(res.status).toBe(403);
    });
  });

  describe("terminating a stewarded agent", () => {
    it("ends the stewardship, revokes this agent's channels, and frees the person for a new agent", async () => {
      const { company, admin, member, agent } = await stewarded();
      // The person is also accountable for an autonomous agent, reached on a
      // different channel and on the same enrolled machine. Terminating the
      // stewarded agent must not cut that off.
      const autonomous = await createAgent(db, company.id, {
        autonomy: "autonomous",
        accountableUserId: member,
      });
      await db.insert(humanChannelBindings).values([
        {
          companyId: company.id,
          userId: member,
          agentId: agent.id,
          provider: "telegram",
          externalUserId: `tg-${randomUUID()}`,
          verifiedAt: new Date(),
        },
        {
          companyId: company.id,
          userId: member,
          agentId: autonomous.id,
          provider: "whatsapp",
          externalUserId: `wa-${randomUUID()}`,
          verifiedAt: new Date(),
        },
      ]);
      await db.insert(bridgeEndpoints).values({
        companyId: company.id,
        userId: member,
        label: "laptop",
        tokenHash: `hash-${randomUUID()}`,
        enrolledAt: new Date(),
        approvedByUserId: admin,
      });
      const adminApp = createApp(db, boardActor(company.id, admin, "admin"));

      const terminated = await call(adminApp, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agent.id}/terminate`).send({}),
      );
      expect(terminated.status, JSON.stringify(terminated.body)).toBe(200);
      expect(terminated.body.status).toBe("terminated");

      const [row] = await db
        .select()
        .from(agentStewardships)
        .where(eq(agentStewardships.agentId, agent.id));
      expect(row!.endedAt).toBeTruthy();
      expect(row!.transferReason).toBe("agent_terminated");
      expect(row!.endedByUserId).toBe(admin);

      const bindings = await db.select().from(humanChannelBindings);
      const byAgent = new Map(bindings.map((binding) => [binding.agentId, binding]));
      expect(byAgent.get(agent.id)!.revokedAt).not.toBeNull();
      expect(byAgent.get(agent.id)!.revokedByUserId).toBe(admin);
      expect(byAgent.get(autonomous.id)!.revokedAt).toBeNull();
      // Endpoints are the person's, not the agent's; the terminated agent's own
      // keys are what stop it being run.
      const endpoints = await db.select().from(bridgeEndpoints);
      expect(endpoints.every((endpoint) => endpoint.revokedAt === null)).toBe(true);

      const ended = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "agent.stewardship_ended"));
      expect(ended).toHaveLength(1);
      expect(ended[0]!.details).toMatchObject({ userId: member, reason: "agent_terminated" });
      const revoked = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "human_channel.binding_revoked"));
      expect(revoked).toHaveLength(1);
      expect(revoked[0]!.details).toMatchObject({ reason: "agent_terminated" });
      expect(
        await db.select().from(activityLog).where(eq(activityLog.action, "bridge.endpoint_revoked")),
      ).toHaveLength(0);

      // The whole point: the person's one slot is free again.
      const replacement = await createAgent(db, company.id);
      const assigned = await call(adminApp, (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${company.id}/agent-stewardships`)
          .send({ agentId: replacement.id, userId: member }),
      );
      expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
      expect(assigned.body.stewardship.agentId).toBe(replacement.id);
    });

    it("shows no agent on My Agent afterwards, and does not quietly provision a new one", async () => {
      // The member joined after the personal-agent cutover, so without the
      // history check a first "no agent" answer would create a fresh Chief of
      // Staff for them on page load.
      const { company, admin, member, agent } = await stewarded();
      await agentService(db).terminate(agent.id, { endedByUserId: admin });

      const memberApp = createApp(db, boardActor(company.id, member, "member"));
      const res = await call(memberApp, (baseUrl) =>
        request(baseUrl).get(`/api/companies/${company.id}/me/agent`),
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ stewardship: null, agent: null });

      const live = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, company.id), eq(agents.status, "idle")));
      expect(live).toHaveLength(0);
    });

    it("still provisions a personal agent for a genuinely new member", async () => {
      const company = await createCompany(db);
      const member = await createMember(db, company.id, "member");
      const memberApp = createApp(db, boardActor(company.id, member, "member"));
      const res = await call(memberApp, (baseUrl) =>
        request(baseUrl).get(`/api/companies/${company.id}/me/agent`),
      );
      expect(res.status).toBe(200);
      expect(res.body.agent?.role).toBe("chief_of_staff");
      expect(res.body.stewardship?.userId).toBe(member);
    });

    // AgentDash (GH #505): the agent's name is company-wide, so it must not
    // carry the mailbox name the directory withholds.
    it("names a nameless member's personal agent without their email local part", async () => {
      const company = await createCompany(db);
      const member = await createMember(db, company.id, "member");
      await db
        .update(authUsers)
        .set({ name: "", email: "private.mailbox@example.test" })
        .where(eq(authUsers.id, member));
      const memberApp = createApp(db, boardActor(company.id, member, "member"));
      const res = await call(memberApp, (baseUrl) =>
        request(baseUrl).get(`/api/companies/${company.id}/me/agent`),
      );
      expect(res.status).toBe(200);
      expect(res.body.agent?.name).toBe("Teammate's agent");
      expect(JSON.stringify(res.body)).not.toContain("private");
    });

    it("ignores a leftover open pairing on a terminated agent when reading", async () => {
      // A row written before termination ended pairings (the migration closes
      // these; the read must not depend on it having run).
      const company = await createCompany(db);
      const member = await createMember(db, company.id, "member");
      const dead = await createAgent(db, company.id, { status: "terminated" });
      await db.insert(agentStewardships).values({ companyId: company.id, agentId: dead.id, userId: member });

      const svc = agentStewardshipService(db);
      expect(await svc.activeByUser(company.id, member)).toBeNull();
      expect(await svc.activeByUserWithAgent(company.id, member)).toBeNull();
    });
  });

  describe("releasing a terminated agent's stewardship", () => {
    it("is allowed, while transfer and assign still refuse the terminated agent", async () => {
      const company = await createCompany(db);
      const admin = await createMember(db, company.id, "admin");
      const member = await createMember(db, company.id, "member");
      const other = await createMember(db, company.id, "member");
      const dead = await createAgent(db, company.id, { status: "terminated" });
      await db.insert(agentStewardships).values({ companyId: company.id, agentId: dead.id, userId: member });
      const adminApp = createApp(db, boardActor(company.id, admin, "admin"));

      const transfer = await call(adminApp, (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${company.id}/agents/${dead.id}/stewardship/transfer`)
          .send({ userId: other, transferReason: "handover" }),
      );
      expect(transfer.status).toBe(409);
      expect(transfer.body.error).toMatch(/must not be terminated/);

      const released = await call(adminApp, (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${company.id}/agents/${dead.id}/stewardship/release`)
          .send({ releaseReason: "agent was terminated" }),
      );
      expect(released.status, JSON.stringify(released.body)).toBe(200);
      expect(released.body.stewardship.endedAt).toBeTruthy();

      await expect(
        agentStewardshipService(db).assign(company.id, {
          agentId: dead.id,
          userId: other,
          assignedByUserId: admin,
        }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("hire approvals", () => {
    async function pendingHire(
      agentStatus: string,
      input: { profile?: Profile; requestedByAgent?: boolean } = {},
    ) {
      const company = await createCompany(db, input.profile ?? "agentdash_mk");
      const admin = await createMember(db, company.id, "admin");
      const member = await createMember(db, company.id, "member");
      const agent = await createAgent(db, company.id, { status: agentStatus, createdByUserId: member });
      // A Chief of Staff hiring through `canCreateAgents`, stewarded by the
      // member — so in agentdash_mk the admin is NOT this approval's decider.
      const requester = input.requestedByAgent ? await createAgent(db, company.id) : null;
      if (requester) {
        await agentStewardshipService(db).assign(company.id, {
          agentId: requester.id,
          userId: member,
          assignedByUserId: admin,
        });
      }
      const approval = await db
        .insert(approvals)
        .values({
          companyId: company.id,
          type: "hire_agent",
          requestedByUserId: requester ? null : member,
          requestedByAgentId: requester?.id ?? null,
          status: "pending",
          payload: { agentId: agent.id, name: agent.name, role: "engineer", budgetMonthlyCents: 0 },
        })
        .returning()
        .then((rows) => rows[0]!);
      return { company, admin, member, agent, approval, requester };
    }

    function approveFromAgentPage(companyId: string, admin: string, agentId: string) {
      return call(createApp(db, boardActor(companyId, admin, "admin")), (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agentId}/approve`).send({}),
      );
    }

    it("approving the agent from its page decides its pending hire approval", async () => {
      const { company, admin, agent, approval } = await pendingHire("pending_approval");
      const adminApp = createApp(db, boardActor(company.id, admin, "admin"));

      const res = await call(adminApp, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agent.id}/approve`).send({}),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe("idle");

      const [decided] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
      expect(decided!.status).toBe("approved");
      expect(decided!.decidedByUserId).toBe(admin);
      expect(decided!.decisionChannel).toBe("web");
      // A human-filed hire has no requesting agent, so administrators are its
      // ordinary deciders in agentdash_mk.
      expect(decided!.decisionActorRole).toBe("admin");
      expect(decided!.overrideReason).toBeNull();

      // And a later reject of it is an ordinary "already decided" refusal that
      // touches nothing.
      await expect(approvalService(db).reject(approval.id, admin, "stale")).rejects.toMatchObject({
        status: 422,
      });
      const [after] = await db.select().from(agents).where(eq(agents.id, agent.id));
      expect(after!.status).toBe("idle");
    });

    it("records an agent-requested hire approved from the agent page as an override, without waking the requester", async () => {
      const { company, admin, agent, approval, requester } = await pendingHire("pending_approval", {
        requestedByAgent: true,
      });

      const res = await approveFromAgentPage(company.id, admin, agent.id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const [decided] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
      expect(decided!.status).toBe("approved");
      expect(decided!.decisionActorRole).toBe("owner_override");
      expect(decided!.overrideReason).toBe("Activated from the agent page");
      expect(decided!.decisionChannel).toBe("web");

      const override = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "approval.emergency_override"));
      expect(override).toHaveLength(1);
      expect(override[0]!.entityId).toBe(approval.id);
      expect(override[0]!.details).toMatchObject({ decision: "approved", source: "agent_detail" });
      expect(
        await db.select().from(activityLog).where(eq(activityLog.action, "approval.approved")),
      ).toHaveLength(1);

      // The requesting agent is not woken: no wakeup request, no queued-wake audit.
      expect(
        await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, requester!.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.action, "approval.requester_wakeup_queued")),
      ).toHaveLength(0);
    });

    it("records the approving steward as the steward on an agent-requested hire", async () => {
      // An administrator who also stewards the requesting agent IS its decider.
      const { company, admin, agent, approval, requester } = await pendingHire("pending_approval", {
        requestedByAgent: true,
      });
      await agentStewardshipService(db).releaseForAgent(company.id, requester!.id, {
        releasedByUserId: admin,
        releaseReason: "admin takes it",
      });
      await agentStewardshipService(db).assign(company.id, {
        agentId: requester!.id,
        userId: admin,
        assignedByUserId: admin,
      });

      expect((await approveFromAgentPage(company.id, admin, agent.id)).status).toBe(200);
      const [decided] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
      expect(decided!.decisionActorRole).toBe("steward");
      expect(decided!.overrideReason).toBeNull();
    });

    it("records a default-profile hire approved from the agent page under the board role", async () => {
      const { company, admin, agent, approval } = await pendingHire("pending_approval", {
        profile: "default",
        requestedByAgent: true,
      });
      expect((await approveFromAgentPage(company.id, admin, agent.id)).status).toBe(200);
      const [decided] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
      expect(decided!.status).toBe("approved");
      expect(decided!.decisionActorRole).toBe("board");
      expect(decided!.overrideReason).toBeNull();
    });

    it("never terminates through a conditional terminate once the agent is active", async () => {
      // The race the reject path closes: its terminate is conditional on the
      // agent still being pending, in the terminating statement itself.
      const { company, admin, member, agent } = await pendingHire("idle");
      await agentStewardshipService(db).assign(company.id, {
        agentId: agent.id,
        userId: member,
        assignedByUserId: admin,
      });
      const result = await agentService(db).terminate(agent.id, {
        endedByUserId: admin,
        onlyIfStatus: "pending_approval",
      });
      expect(result!.status).toBe("idle");
      expect(await agentStewardshipService(db).activeByAgent(company.id, agent.id)).not.toBeNull();
    });

    it("refuses to reject a hire whose agent is already running, and leaves both alone", async () => {
      // A stale hire: activated from the agent page before that decided the
      // approval, stewarded and connected, then the stale approval rejected.
      const { company, admin, member, agent, approval } = await pendingHire("idle");
      await agentStewardshipService(db).assign(company.id, {
        agentId: agent.id,
        userId: member,
        assignedByUserId: admin,
      });
      await db.insert(agentApiKeys).values({
        agentId: agent.id,
        companyId: company.id,
        name: "laptop",
        keyHash: `hash-${randomUUID()}`,
      });

      await expect(approvalService(db).reject(approval.id, admin, "stale")).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/already active/),
      });

      const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
      expect(row!.status).toBe("idle");
      const [stillPending] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
      expect(stillPending!.status).toBe("pending");
      const keys = await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agent.id));
      expect(keys.every((key) => key.revokedAt === null)).toBe(true);
      expect(await agentStewardshipService(db).activeByAgent(company.id, agent.id)).not.toBeNull();
    });

    it("rejecting a hire that is still pending terminates the agent and ends its pairing", async () => {
      const { company, admin, member, agent, approval } = await pendingHire("pending_approval");
      await agentStewardshipService(db).assign(company.id, {
        agentId: agent.id,
        userId: member,
        assignedByUserId: admin,
      });

      const result = await approvalService(db).reject(approval.id, admin, "not this one");
      expect(result.applied).toBe(true);

      const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
      expect(row!.status).toBe("terminated");
      const [pairing] = await db
        .select()
        .from(agentStewardships)
        .where(eq(agentStewardships.agentId, agent.id));
      expect(pairing!.endedAt).toBeTruthy();
      expect(pairing!.endedByUserId).toBe(admin);
      expect(pairing!.transferReason).toBe("agent_terminated");
    });

    it("lets a stale hire approval for an already-terminated agent be rejected", async () => {
      const { admin, approval } = await pendingHire("terminated");
      const result = await approvalService(db).reject(approval.id, admin, "cleanup");
      expect(result.applied).toBe(true);
      expect(result.approval.status).toBe("rejected");
    });
  });

  describe("migration 0139", () => {
    it("closes only open pairings on terminated agents, and is idempotent", async () => {
      const company = await createCompany(db);
      const deadSteward = await createMember(db, company.id, "member");
      const liveSteward = await createMember(db, company.id, "member");
      const pastSteward = await createMember(db, company.id, "member");
      const dead = await createAgent(db, company.id, { status: "terminated" });
      const live = await createAgent(db, company.id);
      const alreadyEndedAt = new Date("2026-08-01T00:00:00.000Z");

      const [deadRow] = await db
        .insert(agentStewardships)
        .values({ companyId: company.id, agentId: dead.id, userId: deadSteward })
        .returning();
      const [liveRow] = await db
        .insert(agentStewardships)
        .values({ companyId: company.id, agentId: live.id, userId: liveSteward })
        .returning();
      const [pastRow] = await db
        .insert(agentStewardships)
        .values({
          companyId: company.id,
          agentId: dead.id,
          userId: pastSteward,
          endedAt: alreadyEndedAt,
          transferReason: "handover",
        })
        .returning();

      const migration = fs.readFileSync(MIGRATION_0139, "utf8");
      await db.execute(sql.raw(migration));

      const byId = new Map(
        (await db.select().from(agentStewardships)).map((row) => [row.id, row]),
      );
      expect(byId.get(deadRow!.id)!.endedAt).toBeTruthy();
      expect(byId.get(deadRow!.id)!.transferReason).toBe("agent_terminated");
      expect(byId.get(deadRow!.id)!.endedByUserId).toBeNull();
      expect(byId.get(liveRow!.id)!.endedAt).toBeNull();
      expect(byId.get(pastRow!.id)!.endedAt?.toISOString()).toBe(alreadyEndedAt.toISOString());
      expect(byId.get(pastRow!.id)!.transferReason).toBe("handover");

      const audit = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "agent.stewardship_ended"));
      expect(audit).toHaveLength(1);
      expect(audit[0]!.entityId).toBe(deadRow!.id);
      expect(audit[0]!.origin).toBe("server");
      expect(audit[0]!.details).toMatchObject({ userId: deadSteward, reason: "agent_terminated" });

      await db.execute(sql.raw(migration));
      const auditAgain = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "agent.stewardship_ended"));
      expect(auditAgain).toHaveLength(1);
    });
  });
});
