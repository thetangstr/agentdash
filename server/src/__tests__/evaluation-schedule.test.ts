import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, companyMemberships, createDb, evaluationScorecards, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { evaluationSnapshotCadence } from "../services/evaluation/schedule.js";

// AgentDash: Company Evaluator — Milestone 3 shadow cadence: every open project of
// every company gets a stored card and its review items on each pass; closed
// projects are left alone; a failing milestone never stops the loop.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("evaluation snapshot cadence (embedded postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let openId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-evaluation-cadence-");
    db = createDb(tempDb.connectionString);
    const [company] = await db.insert(companies).values({ name: "Cadence Co", issuePrefix: "CDN" }).returning();
    companyId = company!.id;
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "admin-1", membershipRole: "admin", status: "active" });
    const [open] = await db.insert(projects).values({ companyId, name: "Open", status: "in_progress" }).returning();
    openId = open!.id;
    await db.insert(projects).values({ companyId, name: "Closed", status: "completed" });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("stores one card per open project and syncs its review items; a second pass adds a version and changes no items", async () => {
    const cadence = evaluationSnapshotCadence(db);
    const first = await cadence.run();
    expect(first).toMatchObject({ companies: 1, milestones: 1, cards: 1, failures: [] });
    const stored = await db.select().from(evaluationScorecards).where(eq(evaluationScorecards.companyId, companyId));
    expect(stored.map((s) => s.milestoneId)).toEqual([openId]);
    const second = await cadence.run();
    expect(second.cards).toBe(1);
    expect(second.reviewItemsCreated).toBe(0);
    expect((await db.select().from(evaluationScorecards).where(eq(evaluationScorecards.companyId, companyId))).length).toBe(2);
    // an empty milestone raises no exceptions: no review item, and the review-items project is not even created
    expect((await db.select().from(issues).where(eq(issues.companyId, companyId))).length).toBe(0);
    expect((await db.select().from(projects).where(eq(projects.companyId, companyId))).length).toBe(2);
    // the evaluator's own review-items project, once it exists, is never a scored milestone (rule 12)
    await db.insert(projects).values({ companyId, name: "Evaluator review items", status: "in_progress" });
    const third = await cadence.run();
    expect(third).toMatchObject({ milestones: 1, cards: 1 });
  });
});
