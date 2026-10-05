// AgentDash (GH #828): provenance spoofing. A board user must not be able to
// make their action read as assistant-made: `channel: "assistant"` on an
// approval decision and the `assistant_hire_request` source tag in a free-form
// approval payload are both reserved for the assistant grant (pcin_ loopback /
// the gated-action path that stamps them server-side).
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
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
      adapterType: "process",
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

  beforeAll(async () => {
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

  it("still lets a board user decide on an ordinary channel", async () => {
    const { company, steward, approval } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, steward.principalId));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/approve`)
        .send({ revision: 1, idempotencyKey: `key-${randomUUID()}`, channel: "bridge_inbox" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await storedChannel(approval.id)).toEqual({ status: "approved", decisionChannel: "bridge_inbox" });
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
});
