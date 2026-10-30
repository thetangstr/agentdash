import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentCorrections,
  agentProfileApplications,
  agentProfileRevisions,
  agentStewardships,
  createDb,
  deliverableRuns,
  deliverables,
  evaluationEvents,
  goals,
  heartbeatRuns,
  issueExecutionDecisions,
  issueResponsibilities,
  issues,
  projectAccess,
  projects,
  routineRunOccurrences,
  routineRuns,
  routineTriggers,
} from "@paperclipai/db";
import { profileBodyHash } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany, addUser, agentRequestActor, boardActor, type TestDb } from "./helpers/agent-profile-fixtures.js";
import { profileBody, responsibility, seedActiveProfile } from "./helpers/responsibility-fixtures.js";
import { errorHandler } from "../middleware/index.js";
import { evaluationRoutes } from "../routes/evaluation.js";
import { resolveEvaluationViewer, viewerClassCondition, viewerClassFilter } from "../services/evaluation/access-class.js";
import { evaluationIngest } from "../services/evaluation/ingest.js";
import { evaluationLedger, type EvaluationEventRow } from "../services/evaluation/ledger.js";
import { routineService } from "../services/routines.js";

// AgentDash: Agent Performance Management gate 3 (P3.2) — ingest of the
// agent-side sources, access classes assigned at ingest, the subject hint,
// the checkout fix and the snapshot additions; the events API filtering by
// class before it returns anything (over HTTP, real viewer resolution); and
// routine dispatch recording the scheduled occurrence on schedule runs only.
// Embedded Postgres with every migration; nothing in the evaluator is mocked.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const ACTOR_HEADER = "x-gate3-actor";

