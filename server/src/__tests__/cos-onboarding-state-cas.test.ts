// AgentDash (#953 review): the CoS claims the goals -> plan step with a
// compare-and-set, so two replies racing past the interview run one plan step.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assistantConversations, assistantMessages, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { cosOnboardingStateService } from "../services/cos-onboarding-state.js";
import { conversationService } from "../services/conversations.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cos onboarding state: advancePhaseIf and hasCard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let conversationId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cos-cas-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    const companyId = randomUUID();
    conversationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: `CAS ${companyId.slice(0, 6)}`, issuePrefix: companyId.slice(0, 8) });
    await db.insert(assistantConversations).values({ id: conversationId, companyId, userId: "u1" });
  });

  it("lets exactly one of two concurrent claims move goals to plan", async () => {
    const svc = cosOnboardingStateService(db);
    await svc.getOrCreate(conversationId);

    const results = await Promise.all([
      svc.advancePhaseIf(conversationId, "goals", "plan"),
      svc.advancePhaseIf(conversationId, "goals", "plan"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await svc.get(conversationId))?.phase).toBe("plan");
  });

  it("does not move a phase that is no longer the expected one", async () => {
    const svc = cosOnboardingStateService(db);
    await svc.getOrCreate(conversationId);
    await svc.advancePhase(conversationId, "ready");

    expect(await svc.advancePhaseIf(conversationId, "goals", "plan")).toBeNull();
    expect((await svc.get(conversationId))?.phase).toBe("ready");
  });

  it("reports whether a plan card exists in the conversation", async () => {
    const conversations = conversationService(db);
    expect(await conversations.hasCard(conversationId, "agent_plan_proposal_v1")).toBe(false);
    await db.insert(assistantMessages).values({
      conversationId,
      role: "agent",
      content: "",
      cardKind: "agent_plan_proposal_v1",
      cardPayload: { agents: [] },
    });
    expect(await conversations.hasCard(conversationId, "agent_plan_proposal_v1")).toBe(true);
  });
});
