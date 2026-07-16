import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  mandates,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { mandateRoutes } from "../routes/mandates.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("mandates routes (integration)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mandates-route-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(mandates);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // App with an injected actor — mirrors mandated-actions-route.test.ts: an
  // express app with a middleware that sets (req as any).actor before
  // mounting the router, plus the same error-handling middleware app.ts
  // wires so thrown authz/validation errors surface as real HTTP status
  // codes rather than crashing the test.
  function appFor(actor: unknown) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use(mandateRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyAndAgents(): Promise<{
    companyId: string;
    grantorAgentId: string;
    granteeAgentId: string;
  }> {
    const [company] = await db.insert(companies).values({ name: "Mandate Route Co" }).returning();
    const [grantor] = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Grantor Agent" })
      .returning();
    const [grantee] = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Grantee Agent" })
      .returning();
    return { companyId: company.id, grantorAgentId: grantor.id, granteeAgentId: grantee.id };
  }

  it("POST creates a mandate and returns 201 (flag-off: no anchor)", async () => {
    const { companyId, grantorAgentId, granteeAgentId } = await seedCompanyAndAgents();
    const app = appFor({ type: "board", userId: "board-user", source: "local_implicit" });

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .post(`/companies/${companyId}/mandates`)
      .send({
        grantorAgentId,
        granteeAgentId,
        scope: { description: "x" },
        permissionKey: "clockchain:attest",
        spendCapCents: 5000,
        expiresAt,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      granteeAgentId,
      status: "active",
      ccLedgerId: null,
    });
    expect(res.body.id).toBeTruthy();
  });

  it("GET lists mandates filtered by granteeAgentId", async () => {
    const { companyId, grantorAgentId, granteeAgentId } = await seedCompanyAndAgents();
    const app = appFor({ type: "board", userId: "board-user", source: "local_implicit" });

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post(`/companies/${companyId}/mandates`)
      .send({
        grantorAgentId,
        granteeAgentId,
        scope: { description: "x" },
        permissionKey: "clockchain:attest",
        spendCapCents: 5000,
        expiresAt,
      });
    expect(createRes.status).toBe(201);

    const res = await request(app).get(`/companies/${companyId}/mandates`).query({ granteeAgentId });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((m: { id: string }) => m.id === createRes.body.id)).toBe(true);
  });

  it("POST missing expiresAt returns 400", async () => {
    const { companyId, grantorAgentId, granteeAgentId } = await seedCompanyAndAgents();
    const app = appFor({ type: "board", userId: "board-user", source: "local_implicit" });

    const res = await request(app)
      .post(`/companies/${companyId}/mandates`)
      .send({
        grantorAgentId,
        granteeAgentId,
        scope: { description: "x" },
        permissionKey: "clockchain:attest",
        spendCapCents: 5000,
      });

    expect(res.status).toBe(400);
  });
});