describeEmbeddedPostgres("APM gate 3 ingest, access classes and the events API (embedded postgres)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const actors = new Map<string, Record<string, unknown>>();
  let app!: express.Express;

  let companyId = "";
  let ownerId = "";
  let stewardId = "";
  let accountableId = "";
  let representedId = "";
  let outsiderId = "";
  let insiderId = "";
  let analystId = "";
  let soloId = "";
  let openProjectId = "";
  let restrictedProjectId = "";
  let goalId = "";
  let openIssueId = "";
  let restrictedIssueId = "";
  let receiptId = "";
  let soloReceiptId = "";
  let correctionId = "";
  let mappingId = "";
  let draftRevisionId = "";
  let appliedRevisionId = "";
  let applicationId = "";
  let legacyRestrictedEventId = "";
  const t = (minutes: number) => new Date(Date.UTC(2026, 9, 28, 9, 0, 0) + minutes * 60_000);

  async function all(): Promise<EvaluationEventRow[]> {
    return db.select().from(evaluationEvents).where(eq(evaluationEvents.companyId, companyId));
  }
  const ofType = (rows: EvaluationEventRow[], type: string) => rows.filter((r) => r.eventType === type);
  const as = (actor: string) => ({ [ACTOR_HEADER]: actor });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-evaluation-gate3-ingest-");
    db = createDb(tempDb.connectionString);

    const company = await addCompany(db, "Gate3", "default");
    companyId = company.id;
    ownerId = await addUser(db, companyId, "owner");
    stewardId = await addUser(db, companyId, "member");
    accountableId = await addUser(db, companyId, "member");
    representedId = await addUser(db, companyId, "member");
    outsiderId = await addUser(db, companyId, "member");
    insiderId = await addUser(db, companyId, "member");
    const analyst = await addAgent(db, companyId, { name: "Analyst", adapterType: "claude_local", adapterConfig: { model: "claude-opus-x", env: { SECRET: "do-not-copy" } } });
    analystId = analyst.id;
    const solo = await addAgent(db, companyId, { name: "Solo", autonomy: "autonomous", accountableUserId: accountableId });
    soloId = solo.id;
    await db.insert(agentStewardships).values({ companyId, agentId: analystId, userId: stewardId, assignedByUserId: ownerId });

    const [open] = await db.insert(projects).values({ companyId, name: "Open", status: "in_progress" }).returning();
    openProjectId = open!.id;
    const [restricted] = await db.insert(projects).values({ companyId, name: "Secret", status: "in_progress", visibility: "restricted", createdByUserId: ownerId }).returning();
    restrictedProjectId = restricted!.id;
    await db.insert(projectAccess).values({ projectId: restrictedProjectId, principalType: "user", principalId: insiderId, grantedByUserId: ownerId });
    const [goal] = await db
      .insert(goals)
      .values({ companyId, title: "Pipeline", status: "active", ownerAgentId: analystId, metricDefinition: { target: 10, unit: "deals", source: "crm", currentValue: 7, lastUpdatedAt: "2026-10-27T12:00:00.000Z" } })
      .returning();
    goalId = goal!.id;
    const [openIssue] = await db.insert(issues).values({ companyId, title: "Open work", status: "todo", projectId: openProjectId, goalId, assigneeAgentId: analystId, identifier: "G3-1" }).returning();
    openIssueId = openIssue!.id;
    const [restrictedIssue] = await db.insert(issues).values({ companyId, title: "Secret work", status: "todo", projectId: restrictedProjectId, assigneeAgentId: analystId, identifier: "G3-2" }).returning();
    restrictedIssueId = restrictedIssue!.id;

    // A pre-gate-3 ledger row of the restricted project: stored as `company` (backfill never rewrites).
    const legacy = await evaluationLedger(db).append([
      { companyId, projectId: restrictedProjectId, actorType: "system", sourceTable: "legacy", sourceId: "legacy-1", sourceVersion: "1", eventType: "activity.other", eventTime: t(-60), payload: { action: "legacy.row" } },
    ]);
    legacyRestrictedEventId = legacy.insertedIds[0]!;

    await db.insert(activityLog).values([
      // the checkout row records only the agent (routes/issues.ts)
      { companyId, actorType: "agent", actorId: analystId, agentId: analystId, action: "issue.checked_out", entityType: "issue", entityId: openIssueId, details: { agentId: analystId }, createdAt: t(1) },
      // a shadow would-be refusal about work in the restricted project
      { companyId, actorType: "agent", actorId: analystId, agentId: analystId, action: "access.would_refuse", entityType: "agent", entityId: analystId, details: { dimension: "see.projects", rule: "outside_scope", reason: "not in scope", target: restrictedProjectId, site: "issues.read", allowedSummary: "Open", policyMode: "shadow", issueId: restrictedIssueId }, createdAt: t(2) },
      { companyId, actorType: "user", actorId: ownerId, agentId: analystId, action: "access.policy_changed", entityType: "agent", entityId: analystId, details: { source: "admin_ceiling_edit", target: "owner_ceiling", channel: "settings", changed: ["see.projects"], fromRevision: 1, toRevision: 2 }, createdAt: t(3) },
    ]);

    const [receipt] = await db
      .insert(agentCorrections)
      .values({
        companyId,
        agentId: analystId,
        issueId: openIssueId,
        kind: "harness_evaluation",
        summary: "Private feedback for the analyst: quoted text from a person.",
        details: {
          representedUserId: representedId,
          outcome: "unable_to_verify",
          reviewedVersion: "rv-1",
          checks: [
            { criterionId: "c1", criterion: "Delivered", outcome: "pass", evidence: ["doc#1"] },
            { criterion: "Clear wording", outcome: "unknown", evidence: [] },
          ],
          learning: { workflow: "weekly-report", lessons: ["Lead with the number"] },
        },
        sourceActorType: "harness",
        sourceActorId: "endpoint-1",
        createdAt: t(4),
      })
      .returning();
    receiptId = receipt!.id;
    const [soloReceipt] = await db
      .insert(agentCorrections)
      .values({ companyId, agentId: soloId, kind: "harness_evaluation", summary: "solo", details: { representedUserId: accountableId, outcome: "accepted", checks: [] }, sourceActorType: "harness", sourceActorId: "endpoint-2", createdAt: t(4) })
      .returning();
    soloReceiptId = soloReceipt!.id;
    const [correction] = await db
      .insert(agentCorrections)
      .values({ companyId, agentId: analystId, issueId: openIssueId, kind: "steward_send_back", summary: "Please redo the totals", details: { lessons: ["check totals", "cite sources"] }, sourceActorType: "user", sourceActorId: stewardId, createdAt: t(5) })
      .returning();
    correctionId = correction!.id;

    const [deliverable] = await db
      .insert(deliverables)
      .values({ companyId, key: "weekly", name: "Weekly report", cadence: "weekly", assemblerAgentId: analystId, firstApproverUserId: ownerId, secondApproverUserId: stewardId })
      .returning();
    await db.insert(deliverableRuns).values({ companyId, deliverableId: deliverable!.id, runKey: "2026-W44", status: "collecting", openedAt: t(6) });

    const { revisionId } = await seedActiveProfile(db, { companyId, agentId: analystId, body: profileBody([responsibility("weekly-report", { obligation: { kind: "deliverable", deliverableId: deliverable!.id } })]) });
    appliedRevisionId = revisionId;
    const profileRow = await db.select({ profileId: agentProfileRevisions.profileId }).from(agentProfileRevisions).where(eq(agentProfileRevisions.id, revisionId)).then((r) => r[0]!);
    const draftBody = profileBody([responsibility("draft-only")]);
    const [draft] = await db
      .insert(agentProfileRevisions)
      .values({ companyId, profileId: profileRow.profileId, revisionNumber: 2, state: "draft", body: draftBody, bodyHash: profileBodyHash(draftBody) })
      .returning();
    draftRevisionId = draft!.id;
    const [application] = await db.insert(agentProfileApplications).values({ companyId, agentId: analystId, revisionId, status: "applied", approverUserId: ownerId }).returning();
    applicationId = application!.id;

    const [mapping] = await db
      .insert(issueResponsibilities)
      .values({ companyId, issueId: openIssueId, agentId: analystId, responsibilityKey: "weekly-report", profileRevisionId: revisionId, mappedBy: "agent", mappedByActorId: analystId, validFrom: t(7) })
      .returning();
    mappingId = mapping!.id;
    await db.insert(issueExecutionDecisions).values({ companyId, issueId: openIssueId, stageId: randomUUID(), stageType: "review", actorUserId: ownerId, outcome: "approved", body: "Looks right." });

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const key = req.header(ACTOR_HEADER) ?? "owner";
      (req as unknown as { actor: Record<string, unknown> }).actor = actors.get(key) ?? { type: "none" };
      next();
    });
    app.use("/api", evaluationRoutes(db as never));
    app.use(errorHandler);
    actors.set("owner", boardActor(companyId, ownerId, "owner"));
    actors.set("steward", boardActor(companyId, stewardId));
    actors.set("accountable", boardActor(companyId, accountableId));
    actors.set("represented", boardActor(companyId, representedId));
    actors.set("outsider", boardActor(companyId, outsiderId));
    actors.set("insider", boardActor(companyId, insiderId));
    actors.set("agent", agentRequestActor({ id: analystId, companyId }));

    await evaluationIngest(db).backfill(companyId);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("every new source lands with its own event type", async () => {
    const rows = await all();
    const types = new Set(rows.map((r) => r.eventType));
    for (const type of [
      "assessment.automated",
      "correction.recorded",
      "deliverable.run_changed",
      "responsibility.interval",
      "profile.revision_changed",
      "profile.application_changed",
      "issue.execution_decision",
      "access.would_refuse",
      "access.policy_changed",
    ]) {
      expect(types.has(type), type).toBe(true);
    }
    // a draft revision says nothing in force: not minted
    expect(ofType(rows, "profile.revision_changed").map((r) => r.sourceId)).toEqual([appliedRevisionId]);
    expect(rows.some((r) => r.sourceId === draftRevisionId)).toBe(false);
    const revision = ofType(rows, "profile.revision_changed")[0]!;
    expect(revision.payload).toMatchObject({ agentId: analystId, state: "applied", responsibilities: [expect.objectContaining({ key: "weekly-report", obligation: expect.objectContaining({ kind: "deliverable" }) })] });
    expect(JSON.stringify(revision.payload)).not.toContain("The weekly-report outcome"); // profile prose stays in the profile
    expect(ofType(rows, "profile.application_changed")[0]!.payload).toMatchObject({ applicationId, agentId: analystId, revisionId: appliedRevisionId, status: "applied" });
    expect(ofType(rows, "deliverable.run_changed")[0]!.payload).toMatchObject({ runKey: "2026-W44", status: "collecting", assemblerAgentId: analystId, shippedAt: null, checkPassed: null });
    const decision = ofType(rows, "issue.execution_decision")[0]!;
    expect(decision.payload).toMatchObject({ issueId: openIssueId, stageType: "review", outcome: "approved", bodyLength: "Looks right.".length });
    expect(decision.projectId).toBe(openProjectId);
  });

  it("harness receipts are private_pairing and human corrections private_agent; prose is not copied", async () => {
    const rows = await all();
    const [assessment, soloAssessment] = [receiptId, soloReceiptId].map((id) => ofType(rows, "assessment.automated").find((r) => r.sourceId === id)!);
    expect(assessment!.accessClass).toBe(`private_pairing:${receiptId}`);
    expect(soloAssessment!.accessClass).toBe(`private_pairing:${soloReceiptId}`);
    expect(assessment!.payload).toMatchObject({
      receiptId,
      pairedAgentId: analystId,
      representedUserId: representedId,
      outcome: "unable_to_verify",
      reviewedVersion: "rv-1",
      workflow: "weekly-report",
      checkCount: 2,
      boundChecks: 1,
      lessonCount: 1,
    });
    expect((assessment!.payload as { checks: unknown[] }).checks).toEqual([
      { criterionId: "c1", criterion: "Delivered", outcome: "pass", evidenceCount: 1 },
      { criterionId: null, criterion: "Clear wording", outcome: "unknown", evidenceCount: 0 },
    ]);
    expect(assessment!.actorType).toBe("system"); // the harness endpoint, never presented as a person
    expect(assessment!.subjectAgentId).toBe(analystId);
    const correction = ofType(rows, "correction.recorded").find((r) => r.sourceId === correctionId)!;
    expect(correction.accessClass).toBe(`private_agent:${analystId}`);
    expect(correction).toMatchObject({ actorType: "user", actorId: stewardId, subjectAgentId: analystId });
    expect(correction.payload).toMatchObject({ kind: "steward_send_back", lessonCount: 2, summaryLength: "Please redo the totals".length });
    for (const r of [assessment!, correction]) expect(JSON.stringify(r.payload)).not.toMatch(/quoted text|redo the totals|Lead with/);
  });

  it("restricted-project events get project:<id>; open-project and company-wide events stay company", async () => {
    const rows = await all();
    const restrictedSnapshot = ofType(rows, "issue.snapshot").find((r) => r.sourceId === restrictedIssueId)!;
    expect(restrictedSnapshot.accessClass).toBe(`project:${restrictedProjectId}`);
    expect(ofType(rows, "project.snapshot").find((r) => r.sourceId === restrictedProjectId)!.accessClass).toBe(`project:${restrictedProjectId}`);
    const wouldRefuse = ofType(rows, "access.would_refuse")[0]!;
    expect(wouldRefuse).toMatchObject({ accessClass: `project:${restrictedProjectId}`, projectId: restrictedProjectId, subjectAgentId: analystId });
    expect(wouldRefuse.payload).toMatchObject({ agentId: analystId, issueId: restrictedIssueId, dimension: "see.projects", rule: "outside_scope", site: "issues.read" });
    expect(wouldRefuse.payload).not.toHaveProperty("allowedSummary");
    expect(ofType(rows, "issue.snapshot").find((r) => r.sourceId === openIssueId)!.accessClass).toBe("company");
    expect(ofType(rows, "goal.snapshot")[0]!.accessClass).toBe("company");
    // history is not rewritten
    expect(rows.find((r) => r.id === legacyRestrictedEventId)!.accessClass).toBe("company");
  });

  it("checkout becomes an assignment plus a transition; snapshots carry the goal measurement and the agent's runtime", async () => {
    const rows = await all();
    const fromCheckout = rows.filter((r) => r.sourceTable === "activity_log" && r.payload && (r.payload as { source?: string }).source === "checkout");
    expect(fromCheckout.map((r) => r.eventType).sort()).toEqual(["issue.assignment_changed", "issue.transition"]);
    expect(fromCheckout.find((r) => r.eventType === "issue.transition")!.payload).toMatchObject({ issueId: openIssueId, from: null, fromUnknown: true, to: "in_progress" });
    expect(fromCheckout.find((r) => r.eventType === "issue.assignment_changed")!.payload).toMatchObject({ toAgentId: analystId, previousUnknown: true });
    expect(new Set(fromCheckout.map((r) => r.sourceId)).size).toBe(1); // one activity row, two facts
    expect(fromCheckout.every((r) => r.subjectAgentId === analystId)).toBe(true);
    expect(rows.some((r) => r.eventType === "activity.other" && (r.payload as { action?: string }).action === "issue.checked_out")).toBe(false);

    const goal = ofType(rows, "goal.snapshot")[0]!;
    expect(goal.payload).toMatchObject({ currentValue: 7, lastUpdatedAt: "2026-10-27T12:00:00.000Z" });
    expect(goal.subjectAgentId).toBe(analystId);
    const agent = ofType(rows, "agent.snapshot").find((r) => r.sourceId === analystId)!;
    expect(agent.payload).toMatchObject({ adapterType: "claude_local", model: "claude-opus-x" });
    expect(JSON.stringify(agent.payload)).not.toContain("do-not-copy");
    expect(ofType(rows, "agent.snapshot").find((r) => r.sourceId === soloId)!.payload).toMatchObject({ adapterType: "process", model: null });
    expect(agent.subjectAgentId).toBe(analystId);
  });

  it("responsibility intervals: one event when opened, one when closed; re-ingest is a no-op", async () => {
    const before = ofType(await all(), "responsibility.interval");
    expect(before.map((r) => r.sourceVersion)).toEqual(["open"]);
    expect(before[0]!.payload).toMatchObject({ mappingId, issueId: openIssueId, agentId: analystId, responsibilityKey: "weekly-report", validTo: null, mappedBy: "agent" });
    expect(before[0]).toMatchObject({ actorType: "agent", actorId: analystId, subjectAgentId: analystId, projectId: openProjectId });
    const closedAt = new Date();
    await db.update(issueResponsibilities).set({ validTo: closedAt }).where(eq(issueResponsibilities.id, mappingId));
    const tick = await evaluationIngest(db).tick(companyId);
    expect(tick.perSource.issue_responsibilities!.inserted).toBe(1);
    const after = ofType(await all(), "responsibility.interval");
    expect(after.map((r) => r.sourceVersion).sort()).toEqual([`closed:${closedAt.toISOString()}`, "open"]);
    const again = await evaluationIngest(db).tick(companyId);
    expect(again.inserted).toBe(0);
  });

  it("events API: a member off the restricted project's access list sees no restricted event, old or new; an admin and an insider do", async () => {
    const restrictedIds = new Set((await all()).filter((r) => r.projectId === restrictedProjectId || r.accessClass === `project:${restrictedProjectId}`).map((r) => r.id));
    expect(restrictedIds.size).toBeGreaterThanOrEqual(4); // the legacy row, issue + project snapshots, the would-be refusal
    expect(restrictedIds.has(legacyRestrictedEventId)).toBe(true);
    for (const viewer of ["steward", "outsider", "represented", "agent"]) {
      const res = await request(app).get(`/api/companies/${companyId}/evaluation/events?limit=5000`).set(as(viewer));
      expect(res.status, viewer).toBe(200);
      const ids = res.body.events.map((e: { id: string }) => e.id) as string[];
      expect(ids.filter((id) => restrictedIds.has(id)), viewer).toEqual([]);
      expect(res.body.count).toBe(ids.length);
      expect((await request(app).get(`/api/companies/${companyId}/evaluation/events/${legacyRestrictedEventId}`).set(as(viewer))).status, viewer).toBe(404);
    }
    for (const viewer of ["owner", "insider"]) {
      const res = await request(app).get(`/api/companies/${companyId}/evaluation/events?limit=5000`).set(as(viewer));
      const ids = new Set(res.body.events.map((e: { id: string }) => e.id) as string[]);
      expect([...restrictedIds].every((id) => ids.has(id)), viewer).toBe(true);
      expect((await request(app).get(`/api/companies/${companyId}/evaluation/events/${legacyRestrictedEventId}`).set(as(viewer))).status, viewer).toBe(200);
    }
  });

  it("events API: private_pairing reaches only the represented person, the paired agent's steward and accountable user, and admins; private_agent only the steward, accountable user and admins", async () => {
    const rows = await all();
    const analystReceipt = rows.find((r) => r.accessClass === `private_pairing:${receiptId}`)!;
    const soloReceipt = rows.find((r) => r.accessClass === `private_pairing:${soloReceiptId}`)!;
    const correction = rows.find((r) => r.accessClass === `private_agent:${analystId}`)!;
    const visible = async (viewer: string) => {
      const res = await request(app).get(`/api/companies/${companyId}/evaluation/events?limit=5000`).set(as(viewer));
      expect(res.status).toBe(200);
      return new Set(res.body.events.map((e: { id: string }) => e.id) as string[]);
    };
    const expectations: Record<string, [boolean, boolean, boolean]> = {
      // viewer: [analyst receipt, solo receipt, analyst correction]
      owner: [true, true, true],
      steward: [true, false, true], // steward of the paired analyst
      represented: [true, false, false], // the represented person of the analyst receipt only
      accountable: [false, true, false], // accountable for Solo, represented on Solo's receipt
      outsider: [false, false, false],
      insider: [false, false, false],
      agent: [false, false, false], // agent principals never read a private class, not even their own
    };
    for (const [viewer, [analystSees, soloSees, correctionSees]] of Object.entries(expectations)) {
      const ids = await visible(viewer);
      expect(ids.has(analystReceipt.id), `${viewer} analyst receipt`).toBe(analystSees);
      expect(ids.has(soloReceipt.id), `${viewer} solo receipt`).toBe(soloSees);
      expect(ids.has(correction.id), `${viewer} correction`).toBe(correctionSees);
      const detail = await request(app).get(`/api/companies/${companyId}/evaluation/events/${analystReceipt.id}`).set(as(viewer));
      expect(detail.status, `${viewer} detail`).toBe(analystSees ? 200 : 404);
    }
  });

  it("ingest-state counts by type include only classes the viewer reads", async () => {
    const outsider = await request(app).get(`/api/companies/${companyId}/evaluation/ingest-state`).set(as("outsider"));
    expect(outsider.status).toBe(200);
    expect(outsider.body.eventsByType["assessment.automated"]).toBeUndefined();
    expect(outsider.body.eventsByType["correction.recorded"]).toBeUndefined();
    expect(outsider.body.eventsByType["access.would_refuse"]).toBeUndefined(); // its only row is in the restricted project
    const owner = await request(app).get(`/api/companies/${companyId}/evaluation/ingest-state`).set(as("owner"));
    expect(owner.body.eventsByType["assessment.automated"]).toBe(2);
    expect(owner.body.eventsByType["correction.recorded"]).toBe(1);
  });

  it("the SQL condition and the row predicate agree row for row, for every viewer", async () => {
    const rows = await all();
    const ledger = evaluationLedger(db);
    for (const key of ["owner", "steward", "accountable", "represented", "outsider", "insider", "agent"]) {
      const req = { actor: actors.get(key) } as unknown as Parameters<typeof resolveEvaluationViewer>[1];
      const viewer = await resolveEvaluationViewer(db as never, req, companyId);
      const bySql = (await ledger.list(companyId, { limit: 5000, accessCondition: viewerClassCondition(viewer) })).map((r) => r.id).sort();
      const byPredicate = rows.filter(viewerClassFilter(viewer)).map((r) => r.id).sort();
      expect(bySql, key).toEqual(byPredicate);
      expect(viewer.admin).toBe(key === "owner");
    }
  });
});

