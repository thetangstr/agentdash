import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, environments, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService, requireProductProfile } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres AgentDash MK profile tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyService product profile", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companyService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agentdash-mk-profile-");
    db = createDb(tempDb.connectionString);
    svc = companyService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companyMemberships);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns the default product profile when a company is created without one", async () => {
    const created = await svc.create({ name: "Default Profile Co" });

    expect(created.productProfile).toBe("default");
  });

  it("returns agentdash_mk when a company is created with the AgentDash MK profile", async () => {
    const created = await svc.create({
      name: "AgentDash MK Co",
      productProfile: "agentdash_mk",
    });

    expect(created.productProfile).toBe("agentdash_mk");
  });

  it("requires profile-only routes to match the company product profile", async () => {
    const created = await svc.create({ name: "Default Profile Co" });

    expect(requireProductProfile(created, "default")).toBe(created);
    expect(() => requireProductProfile(created, "agentdash_mk")).toThrowError(
      expect.objectContaining({
        status: 404,
        message: "Company not found",
      }),
    );
  });
});
