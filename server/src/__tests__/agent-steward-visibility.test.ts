import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentStewardships,
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
import { agentStewardshipService } from "../services/agent-stewardships.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

async function createCompany(db: TestDb) {
  return db
    .insert(companies)
    .values({
      name: `Steward Visibility ${randomUUID()}`,
      issuePrefix: `SV${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

/**
 * A member with a real auth user row behind it, which is the ordinary case and
 * the only one that can produce a name and an email.
 */
async function createUserMember(
  db: TestDb,
  companyId: string,
  input: { name: string; email: string },
) {
  const userId = randomUUID();
  const now = new Date();
  await db.insert(authUsers).values({
    id: userId,
    name: input.name,
    email: input.email,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "operator",
  });
  return userId;
}

/**
 * A member whose principal id has no auth user row. `agent_stewardships.user_id`
 * is a durable principal id rather than an auth foreign key, so this is a shape
 * the table is designed to hold, not a corrupt row.
 */
async function createPrincipalOnlyMember(db: TestDb, companyId: string) {
  const userId = randomUUID();
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "operator",
  });
  return userId;
}

async function createAgent(
  db: TestDb,
  companyId: string,
  name: string,
  adapterConfig: Record<string, unknown> = {},
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig,
    })
    .returning()
    .then((rows) => rows[0]!);
}

function makeAgentActor(companyId: string, agentId: string) {
  return { type: "agent", agentId, companyId };
}

async function createApp(db: TestDb, actor: Record<string, unknown>) {
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
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

/**
 * The gap this covers: stewardship existed in the database and on a dedicated
 * route, but nothing an agent reads carried it. An agent asking another agent
 * for something, or listing the company, saw names, roles and adapters and had
 * no way to say which person stands behind any of them — while every mandate
 * this product writes instructs it to consult "your steward".
 */
describeEmbeddedPostgres("agent steward visibility", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-steward-visibility-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("resolves the steward's name and email for a batch of agents in one query", async () => {
    const company = await createCompany(db);
    const titus = await createUserMember(db, company.id, {
      name: "Titus",
      email: "titus@example.com",
    });
    const casper = await createAgent(db, company.id, "Casper");
    const unstewarded = await createAgent(db, company.id, "Nobody's Agent");
    const service = agentStewardshipService(db);
    await service.assign(company.id, {
      agentId: casper.id,
      userId: titus,
      assignedByUserId: titus,
    });

    const stewards = await service.activeStewardsByAgentIds(company.id, [
      casper.id,
      unstewarded.id,
    ]);

    expect(stewards.get(casper.id)).toMatchObject({
      userId: titus,
      name: "Titus",
      email: "titus@example.com",
    });
    expect(stewards.get(casper.id)?.since).toBeInstanceOf(Date);
    // Absent, not a row with empty fields: "no steward" and "a steward we could
    // not name" are different answers and the caller has to be able to tell.
    expect(stewards.has(unstewarded.id)).toBe(false);
  });

  it("still reports a steward whose principal has no auth user row", async () => {
    const company = await createCompany(db);
    const principalOnly = await createPrincipalOnlyMember(db, company.id);
    const agent = await createAgent(db, company.id, "Casper");
    const service = agentStewardshipService(db);
    await service.assign(company.id, {
      agentId: agent.id,
      userId: principalOnly,
      assignedByUserId: null,
    });

    const steward = await service.activeStewardForAgent(company.id, agent.id);

    // The join is a LEFT join precisely for this: dropping the row would tell
    // the caller the agent is unstewarded, which is wrong.
    expect(steward).toMatchObject({ userId: principalOnly, name: null, email: null });
  });

  it("does not report a steward once the stewardship has ended", async () => {
    const company = await createCompany(db);
    const titus = await createUserMember(db, company.id, {
      name: "Titus",
      email: "titus@example.com",
    });
    const agent = await createAgent(db, company.id, "Casper");
    const service = agentStewardshipService(db);
    await service.assign(company.id, {
      agentId: agent.id,
      userId: titus,
      assignedByUserId: titus,
    });

    await service.endActiveForUser(company.id, titus, titus);

    expect(await service.activeStewardForAgent(company.id, agent.id)).toBeNull();
  });

  it("names each agent's steward in the company agent list an agent reads", async () => {
    const company = await createCompany(db);
    const titus = await createUserMember(db, company.id, {
      name: "Titus",
      email: "titus@example.com",
    });
    const sam = await createUserMember(db, company.id, {
      name: "Sam",
      email: "sam@example.com",
    });
    const casper = await createAgent(db, company.id, "Casper");
    const samsAgent = await createAgent(db, company.id, "Sam's Agent");
    const service = agentStewardshipService(db);
    await service.assign(company.id, { agentId: casper.id, userId: titus, assignedByUserId: titus });
    await service.assign(company.id, { agentId: samsAgent.id, userId: sam, assignedByUserId: titus });

    const app = await createApp(db, makeAgentActor(company.id, casper.id));
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/agents`),
    );

    expect(res.status).toBe(200);
    const byName = new Map(
      (res.body as Array<{ name: string; steward: { name: string } | null }>).map((agent) => [
        agent.name,
        agent.steward,
      ]),
    );
    expect(byName.get("Casper")).toMatchObject({ userId: titus, name: "Titus" });
    expect(byName.get("Sam's Agent")).toMatchObject({ userId: sam, name: "Sam" });
  });

  it("keeps the steward on the restricted list view that redacts adapter config", async () => {
    const company = await createCompany(db);
    const titus = await createUserMember(db, company.id, {
      name: "Titus",
      email: "titus@example.com",
    });
    // A non-empty adapter config so the redaction is observable: asserting
    // `{}` against an agent that never had one would pass without redacting.
    const casper = await createAgent(db, company.id, "Casper", { command: "run-casper" });
    const reader = await createAgent(db, company.id, "Reader");
    const service = agentStewardshipService(db);
    await service.assign(company.id, { agentId: casper.id, userId: titus, assignedByUserId: titus });

    // `Reader` has no `agents:create` grant and cannot create agents, so it gets
    // the restricted view. Stewardship is the org chart, not a credential, so it
    // must survive the redaction that strips adapter and runtime config.
    const app = await createApp(db, makeAgentActor(company.id, reader.id));
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/agents`),
    );

    expect(res.status).toBe(200);
    const casperRow = (res.body as Array<{ id: string; adapterConfig: unknown; steward: unknown }>)
      .find((agent) => agent.id === casper.id);
    expect(casperRow?.adapterConfig).toEqual({});
    expect(casperRow?.steward).toMatchObject({ userId: titus, name: "Titus" });
  });

  it("carries createdByUserId on reads, including the restricted view (AGE-13)", async () => {
    const company = await createCompany(db);
    const titus = await createUserMember(db, company.id, {
      name: "Titus",
      email: "titus@example.com",
    });
    const [casper] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Casper",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "run-casper" },
        createdByUserId: titus,
      })
      .returning();
    const reader = await createAgent(db, company.id, "Reader");

    // Single read: the owner of record is on the payload.
    const app = await createApp(db, makeAgentActor(company.id, reader.id));
    const single = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/agents/${casper.id}`),
    );
    expect(single.status).toBe(200);
    expect(single.body.createdByUserId).toBe(titus);

    // Restricted list view: redaction strips adapter config but must keep the
    // owner of record — like stewardship, it is org chart, not credential.
    const list = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/agents`),
    );
    expect(list.status).toBe(200);
    const casperRow = (
      list.body as Array<{ id: string; adapterConfig: unknown; createdByUserId: unknown }>
    ).find((agent) => agent.id === casper.id);
    expect(casperRow?.adapterConfig).toEqual({});
    expect(casperRow?.createdByUserId).toBe(titus);
  });

  it("names the steward on a single agent read, so one agent can name another's human", async () => {
    const company = await createCompany(db);
    const titus = await createUserMember(db, company.id, {
      name: "Titus",
      email: "titus@example.com",
    });
    const casper = await createAgent(db, company.id, "Casper");
    const asker = await createAgent(db, company.id, "Asker");
    const service = agentStewardshipService(db);
    await service.assign(company.id, { agentId: casper.id, userId: titus, assignedByUserId: titus });

    const app = await createApp(db, makeAgentActor(company.id, asker.id));
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/agents/${casper.id}`),
    );

    expect(res.status).toBe(200);
    expect(res.body.steward).toMatchObject({
      userId: titus,
      name: "Titus",
      email: "titus@example.com",
    });
  });

  it("tells an agent its own steward through the route whoami reads", async () => {
    const company = await createCompany(db);
    const titus = await createUserMember(db, company.id, {
      name: "Titus",
      email: "titus@example.com",
    });
    const casper = await createAgent(db, company.id, "Casper");
    const service = agentStewardshipService(db);
    await service.assign(company.id, { agentId: casper.id, userId: titus, assignedByUserId: titus });

    const app = await createApp(db, makeAgentActor(company.id, casper.id));
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/agents/me"));

    expect(res.status).toBe(200);
    expect(res.body.steward).toMatchObject({ userId: titus, name: "Titus" });
  });

  it("reports a null steward rather than omitting the field when nobody holds one", async () => {
    const company = await createCompany(db);
    const casper = await createAgent(db, company.id, "Casper");

    const app = await createApp(db, makeAgentActor(company.id, casper.id));
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/agents/me"));

    expect(res.status).toBe(200);
    // An agent reading a missing key cannot tell "unstewarded" from "this build
    // does not report stewards", so the key is always present.
    expect(res.body).toHaveProperty("steward");
    expect(res.body.steward).toBeNull();
  });
});
