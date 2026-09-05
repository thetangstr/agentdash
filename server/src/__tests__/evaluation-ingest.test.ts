import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  companies,
  costEvents,
  createDb,
  evaluationEvents,
  evaluationScorecards,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueThreadInteractions,
  issues,
  projects,
  verdicts,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { evaluationIngest, INGEST_LOCK_PREFIX } from "../services/evaluation/ingest.js";
import { MAX_HANDOFFS_PER_COMMENT } from "../services/evaluation/sources.js";
import { evaluationLedger } from "../services/evaluation/ledger.js";
import { MARKER_OPEN_MILESTONE } from "../services/evaluation/replay.js";
import { evaluationScorecardService } from "../services/evaluation/scorecards.js";
import { companyService } from "../services/companies.js";

// AgentDash: Company Evaluator — Milestone 1 integration tests against an
// embedded Postgres: ingest → append-only ledger → deterministic replay.
// Covers spec §8 rules 4, 6, 13; §11 replay agreement pinned by seq and
// immutability (UPDATE, DELETE); the company-deletion purge path and
// that its setting does not leak; and the adversarial cases from §13 and the
// independent review: transitions logged without `_previous`, backdated
// self-reports after a snapshot, empty milestones, reverts, comment deletion.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const messageOf = (e: unknown) => {
  const err = e as { message?: string; cause?: { message?: string } };
  return `${err?.message ?? ""} ${err?.cause?.message ?? ""}`;
};
const rejectsAppendOnly = async (p: Promise<unknown>) =>
  expect(p.catch((e) => Promise.reject(new Error(messageOf(e))))).rejects.toThrow(/append-only/);

