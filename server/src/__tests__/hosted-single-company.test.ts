// AgentDash (#725, orchestrator decision for 1.0): a hosted box holds exactly
// one company. Every create path goes through companyService.create, which
// refuses a second active company under an advisory lock.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService, SingleCompanyInstallationError } from "../services/companies.js";

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

  it("allows several companies off a hosted box", async () => {
    delete process.env.AGENTDASH_DEPLOYMENT_KIND;
    const svc = companyService(db);
    await svc.create({ name: "One" });
    await svc.create({ name: "Two" });
    expect(await db.select().from(companies)).toHaveLength(2);
  });
});
