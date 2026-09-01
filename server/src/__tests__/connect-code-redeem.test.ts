import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agentConnectCodes,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { connectCodeRoutes } from "../routes/connect-codes.js";
import { hashConnectCode } from "../lib/connect-codes.js";

/**
 * The properties worth testing here are database properties, not handler
 * properties: single use, expiry, and what happens when two machines race the
 * same code. Mocking the service layer would assert nothing about any of them,
 * so this runs against a real Postgres.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("POST /api/connect/redeem", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-connect-code-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use("/api", connectCodeRoutes(db, { deploymentMode: "authenticated" }));
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    // The redeem path writes an activity row referencing the company, so this
    // has to come first or the company delete trips its foreign key.
    await db.delete(activityLog);
    await db.delete(agentConnectCodes);
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function seed(input?: { expiresAt?: Date; redeemedAt?: Date; revokedAt?: Date; agentStatus?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const code = "KVTX8F02";

    await db.insert(companies).values({
      id: companyId,
      name: "Kestrel Bay",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CoS",
      role: "chief_of_staff",
      status: input?.agentStatus ?? "idle",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentConnectCodes).values({
      companyId,
      agentId,
      codeHash: hashConnectCode(code),
      expiresAt: input?.expiresAt ?? new Date(Date.now() + 10 * 60 * 1000),
      redeemedAt: input?.redeemedAt ?? null,
      revokedAt: input?.revokedAt ?? null,
    });

    return { companyId, agentId, code };
  }

  it("trades a code for a key named after the machine that redeemed it", async () => {
    const { agentId, code } = await seed();

    const res = await request(app)
      .post("/api/connect/redeem")
      .send({ code: "kvtx-8f02", deviceName: "titus-macbook" });

    expect(res.status).toBe(200);
    expect(res.body.apiKey).toMatch(/^pcp_[0-9a-f]{48}$/);
    expect(res.body).toMatchObject({ agentId, agentName: "CoS", companyName: "Kestrel Bay", deviceName: "titus-macbook" });

    // The key must be identifiable later, or per-device revocation is guesswork.
    const keys = await db.select().from(agentApiKeys).where(eq(agentApiKeys.agentId, agentId));
    expect(keys).toHaveLength(1);
    expect(keys[0]?.name).toBe("CoS — titus-macbook");

    // And the code must be spent, with the key it produced recorded against it.
    const [row] = await db.select().from(agentConnectCodes);
    expect(row?.redeemedAt).toBeTruthy();
    expect(row?.issuedApiKeyId).toBe(keys[0]?.id);
  });

  it("refuses the same code a second time", async () => {
    const { code } = await seed();

    const first = await request(app).post("/api/connect/redeem").send({ code, deviceName: "one" });
    expect(first.status).toBe(200);

    const second = await request(app).post("/api/connect/redeem").send({ code, deviceName: "two" });
    expect(second.status).toBe(400);

    // Exactly one key, or "single use" is a claim rather than a property.
    expect(await db.select().from(agentApiKeys)).toHaveLength(1);
  });

  it("gives exactly one winner when two machines race the same code", async () => {
    const { code } = await seed();

    const results = await Promise.all(
      Array.from({ length: 6 }, (_unused, i) =>
        request(app).post("/api/connect/redeem").send({ code, deviceName: `racer-${i}` }),
      ),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await db.select().from(agentApiKeys)).toHaveLength(1);
  });

  it("refuses an expired code", async () => {
    const { code } = await seed({ expiresAt: new Date(Date.now() - 1_000) });
    const res = await request(app).post("/api/connect/redeem").send({ code });
    expect(res.status).toBe(400);
    expect(await db.select().from(agentApiKeys)).toHaveLength(0);
  });

  it("refuses a revoked code", async () => {
    const { code } = await seed({ revokedAt: new Date() });
    const res = await request(app).post("/api/connect/redeem").send({ code });
    expect(res.status).toBe(400);
  });

  it("refuses to pair with a terminated agent, and still spends the code", async () => {
    const { code } = await seed({ agentStatus: "terminated" });
    const res = await request(app).post("/api/connect/redeem").send({ code });
    expect(res.status).toBe(400);
    expect(await db.select().from(agentApiKeys)).toHaveLength(0);

    // Spent, deliberately: a failed attempt must not hand the code back for
    // another try, or a rejected caller can keep retrying it.
    const [row] = await db.select().from(agentConnectCodes);
    expect(row?.redeemedAt).toBeTruthy();
  });

  it("says the same thing however it fails, so it cannot be used as an oracle", async () => {
    // Unknown, expired and already-used are three different server states. If
    // they read differently, an attacker can enumerate which codes exist.
    const unknown = await request(app).post("/api/connect/redeem").send({ code: "ZZZZ9999" });

    const { code: expiredCode } = await seed({ expiresAt: new Date(Date.now() - 1_000) });
    const expired = await request(app).post("/api/connect/redeem").send({ code: expiredCode });
    await db.delete(activityLog);
    await db.delete(agentConnectCodes);
    await db.delete(agents);
    await db.delete(companies);

    const { code: usedCode } = await seed({ redeemedAt: new Date() });
    const used = await request(app).post("/api/connect/redeem").send({ code: usedCode });

    expect(unknown.status).toBe(400);
    expect(expired.status).toBe(400);
    expect(used.status).toBe(400);
    expect(unknown.body.error).toBe(expired.body.error);
    expect(expired.body.error).toBe(used.body.error);
  });

  it("rejects an agent key pasted where a code belongs, without a database hit", async () => {
    await seed();
    const res = await request(app)
      .post("/api/connect/redeem")
      .send({ code: `pcp_${"a".repeat(48)}` });
    expect(res.status).toBe(400);
    expect(await db.select().from(agentApiKeys)).toHaveLength(0);
  });

  it("names a key honestly when the client sends no device name", async () => {
    const { code } = await seed();
    const res = await request(app).post("/api/connect/redeem").send({ code });
    expect(res.status).toBe(200);
    const [key] = await db.select().from(agentApiKeys);
    expect(key?.name).toBe("CoS — unnamed device");
  });
});
