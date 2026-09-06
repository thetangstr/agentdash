import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, createDb, evaluationScorecards, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { evaluationSnapshotCadence } from "../services/evaluation/schedule.js";
import { evaluationOverview } from "../services/evaluation/overview.js";
import { evaluationShadowReport } from "../services/evaluation/shadow-report.js";
import { evaluationLedger } from "../services/evaluation/ledger.js";

// AgentDash: Company Evaluator — Milestone 3 shadow cadence: every open project of
// every company that provisioned an evaluator principal gets a stored card and
// its review items on each pass; companies that did not opt in are never
// touched; closed projects are left alone; an unchanged card adds no version.

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
    await db.insert(agents).values({ companyId, name: "Evaluator", role: "evaluator", status: "idle" }); // the opt-in
    const [open] = await db.insert(projects).values({ companyId, name: "Open", status: "in_progress" }).returning();
    openId = open!.id;
    await db.insert(projects).values({ companyId, name: "Closed", status: "completed" });
    // a second company with an open project but no evaluator principal: the cadence must never touch it
    const [other] = await db.insert(companies).values({ name: "Opted Out Co", issuePrefix: "OUT" }).returning();
    await db.insert(projects).values({ companyId: other!.id, name: "Open elsewhere", status: "in_progress" });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("stores one card per open project of a provisioned company and syncs its review items; an unchanged card adds no version", async () => {
    const cadence = evaluationSnapshotCadence(db);
    const first = await cadence.run();
    expect(first).toMatchObject({ companies: 1, milestones: 1, cards: 1, failures: [] }); // the opted-out company is not visited
    const stored = await db.select().from(evaluationScorecards).where(eq(evaluationScorecards.companyId, companyId));
    expect(stored.map((s) => s.milestoneId)).toEqual([openId]);
    expect((await db.select().from(evaluationScorecards)).length).toBe(1);
    const second = await cadence.run();
    expect(second.cards).toBe(1);
    expect(second.reviewItemsCreated).toBe(0);
    expect((await db.select().from(evaluationScorecards).where(eq(evaluationScorecards.companyId, companyId))).length).toBe(1);
    // an empty milestone raises no exceptions: no review item, and the review-items project is not even created
    expect((await db.select().from(issues).where(eq(issues.companyId, companyId))).length).toBe(0);
    expect((await db.select().from(projects).where(eq(projects.companyId, companyId))).length).toBe(2);
    // the evaluator's own review-items project, once it exists, is never a scored milestone (rule 12)
    await db.insert(projects).values({ companyId, name: "Evaluator review items", status: "in_progress" });
    const third = await cadence.run();
    expect(third).toMatchObject({ milestones: 1, cards: 1 });
  });

  it("the overview lists every milestone with what its latest card says, never the review-items project, and knows the principal", async () => {
    const overview = await evaluationOverview(db).get(companyId);
    expect(overview.principal.provisioned).toBe(true);
    expect(overview.reviewProjectId).not.toBeNull();
    const names = overview.milestones.map((m) => m.name);
    expect(names).toContain("Open");
    expect(names).toContain("Closed"); // a closed project keeps its cards visible
    expect(names).not.toContain("Evaluator review items");
    const open = overview.milestones.find((m) => m.name === "Open")!;
    expect(open.latest?.version).toBe(1); // one version: the unchanged card added none
    expect(open.latest?.trend.length).toBe(1);
    expect(open.latest?.exceptions.total).toBe(0);
    expect(overview.milestones.find((m) => m.name === "Closed")!.latest).toBeNull();
    const versions = await evaluationOverview(db).versions(companyId, { kind: "project", id: openId });
    expect(versions.map((v) => v.version)).toEqual([1]);
    expect(versions[0]!.cardHash).toHaveLength(64);
  });

  it("the shadow report measures each graduation criterion from stored cards and human dispositions, and says what it cannot measure", async () => {
    // a human records a rescue on the open milestone (as the dispositions route would)
    await evaluationLedger(db).append([{
      companyId,
      projectId: openId,
      goalId: null,
      actorType: "user",
      actorId: "admin-1",
      sourceTable: "evaluation_dispositions",
      sourceId: "note:rescue:test",
      sourceVersion: "v1",
      eventType: "evaluation.disposition",
      eventTime: new Date(),
      payload: { kind: "shadow_note", milestoneRef: { kind: "project", id: openId }, topic: "rescue", text: "founder merged by hand", decidedBy: "admin-1" },
      correlationId: null,
    }]);
    const report = await evaluationShadowReport(db).get(companyId, [{ kind: "project", id: openId }]);
    expect(report.evaluator.provisioned).toBe(true);
    expect(report.evaluator.refusedRequests).toBe(0);
    const m = report.milestones[0]!;
    expect(m.name).toBe("Open");
    expect(m.versions).toBe(1);
    expect(m.replay).toMatchObject({ agree: 1, disagree: 0, formulaChanged: 0, agreementRate: 1 });
    expect(m.exceptions.total).toBe(0);
    expect(m.reviews).toMatchObject({ confirmed: 0, falsePositive: 0, missed: 0, precision: null, recall: null });
    expect(m.notes.rescue).toEqual(["founder merged by hand"]);
    const by = Object.fromEntries(report.graduation.map((g) => [g.key, g]));
    expect(by.replay_agreement!.status).toBe("met");
    expect(by.no_authority_mutation!.status).toBe("met");
    expect(by.material_claims_traced!.status).toBe("not_measurable"); // no material claims on an empty milestone
    expect(by.precision_recall!.status).toBe("not_measurable");
    expect(by.precision_recall!.measured).toContain("no exception reviews recorded yet");
    expect(by.chatter_ceiling!.status).toBe("met");
    expect(by.cost_reported!.status).toBe("not_measurable"); // no cap supplied
    expect(by.no_rescues!.status).toBe("not_measurable"); // one milestone named, still open
    expect(by.no_rescues!.measured).toContain("rescues recorded: 1");
    const capped = await evaluationShadowReport(db).get(companyId, [{ kind: "project", id: openId }], { costCapCents: 100 });
    expect(Object.fromEntries(capped.graduation.map((g) => [g.key, g.status])).cost_reported).toBe("met"); // no evaluator runs yet: $0.00 against $1.00
  });
});
