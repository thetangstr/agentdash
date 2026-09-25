// AgentDash (#725, orchestrator decision for 1.0): a hosted box holds exactly
// one company. Every create path goes through companyService.create, which
// refuses a second active company under an advisory lock.
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService, SingleCompanyInstallationError } from "../services/companies.js";
import { errorHandler } from "../middleware/error-handler.js";
import { trialRoutes } from "../routes/trial.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("hosted box: one company", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const saved = process.env.AGENTDASH_DEPLOYMENT_KIND;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hosted-single-company-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await db.execute("truncate table companies cascade" as never);
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.AGENTDASH_DEPLOYMENT_KIND;
    else process.env.AGENTDASH_DEPLOYMENT_KIND = saved;
  });

  it("refuses a second company on a hosted box, even when two creates race", async () => {
    process.env.AGENTDASH_DEPLOYMENT_KIND = "hosted";
    const svc = companyService(db);
    const results = await Promise.allSettled([svc.create({ name: "First" }), svc.create({ name: "Second" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(SingleCompanyInstallationError);
    await expect(svc.create({ name: "Third" })).rejects.toBeInstanceOf(SingleCompanyInstallationError);
    expect(await db.select().from(companies)).toHaveLength(1);
  });

  // The anonymous Test Drive creates a company. Were it reachable, a stranger
  // could take the box's only company before the founder.
  it("refuses the whole trial surface on a hosted box, and the founder's first company then succeeds", async () => {
    process.env.AGENTDASH_DEPLOYMENT_KIND = "hosted";
    const savedTrial = process.env.AGENTDASH_TRIAL_ANONYMOUS;
    process.env.AGENTDASH_TRIAL_ANONYMOUS = "true";
    try {
      const app = express();
      app.use(express.json());
      app.use("/api/trial", trialRoutes(db));
      app.use(errorHandler);

      const session = await request(app).post("/api/trial/session").send({});
      expect(session.status).toBe(503);
      expect(session.body).toEqual({ error: "trial_disabled" });
      expect((await request(app).get("/api/trial/share/some-token")).status).toBe(503);
      expect(await db.select().from(companies)).toHaveLength(0);

      const founder = await companyService(db).create({ name: "Founder Co" });
      expect(founder.name).toBe("Founder Co");
      expect(await db.select().from(companies)).toHaveLength(1);
    } finally {
      if (savedTrial === undefined) delete process.env.AGENTDASH_TRIAL_ANONYMOUS;
      else process.env.AGENTDASH_TRIAL_ANONYMOUS = savedTrial;
    }
  });

  it("answers 409, not 500, when a create path does not catch the one-company error", async () => {
    const app = express();
    app.post("/create", () => {
      throw new SingleCompanyInstallationError("company-existing");
    });
    app.use(errorHandler);
    const res = await request(app).post("/create");
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ code: "single_company_installation", existingCompanyId: "company-existing" });
  });

  it("allows several companies off a hosted box", async () => {
    delete process.env.AGENTDASH_DEPLOYMENT_KIND;
    const svc = companyService(db);
    await svc.create({ name: "One" });
    await svc.create({ name: "Two" });
    expect(await db.select().from(companies)).toHaveLength(2);
  });
});
