import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, serverErrors } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { serverErrorRoutes } from "../routes/server-errors.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * O2: the page that makes O1 worth having. These cases hold the two
 * properties that matter — only an instance admin can read internals, and
 * the response answers "would anyone have been told" alongside "what broke".
 */
describeEmbeddedPostgres("GET /instance/errors", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-errors-route-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(async () => {
    await db.delete(serverErrors);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appAs(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", serverErrorRoutes(db));
    app.use(errorHandler);
    return app;
  }

  const instanceAdmin = { type: "board", source: "session", userId: "titus", isInstanceAdmin: true };
  const ordinaryMember = {
    type: "board",
    source: "session",
    userId: "sam",
    isInstanceAdmin: false,
    companyIds: ["c1"],
    memberships: [{ companyId: "c1", membershipRole: "member", status: "active" }],
  };

  async function seed(fingerprint = randomUUID()) {
    await db.insert(serverErrors).values({
      fingerprint,
      name: "TypeError",
      message: "cannot read properties of undefined",
      stack: "TypeError: ...\n    at /src/routes/thing.ts",
      lastContext: { method: "POST", url: "/api/things", status: 500 },
      count: 3,
    });
    return fingerprint;
  }

  it("refuses an ordinary member — stacks name internals", async () => {
    await seed();
    const res = await request(appAs(ordinaryMember)).get("/api/instance/errors");
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("cannot read properties");
  });

  it("refuses an agent outright", async () => {
    await seed();
    const res = await request(
      appAs({ type: "agent", agentId: "a1", companyId: "c1", source: "agent_key" }),
    ).get("/api/instance/errors");
    expect(res.status).toBe(403);
  });

  it("returns grouped errors plus the alerter status to an instance admin", async () => {
    await seed();
    const res = await request(appAs(instanceAdmin)).get("/api/instance/errors");

    expect(res.status).toBe(200);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatchObject({ name: "TypeError", count: 3 });
    // The second question, answered on the same page as the first: an error
    // list that does not say whether anyone was told repeats the original bug.
    expect(res.body.alerter).toHaveProperty("configured");
    expect(res.body.alerter).toHaveProperty("droppedSinceBoot");
  });

  it("clears one fingerprint, and clearing an unknown one 404s", async () => {
    const fp = await seed();
    const ok = await request(appAs(instanceAdmin)).delete(`/api/instance/errors/${fp}`);
    expect(ok.status).toBe(200);
    expect(await db.select().from(serverErrors)).toHaveLength(0);

    const missing = await request(appAs(instanceAdmin)).delete("/api/instance/errors/not-a-real-fp");
    expect(missing.status).toBe(404);
  });

  it("a member cannot clear either — refusal is not read-only", async () => {
    const fp = await seed();
    const res = await request(appAs(ordinaryMember)).delete(`/api/instance/errors/${fp}`);
    expect(res.status).toBe(403);
    expect(await db.select().from(serverErrors)).toHaveLength(1);
  });
});
