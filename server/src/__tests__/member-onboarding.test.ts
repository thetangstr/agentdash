import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, agentStewardships, companies, createDb, onboardingSessions } from "@paperclipai/db";
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
  }, 120_000);

  afterEach(async () => {
    await db.delete(onboardingSessions);
    await db.delete(agentStewardships);
    await db.delete(agents);
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

  // AgentDash (scan 5, lane access): the UI shows steward wording only for
  // members with an active stewardship — listForUser carries the flag.
  it("reports isSteward only for members with an active stewardship", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "MKThink", issuePrefix: "MKT" });
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: "CoS", role: "chief_of_staff", adapterType: "codex_local" })
      .returning();
    const [pastAgent] = await db
      .insert(agents)
      .values({ companyId, name: "Past agent", role: "engineer", adapterType: "codex_local" })
      .returning();
    await db.insert(agentStewardships).values({ companyId, agentId: agent.id, userId: "steward-1" });
    // An ended stewardship does not count.
    await db.insert(agentStewardships).values({ companyId, agentId: pastAgent.id, userId: "ex-steward", endedAt: new Date() });
    const service = memberOnboardingService(db);
    await service.startOrResume(companyId, "steward-1");
    await service.startOrResume(companyId, "member-1");

    const [steward] = await service.listForUser("steward-1", [companyId]);
    const [member] = await service.listForUser("member-1", [companyId]);
    expect(steward.isSteward).toBe(true);
    expect(member.isSteward).toBe(false);
  });
});
