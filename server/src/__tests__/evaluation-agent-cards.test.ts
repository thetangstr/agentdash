import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, createDb, evaluationEvents, evaluationScorecards, issues, projects } from "@paperclipai/db";
import { AGENT_CASE_FILTER_NONE, evaluationCriterionRefKey, type AgentCardView, type EvaluationCriterionRef } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany, addUser, agentRequestActor, boardActor, type TestDb } from "./helpers/agent-profile-fixtures.js";
import { profileBody, responsibility, seedActiveProfile } from "./helpers/responsibility-fixtures.js";
import { errorHandler } from "../middleware/index.js";
import { evaluationRoutes } from "../routes/evaluation.js";
import { evaluationAgentRoutes } from "../routes/evaluation-agents.js";
import { agentCardService } from "../services/evaluation/agent-cards.js";
import { evaluationLedger, type EvaluationEventInput } from "../services/evaluation/ledger.js";
import { evaluationSnapshotCadence } from "../services/evaluation/schedule.js";

// AgentDash: Agent Performance Management gate 3 (P3.3) — stored agent cards
// on embedded Postgres: snapshot → verify round-trip, the reuse rule, findings
// and calibration review items through the existing review-items path, the
// per-viewer projection over HTTP (no leak through the card, its cases or
// counts), side-effect-free "Compute now", the dispositions extension, the
// class filter on the milestone contracts/scorecards/overview routes, and the
// snapshot cadence for agents with an applied profile.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const H = 3_600_000;