describeEmbeddedPostgres("evaluation ingest + ledger (embedded postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let otherCompanyId!: string;
  let agentId!: string;
  let projectId!: string;
  let emptyProjectId!: string;
  let issueId!: string;
  let childIssueId!: string;
  let commentId!: string;
  const ORIGINAL_DESCRIPTION = "original description";

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
    const [project] = await db.insert(projects).values({ companyId, name: "MVL", status: "in_progress" }).returning();
    projectId = project!.id;
    const [emptyProject] = await db.insert(projects).values({ companyId, name: "Empty", status: "in_progress" }).returning();
    emptyProjectId = emptyProject!.id;
    const [issue] = await db
      .insert(issues)
      .values({ companyId, title: "Ship the thing", description: ORIGINAL_DESCRIPTION, status: "done", projectId, assigneeAgentId: agentId, identifier: "EVL-1", createdAt: at(0), updatedAt: at(10) })
      .returning();
    issueId = issue!.id;
    // A child with no project of its own inherits the parent's (spec §3 membership).
    const [child] = await db
      .insert(issues)
      .values({ companyId, title: "Child task", status: "todo", parentId: issueId, identifier: "EVL-2", createdAt: at(0), updatedAt: at(0) })
      .returning();
    childIssueId = child!.id;

    // T0 activity in the three real emitter shapes (A1): PATCH route with _previous,
    // comment-driven reopen without _previous, recovery service with previousStatus,
    // assignment change with and without _previous.
    await db.insert(activityLog).values([
      { companyId, actorType: "agent", actorId: agentId, action: "issue.created", entityType: "issue", entityId: issueId, agentId, details: { identifier: "EVL-1" }, createdAt: at(0) },
      { companyId, actorType: "agent", actorId: agentId, action: "issue.updated", entityType: "issue", entityId: issueId, agentId, details: { status: "in_progress", _previous: { status: "todo" }, identifier: "EVL-1" }, createdAt: at(1) },
      { companyId, actorType: "user", actorId: "local-board", action: "issue.updated", entityType: "issue", entityId: issueId, details: { assigneeAgentId: agentId, _previous: { assigneeAgentId: null }, identifier: "EVL-1" }, createdAt: at(2) },
      { companyId, actorType: "agent", actorId: agentId, action: "issue.updated", entityType: "issue", entityId: issueId, agentId, details: { status: "done", _previous: { status: "in_review" }, identifier: "EVL-1" }, createdAt: at(10) },
      { companyId, actorType: "user", actorId: "local-board", action: "issue.updated", entityType: "issue", entityId: issueId, details: { status: "todo", reopened: true, reopenedFrom: "done", source: "comment", identifier: "EVL-1" }, createdAt: at(11) },
      { companyId, actorType: "system", actorId: "recovery", action: "issue.updated", entityType: "issue", entityId: childIssueId, details: { status: "blocked", previousStatus: "in_progress" }, createdAt: at(12) },
      { companyId, actorType: "system", actorId: "recovery", action: "issue.updated", entityType: "issue", entityId: childIssueId, details: { assigneeAgentId: agentId }, createdAt: at(13) },
      { companyId, actorType: "system", actorId: "verdicts_service", action: "dod_set", entityType: "issue", entityId: issueId, details: { definitionOfDone: { criteria: [{ id: "c1", text: "works" }] } }, createdAt: at(3) },
      { companyId, actorType: "agent", actorId: agentId, action: "label.created", entityType: "label", entityId: "00000000-0000-4000-8000-000000000001", details: {}, createdAt: at(4) },
    ]);

    // An escalation approval linked to the issue: approval events inherit its scope (A5).
    const [approval] = await db.insert(approvals).values({ companyId, type: "verdict_escalation", status: "pending", requestedByAgentId: agentId, payload: {} }).returning();
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId: approval!.id });
    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentId, action: "approval.created", entityType: "approval", entityId: approval!.id, details: { type: "verdict_escalation" }, createdAt: at(9) });

    // T2: a PM handoff whose self-declared timestamp is 20 minutes before the comment arrived (beyond tolerance),
    // with a prose field that must be dropped.
    const [comment] = await db
      .insert(issueComments)
      .values({
        companyId,
        issueId,
        authorUserId: "local-board",
        body:
          "**PM Handoff** (pm_to_builder)\n\n```json\n" +
          JSON.stringify({ type: "pm_to_builder", acceptance_criteria: ["a", "b"], size: "S", test_plan: "long prose", timestamp: at(-20).toISOString() }) +
          "\n```\n",
        createdAt: at(0),
      })
      .returning();
    commentId = comment!.id;

    // T0: a finished run on the issue, a verdict, a cost event for the run, an interaction.
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "succeeded", invocationSource: "assignment", exitCode: 0, startedAt: at(5), finishedAt: at(8), updatedAt: at(8), contextSnapshot: { issueId }, usageJson: { inputTokens: 1000, outputTokens: 200 } })
      .returning();
    await db.insert(verdicts).values({ companyId, entityType: "issue", issueId, reviewerUserId: "reviewer-1", outcome: "passed", rubricScores: { correctness: 4 }, justification: "fine", createdAt: at(9) });
    await db.insert(costEvents).values({ companyId, agentId, issueId, projectId, heartbeatRunId: run!.id, provider: "zai", model: "glm", inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200, costCents: 3, occurredAt: at(8), createdAt: at(8) });
    await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions", status: "pending", createdByAgentId: agentId, payload: {}, createdAt: at(6), updatedAt: at(6) });

    // Another company's rows must never leak.
    const [otherIssue] = await db.insert(issues).values({ companyId: otherCompanyId, title: "Other", status: "todo", createdAt: at(0), updatedAt: at(0) }).returning();
    await db.insert(activityLog).values({ companyId: otherCompanyId, actorType: "user", actorId: "u", action: "issue.created", entityType: "issue", entityId: otherIssue!.id, details: {}, createdAt: at(0) });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("ingests every source into typed events, recognises all transition shapes, scopes by company, and is idempotent", async () => {
    const ingest = evaluationIngest(db, { rowBudget: 100 });
    const first = await ingest.tick(companyId);
    expect(first.inserted).toBeGreaterThan(0);
    expect(first.maxLagMs).toBeGreaterThan(0); // the fixtures are hours old: the lag gauge reports it
    expect(first.withdrawalChecked).toBe(true); // first tick: never checked before
    const ledger = evaluationLedger(db);
    const byType = await ledger.countByType(companyId);
    expect(byType["issue.created"]).toBe(1);
    expect(byType["issue.transition"]).toBe(4); // PATCH ×2, comment reopen, recovery block
    expect(byType["issue.assignment_changed"]).toBe(2); // with and without _previous
    expect(byType["issue.dod_set"]).toBe(1);
    expect(byType["activity.other"]).toBe(1); // label.created preserved, not interpreted
    expect(byType["approval.created"]).toBe(1);
    expect(byType["run.finished"]).toBe(1);
    expect(byType["verdict.recorded"]).toBe(1);
    expect(byType["cost.recorded"]).toBe(1);
    expect(byType["interaction.changed"]).toBe(1);
    expect(byType["handoff.pm_to_builder"]).toBe(1);
    expect(byType["issue.snapshot"]).toBe(2); // parent + child
    expect(await ledger.countByType(otherCompanyId)).toEqual({});
    const second = await ingest.tick(companyId);
    expect(second.inserted).toBe(0);
    expect(second.maxLagMs).toBeNull();
  });

  it("recognises reopen and recovery shapes without `_previous` (A1)", async () => {
    const rows = await db.select().from(evaluationEvents).where(eq(evaluationEvents.eventType, "issue.transition"));
    const reopen = rows.find((r) => r.payload.source === "comment")!;
    expect(reopen.payload).toMatchObject({ from: "done", to: "todo", reopened: true, fromUnknown: false });
    const blocked = rows.find((r) => r.payload.to === "blocked")!;
    expect(blocked.payload).toMatchObject({ from: "in_progress", reopened: false });
    // the child inherits the parent's project (spec §3)
    expect(blocked.projectId).toBe(projectId);
    const assigns = await db.select().from(evaluationEvents).where(eq(evaluationEvents.eventType, "issue.assignment_changed"));
    expect(assigns.map((a) => a.payload.previousUnknown).sort()).toEqual([false, true]);
  });

  it("clamps a self-reported timestamp, flags it, and stores only the allowlisted fields (rule 4, D4-A)", async () => {
    const [ev] = await db.select().from(evaluationEvents).where(eq(evaluationEvents.eventType, "handoff.pm_to_builder"));
    expect(ev!.eventTime.toISOString()).toBe(at(-20).toISOString());
    expect(ev!.payload.timestampSuspicious).toBe(true);
    expect(ev!.payload.selfReported).toBe(false); // author local-board is not the assignee
    expect(ev!.payload.droppedKeys).toEqual(["test_plan"]);
    expect((ev!.payload.payload as Record<string, unknown>).acceptance_criteria).toEqual(["a", "b"]);
    expect((ev!.payload.payload as Record<string, unknown>).test_plan).toBeUndefined();
    expect(ev!.projectId).toBe(projectId);
  });

  it("carries scope onto run, verdict, cost, interaction and approval events, and correlates run and cost", async () => {
    const rows = await db.select().from(evaluationEvents).where(eq(evaluationEvents.companyId, companyId));
    for (const type of ["run.finished", "verdict.recorded", "cost.recorded", "interaction.changed", "approval.created"]) {
      const r = rows.find((x) => x.eventType === type)!;
      expect(r.projectId, type).toBe(projectId);
    }
    const run = rows.find((r) => r.eventType === "run.finished")!;
    const cost = rows.find((r) => r.eventType === "cost.recorded")!;
    expect(run.correlationId).toMatch(/^run:/);
    expect(cost.correlationId).toBe(run.correlationId);
    expect(run.payload.usagePresent).toBe(true);
    expect(run.payload.durationMs).toBe(3 * 60_000);
  });

  it("mints one event per handoff payload — two same-type payloads in one comment are two facts — and caps a comment at MAX_HANDOFFS_PER_COMMENT (F2, Q5)", async () => {
    const ingest = evaluationIngest(db, { rowBudget: 100 });
    const fence = (obj: Record<string, unknown>) => "```json\n" + JSON.stringify(obj) + "\n```\n";
    await db.insert(issueComments).values([
      { companyId, issueId, authorAgentId: agentId, body: fence({ type: "builder_to_ci", pr: 1, fix_attempt: 1 }) + "retried:\n" + fence({ type: "builder_to_ci", pr: 1, fix_attempt: 2 }), createdAt: at(20) },
      { companyId, issueId, authorAgentId: agentId, body: Array.from({ length: MAX_HANDOFFS_PER_COMMENT + 2 }, (_, i) => fence({ type: "tester_to_reviewer", verdict: "pass", fix_attempt: i })).join("\n"), createdAt: at(21) },
    ]);
    await ingest.tick(companyId);
    const byType = await evaluationLedger(db).countByType(companyId);
    expect(byType["handoff.builder_to_ci"]).toBe(2);
    expect(byType["handoff.tester_to_reviewer"]).toBe(MAX_HANDOFFS_PER_COMMENT);
    const capped = await db.select().from(evaluationEvents).where(eq(evaluationEvents.eventType, "handoff.tester_to_reviewer"));
    expect(capped.map((e) => e.payload.handoffIndex as number).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(capped[0]!.payload).toMatchObject({ handoffsInComment: MAX_HANDOFFS_PER_COMMENT + 2, handoffsDropped: 2 });
    expect((await ingest.tick(companyId)).inserted).toBe(0);
  });

  it("an interaction touched without a status change is not a new fact; a status change is (F4)", async () => {
    const ingest = evaluationIngest(db, { rowBudget: 100 });
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId));
    await db.update(issueThreadInteractions).set({ updatedAt: at(22), payload: { note: "result payload rewritten" } }).where(eq(issueThreadInteractions.id, row!.id));
    await ingest.tick(companyId);
    expect((await evaluationLedger(db).countByType(companyId))["interaction.changed"]).toBe(1);
    await db.update(issueThreadInteractions).set({ status: "answered", updatedAt: at(23) }).where(eq(issueThreadInteractions.id, row!.id));
    await ingest.tick(companyId);
    const rows = await db.select().from(evaluationEvents).where(eq(evaluationEvents.eventType, "interaction.changed"));
    expect(rows.map((r) => r.payload.status).sort()).toEqual(["answered", "pending"]);
  });

  it("a terminal run without finished_at is one fact even when its row is touched again (F8)", async () => {
    const ingest = evaluationIngest(db, { rowBudget: 100 });
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "failed", invocationSource: "assignment", exitCode: 1, startedAt: at(20), finishedAt: null, updatedAt: at(24), contextSnapshot: { issueId } })
      .returning();
    await ingest.tick(companyId);
    await db.update(heartbeatRuns).set({ updatedAt: at(25) }).where(eq(heartbeatRuns.id, run!.id));
    expect((await ingest.tick(companyId)).inserted).toBe(0);
    const rows = await db.select().from(evaluationEvents).where(eq(evaluationEvents.sourceId, run!.id));
    expect(rows.length).toBe(1);
    expect(rows[0]!.sourceVersion).toBe("failed:none");
  });

  it("ticks for one company are serialised across service instances by a database lock (Q6.4)", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${INGEST_LOCK_PREFIX + companyId}, 0))`);
      await expect(evaluationIngest(db, { rowBudget: 100 }).tick(companyId)).rejects.toThrow(/already running/);
      // backfill reports the collision instead of throwing away committed passes
      expect(await evaluationIngest(db, { rowBudget: 100 }).backfill(companyId, 3)).toMatchObject({ passes: 0, lockedOut: true, exhausted: false });
    });
    // released with the holder's transaction
    expect((await evaluationIngest(db, { rowBudget: 100 }).tick(companyId)).inserted).toBe(0);
  });

  it("a dense window advances the cursor: more rows than the budget at one instant are all ingested (round 2, F2)", async () => {
    const dense = Array.from({ length: 6 }, (_, i) => ({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.touched",
      entityType: "issue",
      entityId: issueId,
      agentId,
      details: { n: i },
      createdAt: at(70),
    }));
    await db.insert(activityLog).values(dense);
    const before = (await evaluationLedger(db).countByType(companyId))["activity.other"] ?? 0;
    const ingest = evaluationIngest(db, { rowBudget: 2, sources: ["activity_log"] });
    const result = await ingest.backfill(companyId, 10);
    expect(result.exhausted).toBe(true);
    expect(result.inserted).toBe(6);
    expect((await evaluationLedger(db).countByType(companyId))["activity.other"]).toBe(before + 6);
    // a later row is still picked up after the dense page
    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentId, action: "issue.touched", entityType: "issue", entityId: issueId, agentId, details: { n: 99 }, createdAt: at(71) });
    expect((await ingest.tick(companyId)).inserted).toBe(1);
  });

  it("an issue touch that changes nothing hashed mints no snapshot (round 2, F3)", async () => {
    const ingest = evaluationIngest(db, { rowBudget: 100 });
    const before = (await evaluationLedger(db).countByType(companyId))["issue.snapshot"];
    await db.update(issues).set({ updatedAt: at(26) }).where(eq(issues.id, issueId)); // the run lifecycle does this on every claim
    const stats = await ingest.tick(companyId);
    expect(stats.perSource.issues!.scanned).toBe(1);
    expect((await evaluationLedger(db).countByType(companyId))["issue.snapshot"]).toBe(before);
  });

  it("a combined status + assignee change mints both facts from one activity row (round 2, F4)", async () => {
    const ledger = evaluationLedger(db);
    const before = await ledger.countByType(companyId);
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "local-board",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "in_review", assigneeAgentId: agentId, _previous: { status: "in_progress", assigneeAgentId: null }, identifier: "EVL-1" },
      createdAt: at(72), // after the dense window's cursor
    });
    await evaluationIngest(db, { rowBudget: 100 }).tick(companyId);
    const after = await ledger.countByType(companyId);
    expect(after["issue.transition"]).toBe((before["issue.transition"] ?? 0) + 1);
    expect(after["issue.assignment_changed"]).toBe((before["issue.assignment_changed"] ?? 0) + 1);
  });

  it("the evaluator's own audit rows never enter the ledger (rules 9/12)", async () => {
    const before = (await evaluationLedger(db).countByType(companyId))["activity.other"] ?? 0;
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: "local-board", action: "evaluation.ingest_run", entityType: "company", entityId: companyId, details: { backfill: false }, createdAt: at(73) });
    const stats = await evaluationIngest(db, { rowBudget: 100, sources: ["activity_log"] }).tick(companyId);
    expect(stats.scanned).toBe(1);
    expect((await evaluationLedger(db).countByType(companyId))["activity.other"] ?? 0).toBe(before);
  });

  it("a PATCH that echoes an unchanged assignee mints a transition but no assignment fact (round 2 verification)", async () => {
    const ledger = evaluationLedger(db);
    const before = await ledger.countByType(companyId);
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: "local-board", action: "issue.updated", entityType: "issue", entityId: issueId, details: { status: "in_progress", assigneeAgentId: agentId, _previous: { status: "in_review" }, identifier: "EVL-1" }, createdAt: at(74) });
    await evaluationIngest(db, { rowBudget: 100, sources: ["activity_log"] }).tick(companyId);
    const after = await ledger.countByType(companyId);
    expect(after["issue.transition"]).toBe((before["issue.transition"] ?? 0) + 1);
    expect(after["issue.assignment_changed"] ?? 0).toBe(before["issue.assignment_changed"] ?? 0);
  });

  it("a goal milestone's contract must carry no project, matching membership", async () => {
    const ledger = evaluationLedger(db);
    const goalA = randomUUID();
    const goalB = randomUUID();
    const strayProject = randomUUID();
    const base = { companyId, actorType: "user" as const, actorId: "local-board", sourceTable: "evaluation_contracts", eventType: "contract.declared" as const, eventTime: at(75), payload: {} };
    await ledger.append([
      { ...base, sourceId: randomUUID(), sourceVersion: "1", goalId: goalA, projectId: strayProject },
      { ...base, sourceId: randomUUID(), sourceVersion: "1", goalId: goalB, projectId: null },
    ]);
    expect(await ledger.hasContract(companyId, { kind: "goal", id: goalA })).toBe(false);
    expect(await ledger.hasContract(companyId, { kind: "goal", id: goalB })).toBe(true);
    expect(await ledger.hasContract(companyId, { kind: "project", id: strayProject })).toBe(true);
  });

  it("refuses UPDATE and DELETE on the ledger unless the purge setting is on (spec §10.2)", async () => {
    await rejectsAppendOnly(db.update(evaluationEvents).set({ actorId: "tampered" }).where(eq(evaluationEvents.companyId, companyId)));
    await rejectsAppendOnly(db.delete(evaluationEvents).where(eq(evaluationEvents.companyId, companyId)));
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(evaluationEvents).where(eq(evaluationEvents.companyId, companyId));
    expect(n).toBeGreaterThan(0);
  });

  it("records a new snapshot per rewrite including a revert, and evidence.withdrawn with scope when a comment disappears (rule 13)", async () => {
    const ingest = evaluationIngest(db, { rowBudget: 100, withdrawalCheckIntervalMs: 0 });
    await db.update(issues).set({ description: "rewritten inside the ingest window", updatedAt: at(30) }).where(eq(issues.id, issueId));
    await db.delete(issueComments).where(eq(issueComments.id, commentId));
    const stats = await ingest.tick(companyId);
    expect(stats.inserted).toBe(2);
    // revert to the original content: same hash, new version → a third snapshot (A6)
    await db.update(issues).set({ description: ORIGINAL_DESCRIPTION, updatedAt: at(35) }).where(eq(issues.id, issueId));
    expect((await ingest.tick(companyId)).inserted).toBe(1);
    const byType = await evaluationLedger(db).countByType(companyId);
    expect(byType["issue.snapshot"]).toBe(4); // parent original, child, rewrite, revert
    expect(byType["evidence.withdrawn"]).toBe(1);
    const [withdrawn] = await db.select().from(evaluationEvents).where(eq(evaluationEvents.eventType, "evidence.withdrawn"));
    expect(withdrawn!.sourceId).toBe(commentId);
    expect(withdrawn!.projectId).toBe(projectId); // A5: scope carried from the handoff event
    expect((await ingest.tick(companyId)).inserted).toBe(0);
  });

  it("stores cards pinned by seq: replay agrees across versions even after a backdated self-report arrives (A2)", async () => {
    const cards = evaluationScorecardService(db);
    const ingest = evaluationIngest(db, { rowBudget: 100 });
    const ref = { kind: "project" as const, id: projectId };
    const v1 = await cards.snapshot(companyId, ref);
    expect(v1.version).toBe(1);
    expect(v1.contractVersion).toBe("none"); // no contract.declared event exists
    expect((v1.card as { markers: string[] }).markers).toEqual([MARKER_OPEN_MILESTONE]); // project in_progress; derived, not supplied
    expect(await cards.verify(companyId, ref, 1)).toMatchObject({ ok: true });
    // An ordinary comment with a payload timestamp in 2020 arrives after the snapshot.
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "```json\n" + JSON.stringify({ type: "tpm_merge_report", pr: 1, merge_result: "merged", timestamp: "2020-01-01T00:00:00.000Z" }) + "\n```",
      createdAt: at(40),
    });
    expect((await ingest.tick(companyId)).inserted).toBe(1);
    // v1 still replays to its own hash: the window is seq-bound, not time-bound.
    expect(await cards.verify(companyId, ref, 1)).toMatchObject({ ok: true });
    const v2 = await cards.snapshot(companyId, ref);
    expect(v2.version).toBe(2);
    expect(v2.cardHash).not.toBe(v1.cardHash);
    expect(Number(v2.throughSeq)).toBeGreaterThan(Number(v1.throughSeq));
    expect(await cards.verify(companyId, ref, 2)).toMatchObject({ ok: true });
    expect((await db.select().from(evaluationScorecards).where(eq(evaluationScorecards.companyId, companyId))).length).toBe(2);
  });

  it("snapshots an empty milestone and keeps verifying it after later ingests (A3)", async () => {
    const cards = evaluationScorecardService(db);
    const ref = { kind: "project" as const, id: emptyProjectId };
    const v1 = await cards.snapshot(companyId, ref);
    expect((v1.card as { eventCount: number }).eventCount).toBe(0);
    expect(v1.throughEventId).toBeNull();
    await db.insert(activityLog).values({ companyId, actorType: "user", actorId: "local-board", action: "issue.updated", entityType: "issue", entityId: issueId, details: { status: "in_progress", _previous: { status: "todo" }, identifier: "EVL-1" }, createdAt: at(50) });
    await evaluationIngest(db, { rowBudget: 100 }).tick(companyId);
    expect(await cards.verify(companyId, ref, 1)).toMatchObject({ ok: true });
  });

  it("a stored card keeps verifying after its project closes: the open flag is pinned in the card (round 2, F1)", async () => {
    const cards = evaluationScorecardService(db);
    const ref = { kind: "project" as const, id: projectId };
    const open = await cards.snapshot(companyId, ref);
    expect((open.card as { state: { open: boolean } }).state.open).toBe(true);
    await db.update(projects).set({ status: "completed", updatedAt: at(80) }).where(eq(projects.id, projectId));
    expect(await cards.verify(companyId, ref, open.version)).toMatchObject({ ok: true, pinnedOpen: true });
    const closed = await cards.snapshot(companyId, ref);
    expect((closed.card as { markers: string[] }).markers).not.toContain(MARKER_OPEN_MILESTONE);
    expect(closed.cardHash).not.toBe(open.cardHash);
    expect(await cards.verify(companyId, ref, closed.version)).toMatchObject({ ok: true, pinnedOpen: false });
    await db.update(projects).set({ status: "in_progress", updatedAt: at(81) }).where(eq(projects.id, projectId));
  });

  it("withdrawal detection runs on its own cadence, not every tick (Q6.2)", async () => {
    const [late] = await db.select().from(issueComments).where(and(eq(issueComments.companyId, companyId), sql`${issueComments.body} LIKE '%tpm_merge_report%'`));
    await db.delete(issueComments).where(eq(issueComments.id, late!.id));
    const before = (await evaluationLedger(db).countByType(companyId))["evidence.withdrawn"] ?? 0;
    const gated = await evaluationIngest(db, { rowBudget: 100 }).tick(companyId); // default cadence: last check was seconds ago
    expect(gated.withdrawalChecked).toBe(false);
    expect((await evaluationLedger(db).countByType(companyId))["evidence.withdrawn"] ?? 0).toBe(before);
    const due = await evaluationIngest(db, { rowBudget: 100, withdrawalCheckIntervalMs: 0 }).tick(companyId);
    expect(due.withdrawalChecked).toBe(true);
    expect((await evaluationLedger(db).countByType(companyId))["evidence.withdrawn"] ?? 0).toBe(before + 1);
  });

  it("company deletion purges the ledger through the sanctioned path, and the setting does not leak", async () => {
    await evaluationIngest(db, { rowBudget: 100 }).tick(otherCompanyId);
    const [{ mid }] = await db.select({ mid: sql<number>`count(*)::int` }).from(evaluationEvents).where(eq(evaluationEvents.companyId, otherCompanyId));
    expect(mid).toBeGreaterThan(0);
    await companyService(db).remove(otherCompanyId);
    const [{ after }] = await db.select({ after: sql<number>`count(*)::int` }).from(evaluationEvents).where(eq(evaluationEvents.companyId, otherCompanyId));
    expect(after).toBe(0);
    // our ledger is untouched, and a delete outside the deletion transaction is still refused
    const [{ ours }] = await db.select({ ours: sql<number>`count(*)::int` }).from(evaluationEvents).where(eq(evaluationEvents.companyId, companyId));
    expect(ours).toBeGreaterThan(0);
    await rejectsAppendOnly(db.delete(evaluationEvents).where(eq(evaluationEvents.companyId, companyId)));
  });
});
