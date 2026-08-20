import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentMemory,
  agentStewardships,
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
import { agentMemoryRoutes } from "../routes/agent-memory.js";
import { agentMemoryService } from "../services/agent-memory.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

async function createCompany(db: TestDb) {
  return db
    .insert(companies)
    .values({
      name: `Memory ${randomUUID()}`,
      issuePrefix: `MM${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createUserMember(
  db: TestDb,
  companyId: string,
  membershipRole: "admin" | "operator",
) {
  const userId = randomUUID();
  const now = new Date();
  await db.insert(authUsers).values({
    id: userId,
    name: `User ${userId.slice(0, 4)}`,
    email: `${userId.slice(0, 8)}@example.com`,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole,
  });
  return userId;
}

async function createAgent(db: TestDb, companyId: string, name: string) {
  return db
    .insert(agents)
    .values({
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createApp(db: TestDb, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", agentMemoryRoutes(db));
  app.use(errorHandler);
  return app;
}

async function requestApp(app: express.Express, build: (baseUrl: string) => request.Test) {
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
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  }
}

/**
 * Durable per-agent memory.
 *
 * The properties worth guarding are the ones that make memory trustworthy over
 * a long horizon: it is append-only so you can ask what the agent believed when
 * it acted, it refuses a blind overwrite so two overlapping runs cannot erase
 * each other's learning, and only the agent, its steward, or an admin may write
 * it — a peer agent may not put beliefs in someone else's head.
 */
describeEmbeddedPostgres("agent memory", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-memory-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentMemory);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps every version and marks exactly one active", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "Forge");
    const svc = agentMemoryService(db);

    const first = await svc.write(company.id, agent.id, {
      content: "The gate CI job hangs on every PR; green means lint + test.",
      authorKind: "agent",
      authorAgentId: agent.id,
    });
    const second = await svc.write(company.id, agent.id, {
      content: "The gate CI job hangs on every PR. STATUS.md is authoritative for numbers.",
      authorKind: "agent",
      authorAgentId: agent.id,
      expectedVersion: first.version,
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);

    const active = await svc.active(company.id, agent.id);
    expect(active?.version).toBe(2);

    // The superseded row survives with its own provenance: "what did this agent
    // believe when it did that" is the question an incident review asks.
    const history = await svc.history(company.id, agent.id);
    expect(history.map((row) => row.version)).toEqual([2, 1]);
    expect(history[1]?.supersededAt).not.toBeNull();
    expect(history[0]?.supersededAt).toBeNull();
  });

  it("refuses a write that names a stale version instead of silently clobbering", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "Forge");
    const svc = agentMemoryService(db);

    const first = await svc.write(company.id, agent.id, {
      content: "Learned in run one.",
      authorKind: "agent",
      authorAgentId: agent.id,
    });
    await svc.write(company.id, agent.id, {
      content: "Learned in run one. Plus run two.",
      authorKind: "agent",
      authorAgentId: agent.id,
      expectedVersion: first.version,
    });

    // A second concurrent run still holding v1 must not erase run two's work.
    await expect(
      svc.write(company.id, agent.id, {
        content: "Learned in run one. Plus something else.",
        authorKind: "agent",
        authorAgentId: agent.id,
        expectedVersion: first.version,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const active = await svc.active(company.id, agent.id);
    expect(active?.content).toContain("Plus run two");
  });

  it("refuses a blind first write when memory already exists", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "Forge");
    const svc = agentMemoryService(db);
    await svc.write(company.id, agent.id, { content: "Something", authorKind: "agent", authorAgentId: agent.id });

    await expect(
      svc.write(company.id, agent.id, { content: "Replacing blind", authorKind: "agent", authorAgentId: agent.id }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a document over the cap with a revise-don't-append message", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "Forge");
    const svc = agentMemoryService(db);

    await expect(
      svc.write(company.id, agent.id, {
        content: "x".repeat(8_001),
        authorKind: "agent",
        authorAgentId: agent.id,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("lets an agent write its own memory but not a peer's", async () => {
    const company = await createCompany(db);
    const mine = await createAgent(db, company.id, "Forge");
    const peer = await createAgent(db, company.id, "Beacon");

    const app = await createApp(db, {
      type: "agent",
      agentId: mine.id,
      companyId: company.id,
      companyIds: [company.id],
    });

    const own = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .put(`/api/companies/${company.id}/agents/${mine.id}/memory`)
        .send({ content: "Mine to write." }),
    );
    expect(own.status).toBe(200);
    expect(own.body.memory.authorKind).toBe("agent");

    const other = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .put(`/api/companies/${company.id}/agents/${peer.id}/memory`)
        .send({ content: "A belief I am planting in a colleague." }),
    );
    expect(other.status).toBe(403);
  });

  it("lets the active steward correct the agent, attributed as a steward edit", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "Forge");
    const steward = await createUserMember(db, company.id, "operator");
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: steward,
      assignedByUserId: steward,
    });

    const app = await createApp(db, {
      type: "board",
      userId: steward,
      companyId: company.id,
      companyIds: [company.id],
    });
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .put(`/api/companies/${company.id}/agents/${agent.id}/memory`)
        .send({ content: "Correcting what you believed about the deploy path." }),
    );

    expect(res.status).toBe(200);
    // The author is recorded so a reader can tell the agent's own belief from a
    // human's correction.
    expect(res.body.memory.authorKind).toBe("steward");
    expect(res.body.memory.authorUserId).toBe(steward);
  });

  it("lets a company admin fix an unstewarded agent, since nobody else could", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "Forge");
    const admin = await createUserMember(db, company.id, "admin");

    const app = await createApp(db, {
      type: "board",
      userId: admin,
      companyId: company.id,
      companyIds: [company.id],
    });
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .put(`/api/companies/${company.id}/agents/${agent.id}/memory`)
        .send({ content: "Admin correction." }),
    );

    expect(res.status).toBe(200);
    expect(res.body.memory.authorKind).toBe("admin");
  });

  it("refuses an ordinary member who is neither the steward nor an admin", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "Forge");
    const bystander = await createUserMember(db, company.id, "operator");

    const app = await createApp(db, {
      type: "board",
      userId: bystander,
      companyId: company.id,
      companyIds: [company.id],
    });
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .put(`/api/companies/${company.id}/agents/${agent.id}/memory`)
        .send({ content: "Not mine to write." }),
    );

    expect(res.status).toBe(403);
  });

  it("serves a narrow runtime projection carrying no row or company id", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "Forge");
    const svc = agentMemoryService(db);
    await svc.write(company.id, agent.id, {
      content: "Durable fact.",
      authorKind: "agent",
      authorAgentId: agent.id,
    });

    const runtime = await svc.activeForRuntime(company.id, agent.id);

    // The shape the model sees stays small on purpose — a narrow projection is
    // hard to grow into a capability channel by accident.
    expect(Object.keys(runtime ?? {}).sort()).toEqual([
      "authorKind",
      "content",
      "version",
      "writtenAt",
    ]);
  });

  it("reports no memory rather than an empty document for a fresh agent", async () => {
    const company = await createCompany(db);
    const agent = await createAgent(db, company.id, "Forge");
    expect(await agentMemoryService(db).active(company.id, agent.id)).toBeNull();
    expect(await agentMemoryService(db).activeForRuntime(company.id, agent.id)).toBeNull();
  });
});