describeEmbeddedPostgres("agent cards (APM gate 3, P3.3)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let ownerId = "";
  let accountableId = "";
  let judgeId = "";
  let outsiderId = "";
  let agentId = "";
  let reviewerId = "";
  let openProject = "";
  let restrictedProject = "";
  let openIssue = "";
  let hiddenIssue = "";
  let contractEventId = "";
  let t0 = 0;
  const at = (h: number) => new Date(t0 + h * H);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-cards-");
    db = createDb(tempDb.connectionString);
    const company = await addCompany(db, "Cards", "default");
    companyId = company.id;
    ownerId = await addUser(db, companyId, "owner");
    accountableId = await addUser(db, companyId, "member");
    judgeId = await addUser(db, companyId, "member");
    outsiderId = await addUser(db, companyId, "member");
    const agent = await addAgent(db, companyId, { name: "Builder", accountableUserId: accountableId, autonomy: "autonomous" });
    agentId = agent.id;
    reviewerId = (await addAgent(db, companyId, { name: "Reviewer" })).id;
    openProject = (await db.insert(projects).values({ companyId, name: "Open work", status: "in_progress" }).returning())[0]!.id;
    restrictedProject = (await db.insert(projects).values({ companyId, name: "Secret work", status: "in_progress", visibility: "restricted", createdByUserId: ownerId }).returning())[0]!.id;
    openIssue = (await db.insert(issues).values({ companyId, title: "Open item", status: "done", projectId: openProject, assigneeAgentId: agentId }).returning())[0]!.id;
    hiddenIssue = (await db.insert(issues).values({ companyId, title: "Secret item", status: "done", projectId: restrictedProject, assigneeAgentId: agentId }).returning())[0]!.id;
    await db.insert(agents).values({ companyId, name: "Evaluator", role: "evaluator", status: "idle" }); // the cadence opt-in
    t0 = Date.now() - 48 * H;

    const ledger = evaluationLedger(db);
    const revisionId = "00000000-0000-4000-8000-0000000000e1";
    const contract = {
      contractVersion: "v2",
      companyId,
      subjectRef: { kind: "agent", id: agentId },
      accountableUserId: accountableId,
      profileRevisionId: revisionId,
      independenceRule: "independence/v1",
      responsibilities: [
        {
          key: "work",
          criteria: [{ id: "a1", text: "The judge accepts it", check: { kind: "human_attest", attesterUserId: judgeId }, source: "human" }],
          coverage: [],
          outcomeLinks: [],
          expectedHumanSteps: [],
          judges: { automated: [], human: { userId: judgeId, sampleRate: 1, minPerWindow: 1 } },
        },
      ],
    };
    const declared = await ledger.append([
      { companyId, actorType: "user", actorId: accountableId, sourceTable: "evaluation_contracts", sourceId: `agent:${agentId}`, sourceVersion: `revision:${revisionId}`, eventType: "contract.declared", eventTime: at(0), payload: { contract, companyId } },
    ]);
    contractEventId = declared.insertedIds[0]!;
    const issueEvents = (issueId: string, projectId: string, identifier: string, accessClass: "company" | `project:${string}`): EvaluationEventInput[] => {
      const base = { companyId, projectId, accessClass, subjectAgentId: agentId };
      const pl = (extra: Record<string, unknown>) => ({ issueId, identifier, ...extra });
      return [
        { ...base, actorType: "system", sourceTable: "issues", sourceId: issueId, sourceVersion: "s1", eventType: "issue.snapshot", eventTime: at(2), payload: pl({ status: "todo", projectId, assigneeAgentId: agentId, labels: [], titleTokens: [] }) },
        { ...base, actorType: "agent", actorId: agentId, sourceTable: "activity_log", sourceId: `${issueId}:t1`, sourceVersion: "1", eventType: "issue.transition", eventTime: at(3), payload: pl({ from: "todo", to: "in_progress" }) },
        { ...base, actorType: "agent", actorId: agentId, sourceTable: "activity_log", sourceId: `${issueId}:t2`, sourceVersion: "1", eventType: "issue.transition", eventTime: at(5), payload: pl({ from: "in_progress", to: "in_review" }) },
        { ...base, actorType: "agent", actorId: reviewerId, sourceTable: "activity_log", sourceId: `${issueId}:t3`, sourceVersion: "1", eventType: "issue.transition", eventTime: at(6), payload: pl({ from: "in_review", to: "done" }) },
        { ...base, actorType: "user", actorId: ownerId, sourceTable: "issue_responsibilities", sourceId: `${issueId}:m`, sourceVersion: "open", eventType: "responsibility.interval", eventTime: at(2), payload: { mappingId: `00000000-0000-4000-8000-${issueId.slice(-12)}`, issueId, identifier, agentId, responsibilityKey: "work", profileRevisionId: revisionId, validFrom: at(2).toISOString(), validTo: null, mappedBy: "human" } },
      ];
    };
    await ledger.append([
      { companyId, actorType: "system", sourceTable: "agents", sourceId: agentId, sourceVersion: "a1", eventType: "agent.snapshot", eventTime: at(0), payload: { agentId, name: "Builder", accountableUserId: accountableId, status: "idle" } },
      { companyId, actorType: "system", subjectAgentId: agentId, sourceTable: "agent_profile_revisions", sourceId: revisionId, sourceVersion: "applied", eventType: "profile.revision_changed", eventTime: at(1), payload: { revisionId, agentId, state: "applied", responsibilities: [{ key: "work", obligation: { kind: "assigned" }, deadline: null }] } },
      { companyId, actorType: "user", actorId: ownerId, subjectAgentId: agentId, sourceTable: "agent_profile_applications", sourceId: "app-1", sourceVersion: "applied", eventType: "profile.application_changed", eventTime: at(1), payload: { applicationId: "app-1", agentId, revisionId, status: "applied" } },
      ...issueEvents(openIssue, openProject, "CRD-1", "company"),
      ...issueEvents(hiddenIssue, restrictedProject, "CRD-2", `project:${restrictedProject}`),
    ]);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function call(actor: Record<string, unknown>, method: "get" | "post", path: string, body?: unknown) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use("/api", evaluationRoutes(db));
    app.use("/api", evaluationAgentRoutes(db));
    app.use(errorHandler);
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const r = request(`http://127.0.0.1:${address.port}`)[method](path);
      return await (body === undefined ? r : r.send(body as object));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }
  const owner = () => boardActor(companyId, ownerId, "owner");
  const accountable = () => boardActor(companyId, accountableId);
  const judge = () => boardActor(companyId, judgeId);
  const outsider = () => boardActor(companyId, outsiderId);
  const base = () => `/api/companies/${companyId}/evaluation`;
  const counts = async () => ({
    cards: (await db.select({ n: sql<number>`count(*)::int` }).from(evaluationScorecards).where(eq(evaluationScorecards.companyId, companyId)))[0]!.n,
    events: (await db.select({ n: sql<number>`count(*)::int` }).from(evaluationEvents).where(eq(evaluationEvents.companyId, companyId)))[0]!.n,
    issues: (await db.select({ n: sql<number>`count(*)::int` }).from(issues).where(eq(issues.companyId, companyId)))[0]!.n,
  });

  it("snapshot → verify agrees; a second snapshot with no new facts reuses the version; calibration items go to the named human, filtered by class", async () => {
    const svc = agentCardService(db);
    const first = await svc.snapshotAgentCard(companyId, agentId, { asOf: new Date(), fallbackUserId: ownerId });
    expect(first).toMatchObject({ version: 1, reused: false, formulaVersion: "agent-metrics/1" });
    expect(await svc.verifyAgentCard(companyId, agentId)).toMatchObject({ ok: true, status: "agree", version: 1 });
    // the judge reads the open item but not the restricted one: one item, one withheld, never silently dropped
    const items = first.reviewItems as NonNullable<typeof first.reviewItems> & { withheld: Array<{ key: string }> };
    expect(items.created.length).toBe(1);
    expect(items.withheld.map((w) => w.key)).toEqual([`calibration:${agentId}:sample:issue:${hiddenIssue}`]);
    const [item] = await db.select().from(issues).where(eq(issues.id, items.created[0]!));
    expect(item).toMatchObject({ status: "todo", assigneeUserId: judgeId, assigneeAgentId: null });
    expect(item!.description).not.toContain(hiddenIssue);
    const second = await svc.snapshotAgentCard(companyId, agentId, { asOf: new Date(), fallbackUserId: ownerId });
    expect(second).toMatchObject({ version: 1, reused: true, throughSeq: first.throughSeq });
    expect(second.reviewItems?.created.length).toBe(0);
    const stored = await db.select().from(evaluationScorecards).where(and(eq(evaluationScorecards.companyId, companyId), eq(evaluationScorecards.milestoneKind, "agent")));
    expect(stored.map((s) => [s.milestoneId, s.version, s.contractVersion])).toEqual([[agentId, 1, "v2"]]);
  });

  it("serves each viewer a projection: the restricted project's work never reaches the outsider, in the card, the list or the cases", async () => {
    const asOwner = await call(owner(), "get", `${base()}/agents/${agentId}`);
    expect(asOwner.status).toBe(200);
    const ownerCard = asOwner.body.card as AgentCardView;
    expect(ownerCard.restricted).toBe(false);
    if (ownerCard.worker.obligations.visibility === "not_visible") throw new Error("visible to the owner");
    expect(ownerCard.worker.obligations.body.responsibilities[0]!.owed).toBe(2);
    const asOutsider = await call(outsider(), "get", `${base()}/agents/${agentId}`);
    const view = asOutsider.body.card as AgentCardView;
    expect(view.restricted).toBe(true);
    expect(view.worker.obligations.visibility).toBe("partial");
    if (view.worker.obligations.visibility !== "not_visible") expect(view.worker.obligations.body.responsibilities[0]!.owed).toBe(1);
    expect(JSON.stringify(asOutsider.body)).not.toContain(hiddenIssue);
    expect(JSON.stringify(asOutsider.body)).not.toContain("CRD-2");
    const ownerCases = await call(owner(), "get", `${base()}/agents/${agentId}/cases?section=obligations`);
    const outsiderCases = await call(outsider(), "get", `${base()}/agents/${agentId}/cases?section=obligations`);
    expect(ownerCases.body.total).toBe(2);
    expect(outsiderCases.body.total).toBe(1);
    expect(JSON.stringify(outsiderCases.body)).not.toContain(hiddenIssue);
    const list = await call(outsider(), "get", `${base()}/agents`);
    expect(list.status).toBe(200);
    const mine = list.body.agents.find((a: { agentId: string }) => a.agentId === agentId);
    expect(mine.obligations).toEqual([{ responsibilityKey: "work", owed: 1, delivered: 1 }]);
    // agents read no cards; only an admin or the accountable person snapshots or verifies
    expect((await call(agentRequestActor({ id: agentId, companyId }), "get", `${base()}/agents/${agentId}`)).status).toBe(403);
    expect((await call(outsider(), "post", `${base()}/agents/${agentId}/snapshot`, {})).status).toBe(403);
    expect((await call(outsider(), "get", `${base()}/agents/${agentId}/verify`)).status).toBe(403);
    const verify = await call(accountable(), "get", `${base()}/agents/${agentId}/verify`);
    expect(verify.body.verify).toMatchObject({ ok: true, status: "agree" });
  });

  it("'Compute now' is side-effect-free", async () => {
    const before = await counts();
    const activityBefore = (await db.select({ n: sql<number>`count(*)::int` }).from(activityLog).where(eq(activityLog.companyId, companyId)))[0]!.n;
    const r = await call(outsider(), "get", `${base()}/agents/${agentId}/compute`);
    expect(r.status).toBe(200);
    expect(r.body.card).toMatchObject({ kind: "agent_card_view", stored: null, sideEffectFree: true });
    expect(await counts()).toEqual(before);
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(activityLog).where(eq(activityLog.companyId, companyId)))[0]!.n).toBe(activityBefore);
  });

  it("dispositions: criterion_attest only by the named attester and bound to its tuple; use_confirmed by a person; disagreement_noted by the accountable person; V1 kinds unchanged", async () => {
    const tuple: EvaluationCriterionRef = { contractEventId, responsibilityKey: "work", criterionId: "a1", checkHash: "" };
    const stored = (await call(owner(), "get", `${base()}/agents/${agentId}`)).body.card as AgentCardView;
    tuple.checkHash = stored.contract.responsibilities[0]!.criteria[0]!.ref.checkHash;
    const [anyEvent] = await db.select({ id: evaluationEvents.id }).from(evaluationEvents).where(and(eq(evaluationEvents.companyId, companyId), ne(evaluationEvents.id, contractEventId))).limit(1);
    const attest = { kind: "criterion_attest", binding: { criterion: tuple, subjectRef: { kind: "agent", id: agentId }, item: { kind: "issue", id: openIssue } }, result: "satisfied", evidenceRefs: [anyEvent!.id] };
    expect((await call(outsider(), "post", `${base()}/dispositions`, attest)).status).toBe(403);
    expect((await call(owner(), "post", `${base()}/dispositions`, attest)).status).toBe(403); // admins are not the named attester
    expect((await call(judge(), "post", `${base()}/dispositions`, { ...attest, binding: { ...attest.binding, criterion: { ...tuple, checkHash: "0000000000000000" } } })).status).toBe(422);
    expect((await call(judge(), "post", `${base()}/dispositions`, attest)).status).toBe(201);
    expect((await call(judge(), "post", `${base()}/dispositions`, attest)).status).toBe(200); // idempotent
    expect((await call(outsider(), "post", `${base()}/dispositions`, { kind: "use_confirmed", subjectRef: { kind: "agent", id: agentId }, item: { kind: "issue", id: openIssue } })).status).toBe(201);
    const noted = { kind: "disagreement_noted", subjectRef: { kind: "agent", id: agentId }, item: { kind: "issue", id: openIssue }, criterion: tuple, judgmentEventIds: [anyEvent!.id, contractEventId], note: "Seen" };
    expect((await call(outsider(), "post", `${base()}/dispositions`, noted)).status).toBe(403);
    expect((await call(accountable(), "post", `${base()}/dispositions`, noted)).status).toBe(201);
    // the milestone attest (no binding) stays administrator-only
    expect((await call(outsider(), "post", `${base()}/dispositions`, { kind: "criterion_attest", criterionId: "k", result: "satisfied", evidenceRefs: [anyEvent!.id], milestoneRef: { kind: "project", id: openProject } })).status).toBe(403);
    const activity = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "evaluation.disposition_recorded")));
    expect(activity.length).toBeGreaterThanOrEqual(4);
    // the next snapshot is a new version and counts the bound person judgment and the use
    const snap = await call(accountable(), "post", `${base()}/agents/${agentId}/snapshot`, {});
    expect(snap.status).toBe(201);
    expect(snap.body.snapshot.version).toBe(2);
    expect(snap.body.verify).toMatchObject({ ok: true, status: "agree" });
    const card = snap.body.card as AgentCardView;
    if (card.worker.quality.visibility === "not_visible" || card.worker.acceptance.visibility === "not_visible") throw new Error("visible");
    expect(card.worker.quality.body.criteria[0]!.byJudge.person.pass).toBe(1);
    expect(card.worker.acceptance.body.facts.use.yes).toBe(1);
    // the earlier version still verifies at its own cut
    expect((await agentCardService(db).verifyAgentCard(companyId, agentId, 1)).ok).toBe(true);
    expect((await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "evaluation.agent_card_snapshot")))).length).toBe(1);
  });

  it("P3.7: the versions route lists the stored versions, scoped like the card; agents and other companies are refused", async () => {
    const r = await call(outsider(), "get", `${base()}/agents/${agentId}/versions`);
    expect(r.status).toBe(200);
    const stored = await db.select().from(evaluationScorecards).where(and(eq(evaluationScorecards.companyId, companyId), eq(evaluationScorecards.milestoneKind, "agent"), eq(evaluationScorecards.milestoneId, agentId)));
    expect(r.body.agentId).toBe(agentId);
    expect(r.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    for (const v of r.body.versions as Array<Record<string, unknown>>) {
      const row = stored.find((s) => s.version === v.version)!;
      expect(v).toEqual({
        version: row.version,
        cardHash: row.cardHash,
        throughSeq: Number(row.throughSeq),
        asOf: (row.card as { replay: { asOf: string } }).replay.asOf,
        createdAt: row.createdAt.toISOString(),
      });
    }
    // no card content: nothing a class filter would hide is in the list
    expect(JSON.stringify(r.body)).not.toContain(hiddenIssue);
    expect((await call(agentRequestActor({ id: agentId, companyId }), "get", `${base()}/agents/${agentId}/versions`)).status).toBe(403);
    const otherCompany = await addCompany(db, "Elsewhere", "default");
    expect((await call(outsider(), "get", `/api/companies/${otherCompany.id}/evaluation/agents/${agentId}/versions`)).status).toBe(403);
    const stranger = (await addAgent(db, otherCompany.id, { name: "Stranger" })).id;
    expect((await call(outsider(), "get", `${base()}/agents/${stranger}/versions`)).status).toBe(404);
  });

  it("P3.7: every card view carries the viewer's permissions, from the same guards the routes apply", async () => {
    const latest = (await call(owner(), "get", `${base()}/agents/${agentId}`)).body.card as AgentCardView;
    const tupleKey = evaluationCriterionRefKey(latest.contract.responsibilities[0]!.criteria[0]!.ref);
    const flags = async (actor: Record<string, unknown>) => {
      const res = await call(actor, "get", `${base()}/agents/${agentId}`);
      expect(res.status).toBe(200);
      expect(res.body.viewer).toEqual(res.body.card.viewer);
      return res.body.viewer;
    };
    expect(await flags(owner())).toEqual({ canSnapshot: true, canNoteDisagreement: true, canConfirmUse: true, attestableCriteria: [] });
    expect(await flags(accountable())).toEqual({ canSnapshot: true, canNoteDisagreement: true, canConfirmUse: true, attestableCriteria: [] });
    expect(await flags(judge())).toEqual({ canSnapshot: false, canNoteDisagreement: false, canConfirmUse: true, attestableCriteria: [tupleKey] });
    expect(await flags(outsider())).toEqual({ canSnapshot: false, canNoteDisagreement: false, canConfirmUse: true, attestableCriteria: [] });
    // an instance admin is an administrator everywhere, as the snapshot guard says
    const instanceAdmin = { ...outsider(), isInstanceAdmin: true };
    expect(await flags(instanceAdmin)).toMatchObject({ canSnapshot: true, canNoteDisagreement: true });
    expect((await call(instanceAdmin, "get", `${base()}/agents/${agentId}/verify`)).status).toBe(200);
    // the flags agree with what the routes then do
    expect((await call(judge(), "post", `${base()}/agents/${agentId}/snapshot`, {})).status).toBe(403);
    // "Compute now" and an agent with no stored card carry them too
    expect((await call(judge(), "get", `${base()}/agents/${agentId}/compute`)).body.card.viewer.attestableCriteria).toEqual([tupleKey]);
    const bare = await addAgent(db, companyId, { name: "Bare", accountableUserId: accountableId });
    const none = await call(accountable(), "get", `${base()}/agents/${bare.id}`);
    expect(none.body).toEqual({ card: null, viewer: { canSnapshot: true, canNoteDisagreement: true, canConfirmUse: true, attestableCriteria: [] } });
    expect((await call(outsider(), "get", `${base()}/agents/${bare.id}`)).body.viewer.canSnapshot).toBe(false);
    // the list links by the agent's url key
    const list = await call(owner(), "get", `${base()}/agents`);
    expect(list.body.agents.find((a: { agentId: string }) => a.agentId === agentId).urlKey).toBe("builder");
  });

  it("P3.7: cases filter by fact, criterion and judge on the server, after the class filter; quality cases cite records before any judgment", async () => {
    const cases = async (actor: Record<string, unknown>, query: string) => {
      const res = await call(actor, "get", `${base()}/agents/${agentId}/cases?limit=500&${query}`);
      expect(res.status).toBe(200);
      return res.body as { rows: Array<Record<string, any>>; total: number };
    };
    const use = await cases(owner(), "section=acceptance&fact=use");
    expect(use.total).toBe(2);
    expect(use.rows.every((r) => r.fact === "use")).toBe(true);
    expect((await cases(outsider(), "section=acceptance&fact=use")).total).toBe(1); // the restricted item is not counted
    const usedYes = await cases(owner(), "section=acceptance&fact=use&state=pass");
    expect(usedYes.rows.map((r) => r.item.id)).toEqual([openIssue]);
    const latest = (await call(owner(), "get", `${base()}/agents/${agentId}`)).body.card as AgentCardView;
    const key = evaluationCriterionRefKey(latest.contract.responsibilities[0]!.criteria[0]!.ref);
    const byCriterion = await cases(owner(), `section=quality&criterion=${encodeURIComponent(key)}`);
    expect(byCriterion.total).toBeGreaterThanOrEqual(2);
    expect(byCriterion.rows.every((r) => evaluationCriterionRefKey(r.criterion) === key)).toBe(true);
    const byPerson = await cases(owner(), `section=quality&criterion=${encodeURIComponent(key)}&judge=person`);
    expect(byPerson.rows.map((r) => [r.item.id, r.judge, r.state])).toEqual([[openIssue, "person", "pass"]]);
    // the restricted item has no judgment yet, but its case still cites the item's records (for a bound attestation)
    const unjudged = byCriterion.rows.find((r) => r.item.id === hiddenIssue)!;
    expect(unjudged).toMatchObject({ state: "unknown", judge: null });
    expect(unjudged.evidenceRefs.length).toBeGreaterThan(0);
    const known = await db.select({ id: evaluationEvents.id }).from(evaluationEvents).where(and(eq(evaluationEvents.companyId, companyId), inArray(evaluationEvents.id, unjudged.evidenceRefs)));
    expect(known.length).toBe(unjudged.evidenceRefs.length);
    expect((await cases(owner(), `section=quality&criterion=${encodeURIComponent(AGENT_CASE_FILTER_NONE)}`)).rows.every((r) => r.criterion === null)).toBe(true);
    expect((await cases(owner(), `section=obligations&responsibility=${encodeURIComponent(AGENT_CASE_FILTER_NONE)}`)).total).toBe(0); // every item is mapped
    expect((await call(owner(), "get", `${base()}/agents/${agentId}/cases?fact=nonsense`)).status).toBe(400);
    expect((await call(owner(), "get", `${base()}/agents/${agentId}/cases?judge=nobody`)).status).toBe(400);
  });

  it("the milestone contracts, scorecards and overview routes don't reveal a restricted project to a viewer who can't read it", async () => {
    const contract = {
      contractVersion: "v1",
      companyId,
      goalId: null,
      parentGoalId: null,
      milestoneRef: { kind: "project", id: restrictedProject },
      accountableUserId: ownerId,
      leadAgentId: null,
      acceptanceCriteria: [],
      definitionOfDone: null,
      requiredEvidence: ["dod_present", "neutral_verdict", "delivery_ref", "ci_green", "independent_review"],
      independenceRule: "independence/v1",
      excludedReviewers: [],
      founderLocks: [],
      outcomeTarget: null,
      targetDate: null,
      downstreamRiskAcceptance: null,
      windowStart: new Date(t0).toISOString(),
      windowEnd: null,
      source: "declared",
    };
    expect((await call(owner(), "post", `${base()}/contracts`, contract)).status).toBe(201);
    expect((await call(owner(), "post", `${base()}/scorecards/snapshot`, { kind: "project", id: restrictedProject })).status).toBe(201);
    const q = `kind=project&id=${restrictedProject}`;
    expect((await call(owner(), "get", `${base()}/contracts?${q}`)).body.contract).not.toBeNull();
    expect((await call(outsider(), "get", `${base()}/contracts?${q}`)).status).toBe(404);
    expect((await call(owner(), "get", `${base()}/scorecards?${q}`)).body.latest).not.toBeNull();
    expect((await call(outsider(), "get", `${base()}/scorecards?${q}`)).status).toBe(404);
    expect((await call(outsider(), "get", `${base()}/scorecards/versions?${q}`)).status).toBe(404);
    const overview = await call(outsider(), "get", `${base()}/overview`);
    expect(overview.body.milestones.map((m: { name: string }) => m.name)).not.toContain("Secret work");
    expect((await call(owner(), "get", `${base()}/overview`)).body.milestones.map((m: { name: string }) => m.name)).toContain("Secret work");
  });

  it("the snapshot cadence stores a card for every agent with an applied profile", async () => {
    const other = await addAgent(db, companyId, { name: "Profiled", accountableUserId: accountableId });
    await seedActiveProfile(db, { companyId, agentId: other.id, body: profileBody([responsibility("work")]) });
    const result = await evaluationSnapshotCadence(db).run();
    expect(result.agents).toBe(1);
    expect(result.agentCards).toBe(1);
    expect(result.agentFailures).toEqual([]);
    const rows = await db.select().from(evaluationScorecards).where(and(eq(evaluationScorecards.companyId, companyId), eq(evaluationScorecards.milestoneId, other.id)));
    expect(rows.map((r) => [r.milestoneKind, r.version])).toEqual([["agent", 1]]);
  });
});
