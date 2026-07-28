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
      name: `Approvals ${randomUUID()}`,
      issuePrefix: `AP${randomUUID().slice(0, 6).toUpperCase()}`,
      productProfile,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createMember(
  db: TestDb,
  companyId: string,
  input: { role?: string; status?: string } = {},
) {
  return db
    .insert(companyMemberships)
    .values({
      companyId,
      principalType: "user",
      principalId: randomUUID(),
      status: input.status ?? "active",
      membershipRole: input.role ?? "operator",
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

function makeBoardActor(companyId: string, userId: string, role = "operator") {
  return {
    type: "board",
    userId,
    source: "session",
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

describeEmbeddedPostgres("agentdash-mk approval authority", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mk-approvals-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Approving wakes the requesting agent, which creates heartbeat rows that
    // reference agents — they must be cleared before the agents themselves.
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(approvals);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(productProfile: "default" | "agentdash_mk" = "agentdash_mk") {
    const company = await createCompany(db, productProfile);
    const owner = await createMember(db, company.id, { role: "owner" });
    const steward = await createMember(db, company.id, { role: "operator" });
    const bystander = await createMember(db, company.id, { role: "operator" });
    const agent = await createAgent(db, company.id);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: steward.principalId,
      assignedByUserId: owner.principalId,
    });
    const approval = await createApproval(db, company.id, agent.id);
    return { company, owner, steward, bystander, agent, approval };
  }

  it("lets the current steward of the requesting agent approve", async () => {
    const { company, steward, approval } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, steward.principalId));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/approve`)
        .send({ revision: 1, idempotencyKey: `key-${randomUUID()}`, channel: "web" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("approved");

    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(stored.decidedByUserId).toBe(steward.principalId);
    expect(stored.decisionChannel).toBe("web");
    expect(stored.decisionActorRole).toBe("steward");
  });

  it("denies an ordinary member who is not the steward", async () => {
    const { company, bystander, approval } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, bystander.principalId));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/approve`)
        .send({ revision: 1, idempotencyKey: `key-${randomUUID()}`, channel: "web" }),
    );

    expect(res.status).toBe(403);
    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("pending");
  });

  it("denies an owner the ordinary decision path — override is a separate, explicit action", async () => {
    const { company, owner, approval } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, owner.principalId, "owner"));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/approve`)
        .send({ revision: 1, idempotencyKey: `key-${randomUUID()}`, channel: "web" }),
    );

    expect(res.status).toBe(403);
  });

  it("requires a reason for an emergency override and records it as exceptional", async () => {
    const { company, owner, approval } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, owner.principalId, "owner"));

    const missingReason = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/override`)
        .send({ decision: "approved", revision: 1, idempotencyKey: `key-${randomUUID()}`, channel: "web" }),
    );
    expect(missingReason.status).toBe(400);

    const withReason = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/override`)
        .send({
          decision: "approved",
          overrideReason: "Steward unreachable during incident",
          revision: 1,
          idempotencyKey: `key-${randomUUID()}`,
          channel: "web",
        }),
    );
    expect(withReason.status, JSON.stringify(withReason.body)).toBe(200);

    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("approved");
    expect(stored.overrideReason).toBe("Steward unreachable during incident");
    expect(stored.decisionActorRole).toBe("owner_override");

    const audited = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "approval.emergency_override"))
      .then((rows) => rows[0]!);
    expect(audited).toBeDefined();
    expect(audited.actorId).toBe(owner.principalId);
    expect(audited.details).toMatchObject({ overrideReason: "Steward unreachable during incident" });
  });

  it("denies emergency override to an ordinary member", async () => {
    const { company, bystander, approval } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, bystander.principalId));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/override`)
        .send({
          decision: "approved",
          overrideReason: "I would like to",
          revision: 1,
          idempotencyKey: `key-${randomUUID()}`,
          channel: "web",
        }),
    );

    expect(res.status).toBe(403);
  });

  it("binds a decision to the approval revision and fails a stale button closed", async () => {
    const { company, steward, approval } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, steward.principalId));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/approve`)
        .send({ revision: 0, idempotencyKey: `key-${randomUUID()}`, channel: "telegram" }),
    );
    // revision 0 is not a valid revision value at all.
    expect([400, 409]).toContain(res.status);

    const stale = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/approve`)
        .send({ revision: 99, idempotencyKey: `key-${randomUUID()}`, channel: "telegram" }),
    );
    expect(stale.status).toBe(409);

    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("pending");
  });

  it("returns the original terminal result for a replayed idempotency key without duplicating effects", async () => {
    const { company, steward, approval } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, steward.principalId));
    const idempotencyKey = `key-${randomUUID()}`;

    const first = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/approve`)
        .send({ revision: 1, idempotencyKey, channel: "telegram" }),
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const replay = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/approve`)
        .send({ revision: 1, idempotencyKey, channel: "telegram" }),
    );

    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe("approved");
    expect(new Date(replay.body.decidedAt).toISOString()).toBe(
      new Date(first.body.decidedAt).toISOString(),
    );

    const decisionEvents = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "approval.approved"));
    expect(decisionEvents).toHaveLength(1);
  });

  it("fails closed when a replayed key arrives after the stewardship moved on", async () => {
    const { company, owner, steward, bystander, agent, approval } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, steward.principalId));

    await agentStewardshipService(db).transfer(company.id, agent.id, {
      userId: bystander.principalId,
      transferredByUserId: owner.principalId,
      transferReason: "Role change",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/approve`)
        .send({ revision: 1, idempotencyKey: `key-${randomUUID()}`, channel: "telegram" }),
    );

    expect(res.status).toBe(403);
  });

  it("keeps existing board approval behavior for default-profile companies", async () => {
    const { company, bystander, approval } = await seed("default");
    const app = await createApp(db, makeBoardActor(company.id, bystander.principalId));

    // No revision, idempotencyKey, or channel: the pre-existing contract must
    // keep working unchanged for companies that never opted into the profile.
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/approvals/${approval.id}/approve`).send({}),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("approved");
  });

  it("requires decision metadata in profile companies but not in default ones", async () => {
    const { company, steward, approval } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, steward.principalId));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/approvals/${approval.id}/approve`).send({}),
    );

    expect(res.status).toBe(400);
  });

  it("lets an administrator decide normally when no agent requested the approval", async () => {
    const { company, owner } = await seed();
    const orphanApproval = await createApproval(db, company.id, null);
    const app = await createApp(db, makeBoardActor(company.id, owner.principalId, "owner"));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${orphanApproval.id}/approve`)
        .send({ revision: 1, idempotencyKey: `key-${randomUUID()}`, channel: "web" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("approved");
  });

  it("blocks cross-company decisions", async () => {
    const first = await seed();
    const second = await seed();
    const app = await createApp(db, makeBoardActor(second.company.id, second.steward.principalId));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${first.approval.id}/approve`)
        .send({ revision: 1, idempotencyKey: `key-${randomUUID()}`, channel: "web" }),
    );

    expect(res.status).toBe(403);
  });

  it("lets the steward reject as well as approve", async () => {
    const { company, steward, approval } = await seed();
    const app = await createApp(db, makeBoardActor(company.id, steward.principalId));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approval.id}/reject`)
        .send({ revision: 1, idempotencyKey: `key-${randomUUID()}`, channel: "teams" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("rejected");

    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(stored.decisionChannel).toBe("teams");
  });
});
