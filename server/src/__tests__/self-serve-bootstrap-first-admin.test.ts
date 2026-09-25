// AgentDash: self-serve-bootstrap, hosted first-admin gap. The first company on
// a box with no instance admin makes its creator the instance admin, whichever
// path created it: POST /api/companies (/company-create) or the /cos
// onboarding bootstrap. Before the fix only POST /api/companies promoted, so a
// founder who opened /cos first owned a company on a box with no instance admin.
//
// Both paths run against real access and company services on embedded Postgres.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, instanceUserRoles } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";
import { accessService } from "../services/access.js";
import { companyService } from "../services/companies.js";
import { onboardingOrchestrator } from "../services/onboarding-orchestrator.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("self-serve-bootstrap: first company creator becomes instance admin", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-serve-bootstrap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP = "true";
    delete process.env.AGENTDASH_ALLOW_MULTI_COMPANY;
    delete process.env.AGENTDASH_DEPLOYMENT_KIND;
    delete process.env.STRIPE_SECRET_KEY;
    await db.delete(instanceUserRoles);
    for (const c of await db.select({ id: companies.id }).from(companies)) {
      await companyService(db).remove(c.id);
    }
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  function companyCreateApp(userId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId, companyIds: [], isInstanceAdmin: false, source: "session" };
      next();
    });
    app.use("/api/companies", companyRoutes(db, undefined, {}));
    app.use(errorHandler);
    return app;
  }

  // The /cos path: real access + company services; the CoS agent, its bundle
  // and the conversation are stubbed because they are not what is under test.
  function cosBootstrap(userId: string) {
    const users = { getById: async (id: string) => ({ id, email: `${id}@${id}.example`, name: id }) };
    return onboardingOrchestrator({
      access: accessService(db),
      companies: companyService(db),
      agents: {
        list: async () => [],
        listKeys: async () => [],
        create: async (companyId: string) => ({ id: randomUUID(), companyId, role: "chief_of_staff" }),
        createApiKey: async () => ({}),
      },
      instructions: { materializeManagedBundle: async () => ({ adapterConfig: {} }) },
      conversations: {
        findByCompany: async () => ({ id: randomUUID() }),
        create: async () => ({ id: randomUUID() }),
        addParticipant: async () => ({}),
        postMessage: async () => ({}),
      },
      users,
    }).bootstrap(userId);
  }

  async function adminIds() {
    const rows = await db
      .select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"));
    return rows.map((r) => r.userId).sort();
  }

  it("/cos first: the founder who opens /cos before /company-create becomes instance admin", async () => {
    const founder = `founder-${randomUUID()}`;
    const result = await cosBootstrap(founder);
    expect(await adminIds()).toEqual([founder]);
    const audit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "instance.admin_self_serve_bootstrap"));
    expect(audit.map((r) => r.companyId)).toEqual([result.companyId]);

    // A later company (multi-company allowed) does not promote its creator.
    process.env.AGENTDASH_ALLOW_MULTI_COMPANY = "true";
    const second = `second-${randomUUID()}`;
    const res = await request(companyCreateApp(second)).post("/api/companies").send({ name: "Second" });
    expect(res.status).toBe(201);
    expect(await adminIds()).toEqual([founder]);
  });

  it("/company-create first: the founder becomes instance admin; a later /cos company does not promote", async () => {
    const founder = `founder-${randomUUID()}`;
    const res = await request(companyCreateApp(founder)).post("/api/companies").send({ name: "Acme" });
    expect(res.status).toBe(201);
    expect(await adminIds()).toEqual([founder]);

    process.env.AGENTDASH_ALLOW_MULTI_COMPANY = "true";
    const second = `second-${randomUUID()}`;
    await cosBootstrap(second);
    expect(await adminIds()).toEqual([founder]);
  });

  it("does not promote on /cos when the flag is off", async () => {
    delete process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP;
    await cosBootstrap(`founder-${randomUUID()}`);
    expect(await adminIds()).toEqual([]);
  });

  it("does not promote the synthetic local-board actor", async () => {
    await cosBootstrap("local-board");
    expect(await adminIds()).toEqual([]);
  });

  it("does not promote on /cos when the box already has an instance admin", async () => {
    await db.insert(instanceUserRoles).values({ userId: "existing-admin", role: "instance_admin" });
    await cosBootstrap(`founder-${randomUUID()}`);
    expect(await adminIds()).toEqual(["existing-admin"]);
  });
});
