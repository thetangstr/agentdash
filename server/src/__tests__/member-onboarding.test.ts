import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, onboardingSessions } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { memberOnboardingService } from "../services/member-onboarding.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("member onboarding lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-onboarding-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(onboardingSessions);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  it("starts once, resumes the saved step, and never reopens completion", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "MKThink",
      issuePrefix: "MKT",
    });
    const service = memberOnboardingService(db);

    const started = await service.startOrResume(companyId, "invitee-1");
    expect(started).toMatchObject({ status: "in_progress", currentStep: "welcome" });
    await service.advance(companyId, "invitee-1", "workspace");
    const resumed = await service.startOrResume(companyId, "invitee-1");
    expect(resumed).toMatchObject({ status: "in_progress", currentStep: "workspace" });
    expect(await db.select().from(onboardingSessions)).toHaveLength(1);

    await service.complete(companyId, "invitee-1");
    const afterCompletion = await service.startOrResume(companyId, "invitee-1");
    expect(afterCompletion?.status).toBe("completed");
    expect(afterCompletion?.completedAt).not.toBeNull();
    expect(await db.select().from(onboardingSessions)).toHaveLength(1);
  });

  it("keeps progress isolated by user and company", async () => {
    const firstCompanyId = randomUUID();
    const secondCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: firstCompanyId, name: "MKThink", issuePrefix: "MKT" },
      { id: secondCompanyId, name: "Second", issuePrefix: "SEC" },
    ]);
    const service = memberOnboardingService(db);
    await service.startOrResume(firstCompanyId, "invitee-1");
    await service.startOrResume(firstCompanyId, "invitee-2");
    await service.startOrResume(secondCompanyId, "invitee-1");

    expect(await service.listForUser("invitee-1", [firstCompanyId])).toHaveLength(1);
    expect(await service.listForUser("invitee-1", [firstCompanyId, secondCompanyId])).toHaveLength(2);
    expect(await service.listForUser("invitee-2", [firstCompanyId, secondCompanyId])).toHaveLength(1);
  });
});
