import { randomUUID } from "node:crypto";
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
import { mandatedActionRoutes } from "../routes/mandated-actions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("POST /companies/:companyId/mandated-actions (integration)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mandated-actions-");
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

  // App with an injected actor — mirrors the billing-trial-lifecycle.test.ts
  // pattern: an express app with a middleware that sets (req as any).actor
  // before mounting the router, plus the same error-handling middleware
  // app.ts wires so thrown authz/validation errors surface as real HTTP
  // status codes rather than crashing the test.
  function appFor(actor: unknown) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use(mandatedActionRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyAndAgent(): Promise<{ companyId: string; agentId: string }> {
    const [company] = await db.insert(companies).values({ name: "Mandated Action Co" }).returning();
    const [agent] = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Grantee Agent" })
      .returning();
    return { companyId: company.id, agentId: agent.id };
  }

  it("returns 200 with authorized:false, reason:not_found for a nonexistent mandateId (agent actor, flag-off)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const app = appFor({ type: "agent", agentId, companyId });

    const res = await request(app)
      .post(`/companies/${companyId}/mandated-actions`)
      .send({
        mandateId: randomUUID(),
        counterpartyDid: "did:example:counterparty",
        action: "transfer_funds",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authorized: false, reason: "not_found" });
  });

  it("returns 400 when mandateId is missing (validate())", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const app = appFor({ type: "agent", agentId, companyId });

    const res = await request(app)
      .post(`/companies/${companyId}/mandated-actions`)
      .send({
        counterpartyDid: "did:example:counterparty",
        action: "transfer_funds",
      });

    expect(res.status).toBe(400);
  });

  it("returns 403 when the agent actor's companyId differs from the URL company", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const otherCompanyId = randomUUID();
    const app = appFor({ type: "agent", agentId, companyId: otherCompanyId });

    const res = await request(app)
      .post(`/companies/${companyId}/mandated-actions`)
      .send({
        mandateId: randomUUID(),
        counterpartyDid: "did:example:counterparty",
        action: "transfer_funds",
      });

    expect(res.status).toBe(403);
  });

  it("ignores a body-supplied granteeAgentId for an agent actor and rejects the actor as a non-grantee", async () => {
    const { companyId, agentId: agentAId } = await seedCompanyAndAgent();
    const [agentB] = await db
      .insert(agents)
      .values({ companyId, name: "Other Agent" })
      .returning();

    const [mandate] = await db
      .insert(mandates)
      .values({
        companyId,
        grantorAgentId: agentAId,
        granteeAgentId: agentAId,
        scope: {},
        permissionKey: "clockchain:attest",
        spendCapCents: 1000,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .returning();

    const app = appFor({ type: "agent", agentId: agentB.id, companyId });

    const res = await request(app)
      .post(`/companies/${companyId}/mandated-actions`)
      .send({
        mandateId: mandate.id,
        counterpartyDid: "did:x",
        action: "verify",
        granteeAgentId: agentAId,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authorized: false, reason: "not_grantee" });
  });
});
