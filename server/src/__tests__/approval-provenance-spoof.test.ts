// AgentDash (GH #828): provenance spoofing. A board user must not be able to
// make their action read as assistant-made: `channel: "assistant"` on an
// approval decision and the `assistant_hire_request` source tag in a free-form
// approval payload are both reserved for the assistant grant (pcin_ loopback /
// the gated-action path that stamps them server-side).
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentStewardships,
  agentWakeupRequests,
  approvals,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { approvalRoutes } from "../routes/approvals.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

async function createCompany(db: TestDb, productProfile: "default" | "agentdash_mk" = "agentdash_mk") {
  return db
    .insert(companies)
    .values({
      name: `Provenance ${randomUUID()}`,
      issuePrefix: `PV${randomUUID().slice(0, 6).toUpperCase()}`,
      productProfile,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createMember(db: TestDb, companyId: string, role = "operator") {
  return db
    .insert(companyMemberships)
    .values({
      companyId,
      principalType: "user",
      principalId: randomUUID(),
      status: "active",
      membershipRole: role,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: TestDb, companyId: string) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createApproval(db: TestDb, companyId: string, requestedByAgentId: string | null) {
  return db
    .insert(approvals)
    .values({
      companyId,
      type: "request_board_approval",
      requestedByAgentId,
      status: "pending",
      payload: { summary: "Ship the board deck" },
    })
    .returning()
    .then((rows) => rows[0]!);
}

function makeBoardActor(companyId: string, userId: string, role = "operator", source = "session") {
  return {
    type: "board",
    userId,
    source,
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
  };
}

async function createApp(db: TestDb, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", approvalRoutes(db, { autoDispatchQueuedRuns: false }));
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

async function requestApp(app: express.Express, buildRequest: (baseUrl: string) => request.Test) {
  const { createServer } = await import("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

describeEmbeddedPostgres("approval provenance spoofing", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let home = "";
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousBilling = process.env.AGENTDASH_BILLING_DISABLED;

  beforeAll(async () => {
    // Hires materialize an instructions bundle on disk and pass the tier gate.
    home = await mkdtemp(path.join(tmpdir(), "approval-provenance-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.AGENTDASH_BILLING_DISABLED = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-provenance-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(approvals);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (home) await rm(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousBilling === undefined) delete process.env.AGENTDASH_BILLING_DISABLED;
    else process.env.AGENTDASH_BILLING_DISABLED = previousBilling;
  });

  async function seed(productProfile: "default" | "agentdash_mk" = "agentdash_mk") {
    const company = await createCompany(db, productProfile);
    const owner = await createMember(db, company.id, "owner");
    const steward = await createMember(db, company.id, "operator");
    const agent = await createAgent(db, company.id);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: steward.principalId,
      assignedByUserId: owner.principalId,
    });
    const approval = await createApproval(db, company.id, agent.id);
    return { company, owner, steward, agent, approval };
  }

  async function storedChannel(approvalId: string) {
    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0]!);
    return { status: stored.status, decisionChannel: stored.decisionChannel };
  }

  it("refuses a board decision that claims channel assistant (mk profile)", async () => {
    const { company, steward, approval } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, steward.principalId));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/approve`)
        .send({ revision: 1, idempotencyKey: `key-${randomUUID()}`, channel: "assistant" }),
    );

    expect(res.status).toBe(403);
    expect(await storedChannel(approval.id)).toEqual({ status: "pending", decisionChannel: null });
  });

  it("refuses a board decision that claims channel assistant (default profile)", async () => {
    const { company, steward, approval } = await seed("default");
    const app = await createApp(db, makeBoardActor(company.id, steward.principalId));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/approve`)
        .send({ channel: "assistant" }),
    );

    expect(res.status).toBe(403);
    expect(await storedChannel(approval.id)).toEqual({ status: "pending", decisionChannel: null });
  });

  it("refuses a board override that claims channel assistant", async () => {
    const { company, owner, approval } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, owner.principalId, "owner"));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/override`)
        .send({
          decision: "approved",
          overrideReason: "Steward unavailable",
          revision: 1,
          idempotencyKey: `key-${randomUUID()}`,
          channel: "assistant",
        }),
    );

    expect(res.status).toBe(403);
    expect(await storedChannel(approval.id)).toEqual({ status: "pending", decisionChannel: null });
  });

  it("still lets an assistant grant decide with channel assistant", async () => {
    const { company, steward, approval } = await seed();
    const app = await createApp(
      db,
      makeBoardActor(company.id, steward.principalId, "operator", "assistant_grant"),
    );

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/approve`)
        .send({ revision: 1, idempotencyKey: `assistant-${randomUUID()}`, channel: "assistant" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await storedChannel(approval.id)).toEqual({ status: "approved", decisionChannel: "assistant" });
  });

  it("still lets a board user decide through the REST web channel", async () => {
    const { company, steward, approval } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, steward.principalId));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/approve`)
        .send({ revision: 1, idempotencyKey: `key-${randomUUID()}`, channel: "web" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await storedChannel(approval.id)).toEqual({ status: "approved", decisionChannel: "web" });
  });

  it("refuses a free-form approval payload stamped with the assistant_hire_request tag", async () => {
    const { company, steward } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, steward.principalId));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/approvals`)
        .send({
          type: "request_board_approval",
          payload: { summary: "Hire Bea", metadata: { source: "assistant_hire_request" } },
        }),
    );

    expect(res.status).toBe(403);
    const stored = await db.select().from(approvals);
    expect(stored).toHaveLength(1); // only the seeded approval remains
  });

  it("still lets a board user create an approval with ordinary metadata", async () => {
    const { company, steward } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, steward.principalId));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/approvals`)
        .send({
          type: "request_board_approval",
          payload: { summary: "Hire Bea", metadata: { source: "board_request", note: "hi" } },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("lets an assistant grant carry the assistant_hire_request tag", async () => {
    const { company, steward } = await seed();
    const app = await createApp(
      db,
      makeBoardActor(company.id, steward.principalId, "operator", "assistant_grant"),
    );

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/approvals`)
        .send({
          type: "request_board_approval",
          payload: { summary: "Hire Bea", metadata: { source: "assistant_hire_request" } },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
  // Review of #1044: the tag also reached approvals through the hire route's
  // body `metadata` and through a resubmit that replaces the payload.
  async function requireHireApproval(companyId: string) {
    await db
      .update(companies)
      .set({ requireBoardApprovalForNewAgents: true })
      .where(eq(companies.id, companyId));
  }

  it("refuses a hire whose body metadata claims the assistant_hire_request tag", async () => {
    const { company, owner } = await seed();
    await requireHireApproval(company.id);
    const before = await db.select().from(agents).where(eq(agents.companyId, company.id));
    const app = await createApp(db, makeBoardActor(company.id, owner.principalId, "owner"));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/agent-hires`)
        .send({
          name: "Bea",
          adapterType: "codex_local",
          metadata: { source: "assistant_hire_request" },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await db.select().from(agents).where(eq(agents.companyId, company.id))).toHaveLength(before.length);
    const hireApprovals = await db.select().from(approvals).where(eq(approvals.type, "hire_agent"));
    expect(hireApprovals).toHaveLength(0);
  });

  it("refuses the tag on a hire from an agent with hiring rights", async () => {
    const { company, agent } = await seed();
    await requireHireApproval(company.id);
    await db.update(agents).set({ permissions: { canCreateAgents: true } }).where(eq(agents.id, agent.id));
    const app = await createApp(db, {
      type: "agent",
      agentId: agent.id,
      companyId: company.id,
      source: "agent_key",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/agent-hires`)
        .send({
          name: "Bea",
          adapterType: "codex_local",
          metadata: { source: "assistant_hire_request" },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const hireApprovals = await db.select().from(approvals).where(eq(approvals.type, "hire_agent"));
    expect(hireApprovals).toHaveLength(0);
  });

  it("still files a hire with ordinary metadata", async () => {
    const { company, owner } = await seed();
    await requireHireApproval(company.id);
    const app = await createApp(db, makeBoardActor(company.id, owner.principalId, "owner"));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/agent-hires`)
        .send({ name: "Bea", adapterType: "codex_local", metadata: { source: "board_request" } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [hire] = await db.select().from(approvals).where(eq(approvals.type, "hire_agent"));
    expect((hire!.payload as { metadata?: { source?: unknown } }).metadata?.source).toBe("board_request");
  });

  async function revisionRequested(approvalId: string) {
    await db.update(approvals).set({ status: "revision_requested" }).where(eq(approvals.id, approvalId));
  }

  it("refuses an agent resubmit that stamps the assistant_hire_request tag", async () => {
    const { company, agent, approval } = await seed();
    await revisionRequested(approval.id);
    const app = await createApp(db, {
      type: "agent",
      agentId: agent.id,
      companyId: company.id,
      source: "agent_key",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/resubmit`)
        .send({ payload: { summary: "Ship the deck", metadata: { source: "assistant_hire_request" } } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const stored = await db.select().from(approvals).where(eq(approvals.id, approval.id)).then((rows) => rows[0]!);
    expect(stored.status).toBe("revision_requested");
    expect(stored.payload).toEqual({ summary: "Ship the board deck" });
  });

  it("refuses a board resubmit that stamps the assistant_hire_request tag", async () => {
    const { company, steward, approval } = await seed();
    await revisionRequested(approval.id);
    const app = await createApp(db, makeBoardActor(company.id, steward.principalId));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/resubmit`)
        .send({ payload: { summary: "Ship the deck", metadata: { source: "assistant_hire_request" } } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const stored = await db.select().from(approvals).where(eq(approvals.id, approval.id)).then((rows) => rows[0]!);
    expect(stored.payload).toEqual({ summary: "Ship the board deck" });
  });

  it("still lets the requesting agent resubmit an ordinary payload", async () => {
    const { company, agent, approval } = await seed();
    await revisionRequested(approval.id);
    const app = await createApp(db, {
      type: "agent",
      agentId: agent.id,
      companyId: company.id,
      source: "agent_key",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/resubmit`)
        .send({ payload: { summary: "Ship the revised deck", metadata: { source: "agent_request" } } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await db.select().from(approvals).where(eq(approvals.id, approval.id)).then((rows) => rows[0]!);
    expect(stored.status).toBe("pending");
  });
});
