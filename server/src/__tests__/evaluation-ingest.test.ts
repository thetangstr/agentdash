import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  evaluationEvents,
  evaluationScorecards,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
  projects,
  verdicts,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { evaluationIngest } from "../services/evaluation/ingest.js";
import { evaluationLedger } from "../services/evaluation/ledger.js";
import { evaluationScorecardService } from "../services/evaluation/scorecards.js";
import { companyService } from "../services/companies.js";

// AgentDash: Company Evaluator — Milestone 1 integration tests against an
// embedded Postgres: ingest → append-only ledger → deterministic replay.
// Covers spec §8 rules 4, 6, 13; §11 replay agreement and immutability; the
// company-deletion purge path; and the adversarial cases from §13 that exist
// on this codebase (duplicate ingest, skewed self-report timestamps, comment
// deletion, in-window issue rewrite).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("evaluation ingest + ledger (embedded postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let otherCompanyId!: string;
  let agentId!: string;
  let projectId!: string;
  let issueId!: string;
  let commentId!: string;

  const t0 = new Date("2026-09-05T10:00:00.000Z");
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-evaluation-ingest-");
    db = createDb(tempDb.connectionString);

    const [company] = await db.insert(companies).values({ name: "Eval Co", issuePrefix: "EVL" }).returning();
    const [other] = await db.insert(companies).values({ name: "Other Co", issuePrefix: "OTH" }).returning();
    companyId = company!.id;
    otherCompanyId = other!.id;
    const [agent] = await db.insert(agents).values({ companyId, name: "Jules", role: "engineer" }).returning();
    agentId = agent!.id;
    const [project] = await db.insert(projects).values({ companyId, name: "MVL" }).returning();
    projectId = project!.id;
    const [issue] = await db
      .insert(issues)
      .values({ companyId, title: "Ship the thing", status: "done", projectId, assigneeAgentId: agentId, identifier: "EVL-1", createdAt: at(0), updatedAt: at(10) })
      .returning();
    issueId = issue!.id;

    // T0 activity: created → in_progress → in_review → done, plus an assignment change and a comment.
    await db.insert(activityLog).values([
      { companyId, actorType: "agent", actorId: agentId, action: "issue.created", entityType: "issue", entityId: issueId, agentId, details: { identifier: "EVL-1" }, createdAt: at(0) },
      { companyId, actorType: "agent", actorId: agentId, action: "issue.updated", entityType: "issue", entityId: issueId, agentId, details: { status: "in_progress", _previous: { status: "todo" }, identifier: "EVL-1" }, createdAt: at(1) },
      { companyId, actorType: "user", actorId: "local-board", action: "issue.updated", entityType: "issue", entityId: issueId, details: { assigneeAgentId: agentId, _previous: { assigneeAgentId: null }, identifier: "EVL-1" }, createdAt: at(2) },
      { companyId, actorType: "agent", actorId: agentId, action: "issue.updated", entityType: "issue", entityId: issueId, agentId, details: { status: "done", _previous: { status: "in_review" }, identifier: "EVL-1" }, createdAt: at(10) },
      { companyId, actorType: "system", actorId: "verdicts_service", action: "dod_set", entityType: "issue", entityId: issueId, details: { definitionOfDone: { criteria: [{ id: "c1", text: "works" }] } }, createdAt: at(3) },
      { companyId, actorType: "agent", actorId: agentId, action: "label.created", entityType: "label", entityId: "00000000-0000-4000-8000-000000000001", details: {}, createdAt: at(4) },
    ]);

    // T2: a PM handoff whose self-declared timestamp is 20 minutes before the comment arrived (beyond tolerance).
    const [comment] = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorUserId: "local-board",
        body:
          "**PM Handoff** (pm_to_builder)\n\n```json\n" +
          JSON.stringify({ type: "pm_to_builder", acceptance_criteria: ["a", "b"], size: "S", timestamp: at(-20).toISOString() }) +
          "\n```\n",
        createdAt: at(0),
      })
      .returning();
    commentId = comment!.id;

    // T0: a finished run on the issue, a verdict, a cost event, an interaction.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "assignment",
      exitCode: 0,
      startedAt: at(5),
      finishedAt: at(8),
      updatedAt: at(8),
      contextSnapshot: { issueId },
      usageJson: { inputTokens: 1000, outputTokens: 200 },
    });
    await db.insert(verdicts).values({ companyId, entityType: "issue", issueId, reviewerUserId: "reviewer-1", outcome: "passed", rubricScores: { correctness: 4 }, justification: "fine", createdAt: at(9) });
    await db.insert(costEvents).values({ companyId, agentId, issueId, projectId, provider: "zai", model: "glm", inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200, costCents: 3, occurredAt: at(8), createdAt: at(8) });
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions", status: "pending", createdByAgentId: agentId, payload: {}, createdAt: at(6), updatedAt: at(6) });

    // Another company's rows must never leak.
    const [otherIssue] = await db.insert(issues).values({ companyId: otherCompanyId, title: "Other", status: "todo", createdAt: at(0), updatedAt: at(0) }).returning();
    await db.insert(activityLog).values({ companyId: otherCompanyId, actorType: "user", actorId: "u", action: "issue.created", entityType: "issue", entityId: otherIssue!.id, details: {}, createdAt: at(0) });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("ingests every source into typed events, scoped to the company, and is idempotent", async () => {
    const ingest = evaluationIngest(db, { rowBudget: 100 });
    const first = await ingest.tick(companyId);
    expect(first.inserted).toBeGreaterThan(0);
    const ledger = evaluationLedger(db);
    const byType = await ledger.countByType(companyId);
    expect(byType["issue.created"]).toBe(1);
    expect(byType["issue.transition"]).toBe(2);
    expect(byType["issue.assignment_changed"]).toBe(1);
    expect(byType["issue.dod_set"]).toBe(1);
    expect(byType["activity.other"]).toBe(1); // label.created preserved, not interpreted
    expect(byType["run.finished"]).toBe(1);
    expect(byType["verdict.recorded"]).toBe(1);
    expect(byType["cost.recorded"]).toBe(1);
    expect(byType["interaction.changed"]).toBe(1);
    expect(byType["handoff.pm_to_builder"]).toBe(1);
    expect(byType["issue.snapshot"]).toBe(1);
    // Other company: nothing of ours in theirs, nothing of theirs in ours.
    const others = await ledger.countByType(otherCompanyId);
    expect(others).toEqual({});
    const second = await ingest.tick(companyId);
    expect(second.inserted).toBe(0);
    expect(second.scanned).toBe(0); // cursors advanced; nothing re-read
  });

  it("clamps a self-reported timestamp to the comment's arrival and flags it (rule 4)", async () => {
    const [ev] = await db.select().from(evaluationEvents).where(eq(evaluationEvents.eventType, "handoff.pm_to_builder"));
    expect(ev).toBeTruthy();
    // claimed 20 min earlier than arrival: kept as event time, flagged suspicious
    expect(ev!.eventTime.toISOString()).toBe(at(-20).toISOString());
    expect(ev!.payload.timestampSuspicious).toBe(true);
    expect(ev!.payload.selfReported).toBe(true);
    expect(ev!.projectId).toBe(projectId);
    expect(ev!.sourceTable).toBe("issue_comments");
  });

  it("carries scope from the issue onto activity, run, verdict and cost events", async () => {
    const rows = await db.select().from(evaluationEvents).where(eq(evaluationEvents.companyId, companyId));
    const scoped = rows.filter((r) => ["issue.transition", "run.finished", "verdict.recorded", "cost.recorded", "interaction.changed"].includes(r.eventType));
    expect(scoped.length).toBeGreaterThanOrEqual(5);
    for (const r of scoped) expect(r.projectId).toBe(projectId);
    const run = rows.find((r) => r.eventType === "run.finished")!;
    expect(run.payload.usagePresent).toBe(true);
    expect(run.payload.inputTokens).toBe(1000);
    expect(run.payload.durationMs).toBe(3 * 60_000);
  });

  it("refuses UPDATE and DELETE on the ledger unless the purge setting is on (spec §10.2)", async () => {
    const messageOf = (e: unknown) => {
      const err = e as { message?: string; cause?: { message?: string } };
      return `${err?.message ?? ""} ${err?.cause?.message ?? ""}`;
    };
    await expect(
      db.update(evaluationEvents).set({ actorId: "tampered" }).where(eq(evaluationEvents.companyId, companyId)).catch((e) => Promise.reject(new Error(messageOf(e)))),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.delete(evaluationEvents).where(eq(evaluationEvents.companyId, companyId)).catch((e) => Promise.reject(new Error(messageOf(e)))),
    ).rejects.toThrow(/append-only/);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(evaluationEvents).where(eq(evaluationEvents.companyId, companyId));
    expect(n).toBeGreaterThan(0);
  });

  it("records a new issue snapshot when the issue is rewritten, and evidence.withdrawn when a comment disappears (rule 13)", async () => {
    const ingest = evaluationIngest(db, { rowBudget: 100 });
    await db.update(issues).set({ description: "rewritten inside the ingest window", updatedAt: at(30) }).where(eq(issues.id, issueId));
    await db.delete(issueComments).where(eq(issueComments.id, commentId));
    const stats = await ingest.tick(companyId);
    expect(stats.inserted).toBe(2);
    const byType = await evaluationLedger(db).countByType(companyId);
    expect(byType["issue.snapshot"]).toBe(2);
    expect(byType["evidence.withdrawn"]).toBe(1);
    const [withdrawn] = await db.select().from(evaluationEvents).where(eq(evaluationEvents.eventType, "evidence.withdrawn"));
    expect(withdrawn!.sourceId).toBe(commentId);
    // and again: nothing new
    const again = await ingest.tick(companyId);
    expect(again.inserted).toBe(0);
  });

  it("stores a card and replays it byte-for-byte; a new event changes the next version's hash", async () => {
    const cards = evaluationScorecardService(db);
    const ref = { kind: "project" as const, id: projectId };
    const v1 = await cards.snapshot(companyId, ref, { openMilestone: true });
    expect(v1.version).toBe(1);
    const verify1 = await cards.verify(companyId, ref, 1);
    expect(verify1, JSON.stringify(verify1)).toMatchObject({ ok: true });
    // add an event and snapshot again
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: "local-board", action: "issue.updated", entityType: "issue", entityId: issueId, details: { status: "todo", _previous: { status: "done" }, reopened: true, identifier: "EVL-1" }, createdAt: at(40) });
    await evaluationIngest(db, { rowBudget: 100 }).tick(companyId);
    const v2 = await cards.snapshot(companyId, ref, { openMilestone: true });
    expect(v2.version).toBe(2);
    expect(v2.cardHash).not.toBe(v1.cardHash);
    const verify2 = await cards.verify(companyId, ref, 2);
    expect(verify2, JSON.stringify(verify2)).toMatchObject({ ok: true });
    // the old version still replays to its own hash (throughEventId pins the window)
    const verify1again = await cards.verify(companyId, ref, 1);
    expect(verify1again, JSON.stringify(verify1again)).toMatchObject({ ok: true });
    const stored = await db.select().from(evaluationScorecards).where(eq(evaluationScorecards.companyId, companyId));
    expect(stored.length).toBe(2);
  });

  it("company deletion purges the ledger through the sanctioned path", async () => {
    const [{ before }] = await db.select({ before: sql<number>`count(*)::int` }).from(evaluationEvents).where(eq(evaluationEvents.companyId, otherCompanyId));
    // give the other company one event first
    await evaluationIngest(db, { rowBudget: 100 }).tick(otherCompanyId);
    const [{ mid }] = await db.select({ mid: sql<number>`count(*)::int` }).from(evaluationEvents).where(eq(evaluationEvents.companyId, otherCompanyId));
    expect(mid).toBeGreaterThan(before);
    await companyService(db).remove(otherCompanyId);
    const [{ after }] = await db.select({ after: sql<number>`count(*)::int` }).from(evaluationEvents).where(eq(evaluationEvents.companyId, otherCompanyId));
    expect(after).toBe(0);
    // our company's ledger is untouched
    const [{ ours }] = await db.select({ ours: sql<number>`count(*)::int` }).from(evaluationEvents).where(eq(evaluationEvents.companyId, companyId));
    expect(ours).toBeGreaterThan(0);
  });
});
