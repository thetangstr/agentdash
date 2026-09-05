import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

// AgentDash: Company Evaluator — route-level tests for Milestone 1: company
// scoping on the reads and the administrator-only gate on the two operator
// POSTs (spec §10, §13 security bullet). Services are mocked; this tests the
// HTTP boundary only.

const tick = vi.fn().mockResolvedValue({ companyId: "company-1", scanned: 3, inserted: 2, skipped: 1, durationMs: 5, perSource: {} });
const backfill = vi.fn().mockResolvedValue({ passes: 1, inserted: 2, scanned: 3, exhausted: true });
const snapshot = vi.fn().mockResolvedValue({ version: 1, throughSeq: 7, cardHash: "h", card: {} });
const verify = vi.fn().mockResolvedValue({ ok: true });
const logActivity = vi.fn().mockResolvedValue(undefined);

const append = vi.fn().mockResolvedValue({ inserted: 1, skipped: 0, insertedIds: ["e9"], oldestInsertedEventTime: null });
vi.mock("../services/evaluation/ingest.js", () => ({
  MAX_BACKFILL_PASSES: 20,
  evaluationIngest: () => ({ tick, backfill, cursors: vi.fn().mockResolvedValue({}), running: false }),
  withCompanyLock: (_db: unknown, _companyId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
}));
const ledgerList = vi.fn().mockResolvedValue([{ id: "e1" }]);
const existing = vi.fn(async (_companyId: string, ids: string[]) => new Set(ids.filter((id) => id.startsWith("ev-"))));
vi.mock("../services/evaluation/ledger.js", () => ({
  hashCanonical: (v: unknown) => `h:${JSON.stringify(v).length}`,
  evaluationLedger: () => ({
    list: ledgerList,
    countByType: vi.fn().mockResolvedValue({ "issue.created": 1 }),
    maxSeq: vi.fn().mockResolvedValue(7),
    append,
    existing,
  }),
}));
vi.mock("../services/evaluation/replay.js", () => ({
  evaluationReplay: () => ({ replay: vi.fn().mockResolvedValue({ card: {}, hash: "h", state: { open: true, retrospective: false, hasContract: false }, throughSeq: 7 }) }),
}));
vi.mock("../services/evaluation/scorecards.js", () => ({
  evaluationScorecardService: () => ({ latest: vi.fn().mockResolvedValue(null), snapshot, verify }),
}));
vi.mock("../services/access.js", () => ({ accessService: () => ({ getMembership: vi.fn().mockResolvedValue(null), listMemberships: vi.fn().mockResolvedValue([]) }) }));
const agentsList = vi.fn().mockResolvedValue([]);
const agentCreate = vi.fn().mockResolvedValue({ id: "agent-eval", name: "Evaluator", role: "evaluator", reportsTo: null, status: "idle" });
const createApiKey = vi.fn().mockResolvedValue({ id: "key-1", token: "tok-once" });
const revokeKeysOfKind = vi.fn().mockResolvedValue(1);
vi.mock("../services/agents.js", () => ({ agentService: () => ({ list: agentsList, create: agentCreate, createApiKey, revokeKeysOfKind }) }));
const projectsList = vi.fn().mockResolvedValue([]);
const projectCreate = vi.fn().mockResolvedValue({ id: "proj-eval", name: "Evaluator review items" });
vi.mock("../services/projects.js", () => ({ projectService: () => ({ list: projectsList, create: projectCreate }) }));
const reviewSync = vi.fn().mockResolvedValue({ projectId: "proj-eval", labelId: "lbl", created: ["i1"], updated: [], unchanged: [], unrouted: [] });
vi.mock("../services/evaluation/review-items.js", () => ({ evaluationReviewItems: () => ({ sync: reviewSync }) }));
vi.mock("../services/activity-log.js", () => ({ logActivity }));

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { evaluationRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/evaluation.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor, companyIds: Array.isArray(actor.companyIds) ? [...(actor.companyIds as string[])] : actor.companyIds };
    next();
  });
  app.use("/api", evaluationRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const boardAdmin = { type: "board", userId: "user-1", companyIds: ["company-1"], source: "session", isInstanceAdmin: true };
const agentKey = { type: "agent", agentId: "agent-1", companyId: "company-1", companyIds: ["company-1"], source: "api_key" };

describe("evaluation routes", () => {
  afterEach(() => {
    existing.mockClear();
    ledgerList.mockClear();
    reviewSync.mockClear();
    append.mockClear();
    agentsList.mockClear();
    agentCreate.mockClear();
    createApiKey.mockClear();
    revokeKeysOfKind.mockClear();
    projectCreate.mockClear();
    tick.mockClear();
    backfill.mockClear();
    snapshot.mockClear();
    verify.mockClear();
    logActivity.mockClear();
  });

  it("reads are company-scoped: another company's ledger is refused", async () => {
    const app = await createApp(boardAdmin);
    const ok = await request(app).get("/api/companies/company-1/evaluation/events");
    expect(ok.status).toBe(200);
    expect(ok.body.count).toBe(1);
    const other = await request(app).get("/api/companies/company-2/evaluation/events");
    expect(other.status).toBeGreaterThanOrEqual(403);
    expect(other.status).toBeLessThan(500);
  });

  it("an agent key cannot run ingest or store a snapshot, and no side effect happens", async () => {
    const app = await createApp(agentKey);
    const run = await request(app).post("/api/companies/company-1/evaluation/ingest/run");
    expect(run.status).toBe(403);
    const snap = await request(app).post("/api/companies/company-1/evaluation/scorecards/snapshot").send({ kind: "project", id: "22222222-2222-4222-8222-222222222222" });
    expect(snap.status).toBe(403);
    expect(tick).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("a company administrator can run ingest (bounded backfill) and snapshot, and both are audited", async () => {
    const app = await createApp(boardAdmin);
    const run = await request(app).post("/api/companies/company-1/evaluation/ingest/run?backfill=true");
    expect(run.status).toBe(200);
    expect(backfill).toHaveBeenCalledWith("company-1", 20);
    const snap = await request(app).post("/api/companies/company-1/evaluation/scorecards/snapshot").send({ kind: "project", id: "22222222-2222-4222-8222-222222222222" });
    expect(snap.status).toBe(201);
    // state markers cannot be supplied by the caller: the service is called with the ref only
    expect(snapshot).toHaveBeenCalledWith("company-1", { kind: "project", id: "22222222-2222-4222-8222-222222222222" });
    expect(logActivity).toHaveBeenCalledTimes(2);
    expect(logActivity.mock.calls.map((c) => (c[1] as { action: string }).action).sort()).toEqual(["evaluation.ingest_run", "evaluation.scorecard_snapshot"]);
  });

  it("verify and replay materialise the company window: administrators only; plain card reads stay open", async () => {
    const agent = await createApp(agentKey);
    const q = "kind=project&id=22222222-2222-4222-8222-222222222222";
    expect((await request(agent).get(`/api/companies/company-1/evaluation/scorecards?${q}`)).status).toBe(200);
    expect((await request(agent).get(`/api/companies/company-1/evaluation/scorecards?${q}&verify=true`)).status).toBe(403);
    expect((await request(agent).get(`/api/companies/company-1/evaluation/replay?${q}`)).status).toBe(403);
    expect(verify).not.toHaveBeenCalled();
    const admin = await createApp(boardAdmin);
    expect((await request(admin).get(`/api/companies/company-1/evaluation/scorecards?${q}&verify=true`)).status).toBe(200);
    expect((await request(admin).get(`/api/companies/company-1/evaluation/replay?${q}`)).status).toBe(200);
  });

  it("a backfill cut short by the lock is audited as such", async () => {
    backfill.mockResolvedValueOnce({ passes: 2, inserted: 5, scanned: 9, exhausted: false, lockedOut: true });
    const app = await createApp(boardAdmin);
    const run = await request(app).post("/api/companies/company-1/evaluation/ingest/run?backfill=true");
    expect(run.status).toBe(200);
    expect(run.body.lockedOut).toBe(true);
    expect((logActivity.mock.calls[0]![1] as { details: Record<string, unknown> }).details).toMatchObject({ backfill: true, passes: 2, lockedOut: true, exhausted: false });
  });

  it("a contract is declared by an administrator only, must be a valid v1 declared contract for this company, and is audited", async () => {
    const CID = "11111111-1111-4111-8111-111111111111";
    const contract = {
      contractVersion: "v1",
      companyId: CID,
      goalId: null,
      parentGoalId: null,
      milestoneRef: { kind: "project", id: "22222222-2222-4222-8222-222222222222" },
      accountableUserId: "user-1",
      leadAgentId: null,
      acceptanceCriteria: [{ id: "c1", text: "verdict passed", check: { kind: "record", record: "verdict.passed" }, source: "human" }],
      definitionOfDone: null,
      requiredEvidence: ["dod_present", "neutral_verdict", "delivery_ref", "ci_green", "independent_review"],
      independenceRule: "independence/v1",
      excludedReviewers: [],
      founderLocks: [],
      outcomeTarget: null,
      targetDate: null,
      downstreamRiskAcceptance: null,
      windowStart: "2026-09-01T00:00:00.000Z",
      windowEnd: null,
      source: "declared",
    };
    const agent = await createApp({ ...agentKey, companyId: CID, companyIds: [CID] });
    expect((await request(agent).post(`/api/companies/${CID}/evaluation/contracts`).send(contract)).status).toBe(403);
    expect(append).not.toHaveBeenCalled();
    const admin = await createApp({ ...boardAdmin, companyIds: [CID] });
    expect((await request(admin).post(`/api/companies/${CID}/evaluation/contracts`).send({ ...contract, companyId: "33333333-3333-4333-8333-333333333333" })).status).toBe(400);
    expect((await request(admin).post(`/api/companies/${CID}/evaluation/contracts`).send({ ...contract, source: "derived" })).status).toBe(400);
    expect((await request(admin).post(`/api/companies/${CID}/evaluation/contracts`).send({ nope: true })).status).toBe(400);
    expect(append).not.toHaveBeenCalled();
    const ok = await request(admin).post(`/api/companies/${CID}/evaluation/contracts`).send(contract);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ inserted: 1, eventId: "e9" });
    const [events] = append.mock.calls[0]! as [Array<Record<string, unknown>>];
    expect(events[0]).toMatchObject({ eventType: "contract.declared", sourceTable: "evaluation_contracts", sourceId: "project:22222222-2222-4222-8222-222222222222", projectId: "22222222-2222-4222-8222-222222222222", actorType: "user" });
    expect(logActivity.mock.calls.map((c) => (c[1] as { action: string }).action)).toEqual(["evaluation.contract_declared"]);
    expect((await request(admin).get(`/api/companies/${CID}/evaluation/contracts?kind=project&id=22222222-2222-4222-8222-222222222222`)).status).toBe(200);
  });

  it("provisions the evaluator principal once: administrators only, no manager, read-only key returned once, review project created", async () => {
    const agent = await createApp(agentKey);
    expect((await request(agent).post("/api/companies/company-1/evaluation/principal").send({})).status).toBe(403);
    expect(agentCreate).not.toHaveBeenCalled();
    const admin = await createApp(boardAdmin);
    const first = await request(admin).post("/api/companies/company-1/evaluation/principal").send({});
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ created: true, projectId: "proj-eval", key: { id: "key-1", token: "tok-once" }, agent: { role: "evaluator", reportsTo: null } });
    expect(agentCreate.mock.calls[0]![1]).toMatchObject({ role: "evaluator", reportsTo: null, accountableUserId: "user-1" });
    expect(createApiKey).toHaveBeenCalledWith("agent-eval", "evaluator (read-only)", { source: "manual", createdByUserId: "user-1" }, "evaluator");
    expect(projectCreate).toHaveBeenCalledTimes(1);
    // second call: idempotent, no token
    agentsList.mockResolvedValueOnce([{ id: "agent-eval", name: "Evaluator", role: "evaluator", reportsTo: null, status: "idle" }]);
    projectsList.mockResolvedValueOnce([{ id: "proj-eval", name: "Evaluator review items" }]);
    const second = await request(admin).post("/api/companies/company-1/evaluation/principal").send({});
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ created: false, key: null });
    expect(agentCreate).toHaveBeenCalledTimes(1);
    expect(projectCreate).toHaveBeenCalledTimes(1);
    // rotation revokes the old evaluator keys and mints one new
    agentsList.mockResolvedValueOnce([{ id: "agent-eval", name: "Evaluator", role: "evaluator", reportsTo: null, status: "idle" }]);
    projectsList.mockResolvedValueOnce([{ id: "proj-eval", name: "Evaluator review items" }]);
    const rotated = await request(admin).post("/api/companies/company-1/evaluation/principal").send({ rotateKey: true });
    expect(rotated.status).toBe(200);
    expect(rotated.body.key).toEqual({ id: "key-1", token: "tok-once" });
    expect(revokeKeysOfKind).toHaveBeenCalledWith("agent-eval", "evaluator");
    expect(logActivity.mock.calls.map((c) => (c[1] as { action: string }).action)).toEqual(["evaluation.principal_provisioned", "evaluation.principal_provisioned", "evaluation.principal_provisioned"]);
  });

  it("review items: the evaluator principal and administrators may sync them from the latest stored card; an ordinary agent may not", async () => {
    const q = { kind: "project", id: "22222222-2222-4222-8222-222222222222" };
    const agent = await createApp(agentKey);
    expect((await request(agent).post("/api/companies/company-1/evaluation/review-items").send(q)).status).toBe(403);
    expect(reviewSync).not.toHaveBeenCalled();
    const evaluator = await createApp({ ...agentKey, principalKind: "evaluator", readOnly: true });
    const noCard = await request(evaluator).post("/api/companies/company-1/evaluation/review-items").send(q);
    expect(noCard.status).toBe(404); // the mocked service has no stored card
    expect(reviewSync).not.toHaveBeenCalled();
    const admin = await createApp(boardAdmin);
    const snap = await request(admin).post("/api/companies/company-1/evaluation/scorecards/snapshot?reviewItems=true").send(q);
    expect(snap.status).toBe(201);
    expect(reviewSync).toHaveBeenCalledTimes(1);
    expect(reviewSync.mock.calls[0]![4]).toBe("user-1"); // the administrator is the fallback human
    expect(snap.body.reviewItems).toMatchObject({ created: ["i1"] });
  });

  it("evaluator notes cite ledger events or are refused; the evaluator principal and administrators may write them, ordinary agents may not", async () => {
    const evaluator = await createApp({ ...agentKey, principalKind: "evaluator", readOnly: true });
    const uncited = await request(evaluator).post("/api/companies/company-1/evaluation/findings").send({ exceptionKey: "E5:issue:x", note: "stale for a week", evidenceRefs: ["not-a-ledger-event"] });
    expect(uncited.status).toBe(400);
    expect(append).not.toHaveBeenCalled();
    const noRefs = await request(evaluator).post("/api/companies/company-1/evaluation/findings").send({ exceptionKey: "E5:issue:x", note: "stale for a week", evidenceRefs: [] });
    expect(noRefs.status).toBe(400);
    const ok = await request(evaluator).post("/api/companies/company-1/evaluation/findings").send({ exceptionKey: "E5:issue:x", note: "stale for a week", evidenceRefs: ["ev-1", "ev-2"] });
    expect(ok.status).toBe(201);
    const [events] = append.mock.calls[0]! as [Array<Record<string, unknown>>];
    expect(events[0]).toMatchObject({ eventType: "evaluation.finding", actorType: "evaluator", actorId: "agent-1", sourceTable: "evaluator_notes", sourceId: "E5:issue:x" });
    expect((events[0]!.payload as { evidenceRefs: string[] }).evidenceRefs).toEqual(["ev-1", "ev-2"]);
    const agent = await createApp(agentKey);
    expect((await request(agent).post("/api/companies/company-1/evaluation/findings").send({ exceptionKey: "k", note: "n", evidenceRefs: ["ev-1"] })).status).toBe(403);
    expect(logActivity.mock.calls.map((c) => (c[1] as { action: string }).action)).toEqual(["evaluation.finding_noted"]);
  });

  it("humans file corrections against existing ledger events; the evaluator may only attach a cited note; a human decides", async () => {
    const evaluator = await createApp({ ...agentKey, principalKind: "evaluator", readOnly: true });
    expect((await request(evaluator).post("/api/companies/company-1/evaluation/corrections").send({ disputedEventId: "22222222-2222-4222-8222-222222222222", claimedFact: "it was reviewed" })).status).toBe(403);
    const admin = await createApp(boardAdmin);
    const missing = await request(admin).post("/api/companies/company-1/evaluation/corrections").send({ disputedEventId: "22222222-2222-4222-8222-222222222222", claimedFact: "it was reviewed" });
    expect(missing.status).toBe(404); // the mocked ledger knows only ev-* ids
    existing.mockResolvedValueOnce(new Set(["22222222-2222-4222-8222-222222222222"]));
    const filed = await request(admin).post("/api/companies/company-1/evaluation/corrections").send({ disputedEventId: "22222222-2222-4222-8222-222222222222", claimedFact: "it was reviewed", evidenceRefs: [] });
    expect(filed.status).toBe(201);
    expect((append.mock.calls[0]![0] as Array<Record<string, unknown>>)[0]).toMatchObject({ eventType: "evaluation.correction", actorType: "user", actorId: "user-1" });
    // evaluator note on the correction: the correction must exist and the note must cite
    ledgerList.mockResolvedValueOnce([{ id: "corr-1", eventType: "evaluation.correction" }]);
    const note = await request(evaluator).post("/api/companies/company-1/evaluation/corrections/corr-1/note").send({ note: "the verdict at ev-1 was by the assignee", evidenceRefs: ["ev-1"] });
    expect(note.status).toBe(201);
    expect((append.mock.calls[1]![0] as Array<Record<string, unknown>>)[0]).toMatchObject({ eventType: "evaluation.disposition", actorType: "evaluator", sourceId: "corr-1" });
    ledgerList.mockResolvedValueOnce([]);
    expect((await request(evaluator).post("/api/companies/company-1/evaluation/corrections/corr-9/note").send({ note: "x", evidenceRefs: ["ev-1"] })).status).toBe(404);
    // the disposition is the human's: the evaluator is refused, the administrator decides
    expect((await request(evaluator).post("/api/companies/company-1/evaluation/dispositions").send({ kind: "correction_decided", correctionEventId: "33333333-3333-4333-8333-333333333333", decision: "accepted" })).status).toBe(403);
    existing.mockResolvedValueOnce(new Set(["33333333-3333-4333-8333-333333333333"]));
    const decided = await request(admin).post("/api/companies/company-1/evaluation/dispositions").send({ kind: "correction_decided", correctionEventId: "33333333-3333-4333-8333-333333333333", decision: "accepted", note: "agreed" });
    expect(decided.status).toBe(201);
    expect((append.mock.calls[2]![0] as Array<Record<string, unknown>>)[0]).toMatchObject({ eventType: "evaluation.disposition", actorType: "user", sourceTable: "evaluation_dispositions" });
    expect(((append.mock.calls[2]![0] as Array<Record<string, unknown>>)[0]!.payload as { kind: string; decision: string; decidedBy: string })).toMatchObject({ kind: "correction_decided", decision: "accepted", decidedBy: "user-1" });
    // accepting a contract exception and attesting a criterion follow the same shape
    existing.mockResolvedValueOnce(new Set(["44444444-4444-4444-8444-444444444444"]));
    expect((await request(admin).post("/api/companies/company-1/evaluation/dispositions").send({ kind: "contract_exception_accepted", contractEventId: "44444444-4444-4444-8444-444444444444" })).status).toBe(201);
    const attest = await request(admin).post("/api/companies/company-1/evaluation/dispositions").send({ kind: "criterion_attest", criterionId: "k1", result: "satisfied", evidenceRefs: ["ev-3"], milestoneRef: { kind: "project", id: "22222222-2222-4222-8222-222222222222" } });
    expect(attest.status).toBe(201);
    expect((append.mock.calls[4]![0] as Array<Record<string, unknown>>)[0]).toMatchObject({ projectId: "22222222-2222-4222-8222-222222222222", sourceId: "k1:milestone" });
    expect((await request(admin).post("/api/companies/company-1/evaluation/dispositions").send({ kind: "nope" })).status).toBe(400);
  });

  it("rejects a malformed snapshot body and an unknown event type filter is ignored", async () => {
    const app = await createApp(boardAdmin);
    const bad = await request(app).post("/api/companies/company-1/evaluation/scorecards/snapshot").send({ kind: "sprint", id: "nope" });
    expect(bad.status).toBe(400);
    const filtered = await request(app).get("/api/companies/company-1/evaluation/events?type=not.a.type,issue.created");
    expect(filtered.status).toBe(200);
  });
});
