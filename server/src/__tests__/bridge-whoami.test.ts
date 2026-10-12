import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authUsers, bridgeEndpoints, companies, companyMemberships, createDb } from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { bridgeRoutes } from "../routes/bridge.js";
import { featureFlagsService } from "../services/feature-flags.js";
import { truncateWithRetry } from "./helpers/truncate.js";

/**
 * `POST /api/bridge/whoami`: what `agentdash-connect check` asks.
 *
 * A machine says whose inbox it holds, its own label and capabilities, and
 * whether the company has turned co-worker review on, so the person can tell
 * "reconnect to get bridge:work" from "your company has not turned it on".
 * It answers only about the calling endpoint, and nothing for anyone else.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

describeEmbeddedPostgres("bridge whoami", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bridge-whoami-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const company = await db
      .insert(companies)
      .values({ name: `Whoami ${randomUUID()}`, issuePrefix: `WH${randomUUID().slice(0, 4).toUpperCase().replace(/[^A-Z]/g, "X")}` })
      .returning()
      .then((rows) => rows[0]!);
    const userId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Person A", email: "person-a@example.test", createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    return { company, userId };
  }

  async function endpointFor(
    companyId: string,
    userId: string,
    values: Partial<typeof bridgeEndpoints.$inferInsert> = {},
  ) {
    return db
      .insert(bridgeEndpoints)
      .values({
        companyId,
        userId,
        label: "person-a-laptop (darwin)",
        tokenHash: `hash-${randomUUID()}`,
        capabilities: ["bridge:read", "bridge:inbox", "bridge:work"],
        enrolledAt: new Date(),
        ...values,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  function app(actor: Record<string, unknown>) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    server.use("/api", bridgeRoutes(db, { autoDispatchQueuedRuns: false }));
    server.use(errorHandler);
    return server;
  }

  const asEndpoint = (endpoint: { id: string; companyId: string }) => ({
    type: "none",
    source: "bridge_endpoint",
    companyId: endpoint.companyId,
    bridgeEndpointId: endpoint.id,
  });

  it("describes the calling machine: owner, label, capabilities and the company's review flag", async () => {
    const { company, userId } = await seed();
    const endpoint = await endpointFor(company.id, userId);

    const off = await request(app(asEndpoint(endpoint))).post("/api/bridge/whoami").send({});
    expect(off.status).toBe(200);
    expect(off.body).toEqual({
      owner: { name: "Person A", email: "person-a@example.test" },
      endpoint: {
        id: endpoint.id,
        label: "person-a-laptop (darwin)",
        capabilities: ["bridge:read", "bridge:inbox", "bridge:work"],
      },
      coworkerBridgeEnabled: false,
    });

    await featureFlagsService(db).set(company.id, FEATURE_FLAG_KEYS.COWORKER_BRIDGE, true);
    const on = await request(app(asEndpoint(endpoint))).post("/api/bridge/whoami").send({});
    expect(on.body.coworkerBridgeEnabled).toBe(true);
  });

  it("answers for a machine without bridge:work too, so it can be told to reconnect", async () => {
    const { company, userId } = await seed();
    const endpoint = await endpointFor(company.id, userId, { capabilities: ["bridge:read", "bridge:inbox"] });
    const res = await request(app(asEndpoint(endpoint))).post("/api/bridge/whoami").send({});
    expect(res.status).toBe(200);
    expect(res.body.endpoint.capabilities).toEqual(["bridge:read", "bridge:inbox"]);
  });

  it("refuses anything that is not a live endpoint", async () => {
    const { company, userId } = await seed();
    const revoked = await endpointFor(company.id, userId, { revokedAt: new Date() });
    expect((await request(app(asEndpoint(revoked))).post("/api/bridge/whoami").send({})).status).toBe(404);

    const unapproved = await endpointFor(company.id, userId, { enrolledAt: null });
    expect((await request(app(asEndpoint(unapproved))).post("/api/bridge/whoami").send({})).status).toBe(409);

    const board = { type: "board", userId, source: "session", companyIds: [company.id] };
    expect((await request(app(board)).post("/api/bridge/whoami").send({})).status).toBe(403);
  });
});
