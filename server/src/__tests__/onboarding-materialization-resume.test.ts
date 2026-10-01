import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { onboardingMaterializationPause } from "../services/agent-creator-from-proposal.js";

// AgentDash (#882 review P3): a plain resume of a hire whose materialization
// never completed records the takeover instead of leaving `pending`.
describe("onboarding materialization and plain resume", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("onboarding-materialization-resume-");
    db = createDb(temp.connectionString);
  });
  afterAll(async () => { await temp?.cleanup(); });

  it("marks a pending materialization resumed_incomplete and leaves completed hires alone", async () => {
    const [company] = await db.insert(companies).values({ name: "Resume", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [pending] = await db.insert(agents).values({ companyId: company.id, name: "Pending hire", ...onboardingMaterializationPause() }).returning();
    const [ordinary] = await db.insert(agents).values({ companyId: company.id, name: "Paused worker", status: "paused", pauseReason: "manual", pausedAt: new Date(), metadata: { note: "keep" } }).returning();
    const svc = agentService(db);
    await svc.resume(pending.id);
    await svc.resume(ordinary.id);
    const [afterPending] = await db.select().from(agents).where(eq(agents.id, pending.id));
    const [afterOrdinary] = await db.select().from(agents).where(eq(agents.id, ordinary.id));
    expect(afterPending.status).toBe("idle");
    expect(afterPending.metadata).toMatchObject({ onboardingMaterialization: "resumed_incomplete" });
    expect(afterOrdinary.metadata).toEqual({ note: "keep" });
  });
});