describeEmbeddedPostgres("APM gate 3: routine dispatch records the scheduled occurrence (embedded postgres)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-evaluation-gate3-occurrences-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function service(companyId: string) {
    return routineService(db, {
      heartbeat: {
        // the production wake contract, as routines-service.test.ts fakes it: a queued run that holds the issue
        wakeup: async (wakeAgentId, opts) => {
          const issueId =
            (typeof opts.payload?.issueId === "string" && opts.payload.issueId) ||
            (typeof opts.contextSnapshot?.issueId === "string" && opts.contextSnapshot.issueId) ||
            null;
          if (!issueId) return null;
          const runId = randomUUID();
          await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: wakeAgentId, invocationSource: opts.source ?? "assignment", status: "queued", contextSnapshot: { ...(opts.contextSnapshot ?? {}), issueId } });
          await db.update(issues).set({ executionRunId: runId, executionLockedAt: new Date() }).where(eq(issues.id, issueId));
          return { id: runId };
        },
      },
    });
  }

  async function seedRoutine(catchUpPolicy: "skip_missed" | "enqueue_missed_with_cap", cron: string, nextRunAt: Date) {
    const company = await addCompany(db, "Occurrences", "default");
    const agent = await addAgent(db, company.id, { name: "Reporter", status: "active" });
    const svc = service(company.id);
    const routine = await svc.create(
      company.id,
      { projectId: null, goalId: null, parentIssueId: null, title: "Report", description: "Write it", assigneeAgentId: agent.id, priority: "medium", status: "active", concurrencyPolicy: "coalesce_if_active", catchUpPolicy },
      {},
    );
    const [schedule] = await db.insert(routineTriggers).values({ companyId: company.id, routineId: routine.id, kind: "schedule", cronExpression: cron, timezone: "UTC", nextRunAt }).returning();
    const [api] = await db.insert(routineTriggers).values({ companyId: company.id, routineId: routine.id, kind: "api", label: "api" }).returning();
    return { companyId: company.id, svc, routine, schedule: schedule!, api: api! };
  }

  const occurrencesOf = (companyId: string) => db.select().from(routineRunOccurrences).where(eq(routineRunOccurrences.companyId, companyId));

  it("a schedule dispatch records the due tick it served; manual and API runs record none", async () => {
    const due = new Date("2026-10-27T09:00:00.000Z");
    const s = await seedRoutine("skip_missed", "0 9 * * *", due);
    const tick = await s.svc.tickScheduledTriggers(new Date("2026-10-28T10:00:00.000Z"));
    expect(tick.triggered).toBe(1);
    const runs = await db.select().from(routineRuns).where(eq(routineRuns.companyId, s.companyId));
    expect(runs).toHaveLength(1);
    const occurrences = await occurrencesOf(s.companyId);
    // skip_missed: the one run serves the claimed due tick; the missed 10-28 09:00 tick is skipped, not recorded
    expect(occurrences.map((o) => [o.routineRunId, o.triggerId, o.scheduledFor.toISOString()])).toEqual([[runs[0]!.id, s.schedule.id, due.toISOString()]]);

    // close the live issue so later runs are new runs, then run by hand and through the API trigger
    await db.update(issues).set({ status: "done", executionRunId: null, executionLockedAt: null }).where(eq(issues.companyId, s.companyId));
    const manual = await s.svc.runRoutine(s.routine.id, { source: "manual", triggerId: s.schedule.id });
    await db.update(issues).set({ status: "done", executionRunId: null, executionLockedAt: null }).where(eq(issues.companyId, s.companyId));
    const api = await s.svc.runRoutine(s.routine.id, { source: "api", triggerId: s.api.id });
    expect([manual.status, api.status]).toEqual(["issue_created", "issue_created"]);
    expect(await occurrencesOf(s.companyId)).toHaveLength(1);

    // ingest: the schedule run carries its occurrence, the others none
    await evaluationIngest(db).backfill(s.companyId);
    const events = await db
      .select()
      .from(evaluationEvents)
      .where(and(eq(evaluationEvents.companyId, s.companyId), eq(evaluationEvents.eventType, "routine.run_changed")));
    const byRun = new Map(events.map((e) => [e.sourceId, e.payload as { source: string; scheduledFor: string | null; triggerId: string | null }]));
    expect(byRun.get(runs[0]!.id)).toMatchObject({ source: "schedule", scheduledFor: due.toISOString(), triggerId: s.schedule.id });
    expect(byRun.get(manual.id)).toMatchObject({ source: "manual", scheduledFor: null });
    expect(byRun.get(api.id)).toMatchObject({ source: "api", scheduledFor: null });
    // the definitions are ingested too, with history: the schedule claim moved next_run_at but is no new definition
    const triggerSnapshots = await db
      .select()
      .from(evaluationEvents)
      .where(and(eq(evaluationEvents.companyId, s.companyId), eq(evaluationEvents.eventType, "routine.trigger_snapshot"), eq(evaluationEvents.sourceId, s.schedule.id)));
    expect(triggerSnapshots).toHaveLength(1);
    expect(triggerSnapshots[0]!.payload).toMatchObject({ triggerId: s.schedule.id, kind: "schedule", cronExpression: "0 9 * * *", timezone: "UTC", enabled: true });
    await db.update(routineTriggers).set({ enabled: false, updatedAt: new Date() }).where(eq(routineTriggers.id, s.schedule.id));
    await evaluationIngest(db).tick(s.companyId);
    const versions = await db
      .select()
      .from(evaluationEvents)
      .where(and(eq(evaluationEvents.companyId, s.companyId), eq(evaluationEvents.eventType, "routine.trigger_snapshot"), eq(evaluationEvents.sourceId, s.schedule.id)));
    expect(versions.map((v) => (v.payload as { enabled: boolean }).enabled).sort()).toEqual([false, true]);
    const routineSnapshots = await db.select().from(evaluationEvents).where(and(eq(evaluationEvents.companyId, s.companyId), eq(evaluationEvents.eventType, "routine.snapshot")));
    expect(routineSnapshots).toHaveLength(1);
    expect(routineSnapshots[0]!.payload).toMatchObject({ status: "active", catchUpPolicy: "skip_missed", concurrencyPolicy: "coalesce_if_active" });
  });

  it("catch-up dispatch records each missed tick it enqueued, coalesced runs included", async () => {
    const s = await seedRoutine("enqueue_missed_with_cap", "0 * * * *", new Date("2026-10-28T08:00:00.000Z"));
    const tick = await s.svc.tickScheduledTriggers(new Date("2026-10-28T10:30:00.000Z"));
    expect(tick.triggered).toBe(3);
    const runs = await db.select().from(routineRuns).where(eq(routineRuns.companyId, s.companyId));
    const occurrences = await occurrencesOf(s.companyId);
    expect(occurrences.map((o) => o.scheduledFor.toISOString()).sort()).toEqual(["2026-10-28T08:00:00.000Z", "2026-10-28T09:00:00.000Z", "2026-10-28T10:00:00.000Z"]);
    expect(new Set(occurrences.map((o) => o.routineRunId))).toEqual(new Set(runs.map((r) => r.id)));
    expect(runs.map((r) => r.status).sort()).toEqual(["coalesced", "coalesced", "issue_created"]);
  });
});
