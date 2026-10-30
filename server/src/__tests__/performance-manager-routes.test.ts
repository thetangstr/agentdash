import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentProfileApplications,
  agents,
  approvals,
  companies,
  createDb,
  evaluationEvents,
  evaluationScorecards,
  issues,
  projectAccess,
  projects,
} from "@paperclipai/db";
import { DEFAULT_AGENT_GOVERNANCE_POLICY, parseAccessPolicy, type AgentCardView, type AgentOperatingProfileV1 } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany, addUser, agentRequestActor, boardActor, type TestDb } from "./helpers/agent-profile-fixtures.js";
import { activityRows, setAccessMode, setAccessPolicy } from "./helpers/agent-access-fixtures.js";
import { profileBody, responsibility, seedActiveProfile } from "./helpers/responsibility-fixtures.js";
import { errorHandler } from "../middleware/index.js";
import { agentAccessRoutes } from "../routes/agent-access.js";
import { agentProfileRoutes } from "../routes/agent-profiles.js";
import { approvalRoutes } from "../routes/approvals.js";
import { evaluationAgentRoutes } from "../routes/evaluation-agents.js";
import { performanceManagerRoutes } from "../routes/performance-manager.js";
import { proposerCapacityOfApproval } from "../services/agent-profiles.js";
import { evaluationLedger, type EvaluationEventInput } from "../services/evaluation/ledger.js";

// AgentDash: Agent Performance Management gate 4 (P4.1) — the performance
// manager over HTTP on embedded Postgres: the designation (default and
// override), the `performanceManager` flag, the manager's card reads with the
// agent-principal class limits (every other agent 403), its proposals through
// the gate 2 path (field authority unchanged, the manager never decides),
// advisory recommendations (stored, decided once, "pause" pauses nothing, no
// card moves), and the manager's own record. One ordered scenario.
// P4.3: the list's `viewer.canDecide` (the decision guard), revisions'
// `proposedByCapacity`, and the record's individual recommendations.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const H = 3_600_000;
type Body = any; // eslint-disable-line @typescript-eslint/no-explicit-any

describeEmbeddedPostgres("performance manager (APM gate 4, P4.1)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let otherCompanyId = "";
  let otherAgentId = "";
  let ownerId = "";
  let accountableId = "";
  let outsiderId = "";
  let builder = { id: "", companyId: "" };
  let chief = { id: "", companyId: "" };
  let deputy = { id: "", companyId: "" };
  let evaluator = { id: "", companyId: "" };
  let restrictedProject = "";
  let openEventId = "";
  let hiddenEventId = "";
  let privateEventId = "";
  let t0 = 0;
  const at = (h: number) => new Date(t0 + h * H);
  const state: { approved?: string; companyRecommendationId?: string; projectRecommendationId?: string } = {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-performance-manager-");
    db = createDb(tempDb.connectionString);
    const company = await addCompany(db, "Managers", "default");
    companyId = company.id;
    ownerId = await addUser(db, companyId, "owner");
    accountableId = await addUser(db, companyId, "member");
    outsiderId = await addUser(db, companyId, "member");
    builder = await addAgent(db, companyId, { name: "Builder", accountableUserId: accountableId, autonomy: "autonomous" });
    chief = await addAgent(db, companyId, { name: "Chief", role: "chief_of_staff" });
    deputy = await addAgent(db, companyId, { name: "Deputy" });
    evaluator = await addAgent(db, companyId, { name: "Evaluator", role: "evaluator" });
    const other = await addCompany(db, "Elsewhere", "default");
    otherCompanyId = other.id;
    otherAgentId = (await addAgent(db, otherCompanyId, { name: "Stranger", role: "chief_of_staff" })).id;

    const openProject = (await db.insert(projects).values({ companyId, name: "Open work", status: "in_progress" }).returning())[0]!.id;
    restrictedProject = (await db.insert(projects).values({ companyId, name: "Secret work", status: "in_progress", visibility: "restricted", createdByUserId: ownerId }).returning())[0]!.id;
    const openIssue = (await db.insert(issues).values({ companyId, title: "Open item", status: "done", projectId: openProject, assigneeAgentId: builder.id }).returning())[0]!.id;
    const hiddenIssue = (await db.insert(issues).values({ companyId, title: "Secret item", status: "done", projectId: restrictedProject, assigneeAgentId: builder.id }).returning())[0]!.id;
    await seedActiveProfile(db, { companyId, agentId: builder.id, body: { ...profileBody([responsibility("work")]), access: parseAccessPolicy(DEFAULT_AGENT_GOVERNANCE_POLICY) } });

    // The builder's ledger (as the gate 3 card suite seeds it): one open and one restricted item, plus a private correction.
    t0 = Date.now() - 48 * H;
    const ledger = evaluationLedger(db);
    const revisionId = "00000000-0000-4000-8000-0000000000e1";
    const contract = {
      contractVersion: "v2",
      companyId,
      subjectRef: { kind: "agent", id: builder.id },
      accountableUserId: accountableId,
      profileRevisionId: revisionId,
      independenceRule: "independence/v1",
      responsibilities: [
        {
          key: "work",
          criteria: [{ id: "a1", text: "Delivered", check: { kind: "record", record: "deliverable.shipped" }, source: "human" }],
          coverage: [],
          outcomeLinks: [],
          expectedHumanSteps: [],
          judges: { automated: [] },
        },
      ],
    };
    await ledger.append([
      { companyId, actorType: "user", actorId: accountableId, sourceTable: "evaluation_contracts", sourceId: `agent:${builder.id}`, sourceVersion: `revision:${revisionId}`, eventType: "contract.declared", eventTime: at(0), payload: { contract, companyId } },
    ]);
    const issueEvents = (issueId: string, projectId: string, identifier: string, accessClass: "company" | `project:${string}`): EvaluationEventInput[] => {
      const base = { companyId, projectId, accessClass, subjectAgentId: builder.id };
      const pl = (extra: Record<string, unknown>) => ({ issueId, identifier, ...extra });
      return [
        { ...base, actorType: "system", sourceTable: "issues", sourceId: issueId, sourceVersion: "s1", eventType: "issue.snapshot", eventTime: at(2), payload: pl({ status: "todo", projectId, assigneeAgentId: builder.id, labels: [], titleTokens: [] }) },
        { ...base, actorType: "agent", actorId: builder.id, sourceTable: "activity_log", sourceId: `${issueId}:t1`, sourceVersion: "1", eventType: "issue.transition", eventTime: at(3), payload: pl({ from: "todo", to: "in_progress" }) },
        { ...base, actorType: "agent", actorId: deputy.id, sourceTable: "activity_log", sourceId: `${issueId}:t3`, sourceVersion: "1", eventType: "issue.transition", eventTime: at(6), payload: pl({ from: "in_progress", to: "done" }) },
        { ...base, actorType: "user", actorId: ownerId, sourceTable: "issue_responsibilities", sourceId: `${issueId}:m`, sourceVersion: "open", eventType: "responsibility.interval", eventTime: at(2), payload: { mappingId: `00000000-0000-4000-8000-${issueId.slice(-12)}`, issueId, identifier, agentId: builder.id, responsibilityKey: "work", profileRevisionId: revisionId, validFrom: at(2).toISOString(), validTo: null, mappedBy: "human" } },
      ];
    };
    await ledger.append([
      { companyId, actorType: "system", sourceTable: "agents", sourceId: builder.id, sourceVersion: "a1", eventType: "agent.snapshot", eventTime: at(0), payload: { agentId: builder.id, name: "Builder", accountableUserId: accountableId, status: "idle" } },
      { companyId, actorType: "system", subjectAgentId: builder.id, sourceTable: "agent_profile_revisions", sourceId: revisionId, sourceVersion: "applied", eventType: "profile.revision_changed", eventTime: at(1), payload: { revisionId, agentId: builder.id, state: "applied", responsibilities: [{ key: "work", obligation: { kind: "assigned" }, deadline: null }] } },
      ...issueEvents(openIssue, openProject, "MGR-1", "company"),
      ...issueEvents(hiddenIssue, restrictedProject, "MGR-2", `project:${restrictedProject}`),
      { companyId, actorType: "user", actorId: accountableId, subjectAgentId: builder.id, sourceTable: "agent_corrections", sourceId: "corr-1", sourceVersion: "1", eventType: "correction.recorded", eventTime: at(7), accessClass: `private_agent:${builder.id}`, payload: { agentId: builder.id, kind: "correction" } },
    ]);
    const idOf = async (sourceId: string, sourceVersion: string) => (await ledger.findBySource(companyId, sourceId.includes("corr") ? "agent_corrections" : "activity_log", sourceId, sourceVersion))!.id;
    openEventId = await idOf(`${openIssue}:t1`, "1");
    hiddenEventId = await idOf(`${hiddenIssue}:t1`, "1");
    privateEventId = await idOf("corr-1", "1");
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function call(actor: Record<string, unknown>, method: "get" | "post" | "patch", path: string, body?: unknown, headers: Record<string, string> = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor };
      next();
    });
    app.use("/api", agentProfileRoutes(db));
    app.use("/api", agentAccessRoutes(db));
    app.use("/api", approvalRoutes(db, { autoDispatchQueuedRuns: false }));
    app.use("/api", evaluationAgentRoutes(db));
    app.use("/api", performanceManagerRoutes(db));
    app.use(errorHandler);
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      let r = request(`http://127.0.0.1:${address.port}`)[method](path);
      for (const [name, value] of Object.entries(headers)) r = r.set(name, value);
      const res = await (body === undefined ? r : r.send(body as object));
      return { status: res.status, body: res.body as Body };
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }

  const owner = () => boardActor(companyId, ownerId, "owner");
  const accountable = () => boardActor(companyId, accountableId);
  const outsider = () => boardActor(companyId, outsiderId);
  const asAgent = (agent: { id: string; companyId: string }, extra: Record<string, unknown> = {}) => agentRequestActor(agent, extra);
  const evaluatorActor = () => agentRequestActor(evaluator, { principalKind: "evaluator", readOnly: true });
  const pmPath = () => `/api/companies/${companyId}/performance-manager`;
  const cards = () => `/api/companies/${companyId}/evaluation/agents`;
  const recs = (agentId = builder.id) => `${cards()}/${agentId}/recommendations`;
  const recordPath = () => `/api/companies/${companyId}/evaluation/performance-manager/record`;
  const profile = (agentId = builder.id) => `/api/companies/${companyId}/agents/${agentId}/profile`;
  const decision = (approval: { revision: number }) => ({ revision: approval.revision, idempotencyKey: randomUUID(), channel: "web" });

  async function draft(actor: Record<string, unknown>, mutate: (body: AgentOperatingProfileV1) => void, editor?: Record<string, unknown>) {
    const created = await call(actor, "post", `${profile()}/revisions`, {});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const body = structuredClone(created.body.body) as AgentOperatingProfileV1;
    mutate(body);
    const saved = await call(editor ?? actor, "patch", `${profile()}/revisions/${created.body.id}`, { body }, { "If-Match": created.body.bodyHash });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    return created.body.id as string;
  }

  async function obligationsOwed(actor: Record<string, unknown>): Promise<number | "not_visible"> {
    const res = await call(actor, "get", `${cards()}/${builder.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const card = res.body.card as AgentCardView;
    if (card.worker.obligations.visibility === "not_visible") return "not_visible";
    return card.worker.obligations.body.responsibilities.reduce((n, r) => n + (r.owed ?? 0), 0);
  }

  // -------------------------------------------------------------------------

  it("1. designation: defaults to the Chief of Staff; only an admin overrides or clears it, with activity; ineligible agents are refused", async () => {
    const asMember = await call(outsider(), "get", pmPath());
    expect(asMember.status).toBe(200);
    expect(asMember.body).toMatchObject({ kind: "performance_manager", designatedAgentId: null, source: "chief_of_staff", effective: { agentId: chief.id, role: "chief_of_staff" }, viewer: { canChange: false } });
    expect((await call(owner(), "get", pmPath())).body.viewer.canChange).toBe(true);
    expect((await call(asAgent(builder), "get", pmPath())).status).toBe(200);
    expect((await call(asAgent(builder), "get", `/api/companies/${otherCompanyId}/performance-manager`)).status).toBe(403);

    // Members and agents cannot change it.
    expect((await call(accountable(), "patch", pmPath(), { agentId: deputy.id })).status).toBe(403);
    expect((await call(asAgent(chief), "patch", pmPath(), { agentId: deputy.id })).status).toBe(403);
    // Ineligible targets.
    expect((await call(owner(), "patch", pmPath(), { agentId: evaluator.id })).body.details).toMatchObject({ code: "PERFORMANCE_MANAGER_INELIGIBLE", reason: "evaluator" });
    expect((await call(owner(), "patch", pmPath(), { agentId: otherAgentId })).status).toBe(404);
    expect((await call(owner(), "patch", pmPath(), { agentId: "not-a-uuid" })).status).toBe(400);
    expect(await activityRows(db, companyId, "company.performance_manager_changed")).toHaveLength(0);

    // Override, idempotent repeat, then clear back to the default.
    const set = await call(owner(), "patch", pmPath(), { agentId: deputy.id });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({ designatedAgentId: deputy.id, source: "designated", effective: { agentId: deputy.id }, changed: true, previousDesignatedAgentId: null });
    expect((await call(owner(), "patch", pmPath(), { agentId: deputy.id })).body.changed).toBe(false);
    const [changed] = await activityRows(db, companyId, "company.performance_manager_changed");
    expect(changed).toMatchObject({ actorType: "user", actorId: ownerId, entityType: "company", entityId: companyId });
    expect(changed!.details).toMatchObject({ from: null, to: deputy.id, effectiveFrom: chief.id, effectiveTo: deputy.id, source: "designated" });

    // A designated agent that is terminated leaves no manager (no silent fall-back to the Chief of Staff).
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, deputy.id));
    expect((await call(owner(), "get", pmPath())).body).toMatchObject({ designatedAgentId: deputy.id, effective: null, source: "none" });
    expect((await call(owner(), "patch", pmPath(), { agentId: deputy.id })).body.details).toMatchObject({ code: "PERFORMANCE_MANAGER_INELIGIBLE", reason: "terminated" });
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, deputy.id));

    const cleared = await call(owner(), "patch", pmPath(), { agentId: null });
    expect(cleared.body).toMatchObject({ designatedAgentId: null, source: "chief_of_staff", effective: { agentId: chief.id }, changed: true });
    expect(await activityRows(db, companyId, "company.performance_manager_changed")).toHaveLength(2);
  });

  it("2. GET /agents/me/profile and /agents/me/access carry performanceManager, following the designation", async () => {
    const flag = async (agent: { id: string; companyId: string }) => (await call(asAgent(agent), "get", "/api/agents/me/profile")).body.performanceManager;
    expect(await flag(chief)).toBe(true);
    expect(await flag(builder)).toBe(false);
    expect((await call(asAgent(chief), "get", "/api/agents/me/access")).body.performanceManager).toBe(true);
    await call(owner(), "patch", pmPath(), { agentId: deputy.id });
    expect(await flag(deputy)).toBe(true);
    expect(await flag(chief)).toBe(false);
    // The board read of a profile says whether that agent is the manager.
    expect((await call(owner(), "get", profile(deputy.id))).body.performanceManager).toBe(true);
    await call(owner(), "patch", pmPath(), { agentId: null });
  });

  it("3. the manager reads cards, cases and compute as an agent principal: no private class, projects only by its own access; every other agent is 403", async () => {
    const snap = await call(owner(), "post", `${cards()}/${builder.id}/snapshot`, {});
    expect([200, 201]).toContain(snap.status);
    expect(await obligationsOwed(owner())).toBe(2);

    const manager = asAgent(chief);
    const list = await call(manager, "get", cards());
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.agents.find((a: Body) => a.agentId === builder.id).obligations).toEqual([{ responsibilityKey: "work", owed: 1, delivered: 1 }]);
    const card = await call(manager, "get", `${cards()}/${builder.id}`);
    expect(card.body.card.restricted).toBe(true);
    expect(card.body.viewer).toEqual({ canSnapshot: false, canNoteDisagreement: false, canConfirmUse: false, attestableCriteria: [] });
    expect(await obligationsOwed(manager)).toBe(1);
    const cases = await call(manager, "get", `${cards()}/${builder.id}/cases?section=obligations`);
    expect(cases.status).toBe(200);
    expect(cases.body.total).toBe(1);
    expect(JSON.stringify(cases.body)).not.toContain("MGR-2");
    const compute = await call(manager, "get", `${cards()}/${builder.id}/compute`);
    expect(compute.status).toBe(200);
    expect(JSON.stringify(compute.body)).not.toContain("MGR-2");

    // Project access widens the manager's view exactly as it would any agent's.
    await db.insert(projectAccess).values({ projectId: restrictedProject, principalType: "agent", principalId: chief.id, grantedByUserId: ownerId });
    expect(await obligationsOwed(manager)).toBe(2);
    // An enforced V2 project scope narrows it again (never widened by being the manager).
    await setAccessMode(db, companyId, "enforce");
    await setAccessPolicy(db, companyId, chief.id, { request: { see: { projects: { mode: "listed", ids: [] } } } });
    const narrowed = await obligationsOwed(manager);
    expect(narrowed === "not_visible" || narrowed === 0).toBe(true);
    await setAccessMode(db, companyId, "off");
    expect(await obligationsOwed(manager)).toBe(2);

    // Every other agent principal stays at 403, including the Chief of Staff once someone else is designated.
    for (const actor of [asAgent(builder), asAgent(deputy), evaluatorActor()]) {
      expect((await call(actor, "get", cards())).status).toBe(403);
      expect((await call(actor, "get", `${cards()}/${builder.id}`)).status).toBe(403);
      expect((await call(actor, "get", `${cards()}/${builder.id}/cases`)).status).toBe(403);
      expect((await call(actor, "get", `${cards()}/${builder.id}/compute`)).status).toBe(403);
    }
    // Versions, snapshot and verify stay people-only.
    expect((await call(manager, "get", `${cards()}/${builder.id}/versions`)).status).toBe(403);
    expect((await call(manager, "post", `${cards()}/${builder.id}/snapshot`, {})).status).toBe(403);
    await call(owner(), "patch", pmPath(), { agentId: deputy.id });
    expect((await call(manager, "get", `${cards()}/${builder.id}`)).status).toBe(403);
    expect((await call(asAgent(deputy), "get", `${cards()}/${builder.id}`)).status).toBe(200);
    await call(owner(), "patch", pmPath(), { agentId: null });
  });

  it("4. the manager drafts and proposes through the gate 2 path: marked performance_manager, field authority unchanged, and it can never decide", async () => {
    const manager = asAgent(chief);
    // Another agent may not draft the builder's profile; the designation decides, not the role.
    expect((await call(asAgent(deputy), "post", `${profile()}/revisions`, {})).status).toBe(403);
    await call(owner(), "patch", pmPath(), { agentId: deputy.id });
    expect((await call(manager, "post", `${profile()}/revisions`, {})).status).toBe(403);
    await call(owner(), "patch", pmPath(), { agentId: null });

    // P1: a profile-only change; the accountable person rejects it.
    const p1 = await draft(manager, (b) => (b.identity.audience = "Operations"));
    const filed1 = await call(manager, "post", `${profile()}/revisions/${p1}/propose`, { reason: "Clearer audience", evidence: { cardVersion: 1, ledgerEventIds: [openEventId] } });
    expect(filed1.status, JSON.stringify(filed1.body)).toBe(201);
    expect(filed1.body.payload.proposedBy).toEqual({ kind: "agent", agentId: chief.id, runId: null, capacity: "performance_manager" });
    expect(filed1.body.payload.evidence).toEqual({ cardId: null, cardVersion: 1, ledgerEventIds: [openEventId] });
    expect(filed1.body.revision.proposedByCapacity).toBe("performance_manager");
    const a1 = await db.select().from(approvals).where(eq(approvals.id, filed1.body.approvalId)).then((r) => r[0]!);
    expect((await call(manager, "post", `/api/approvals/${a1.id}/approve`, decision(a1))).status).toBe(403);
    expect((await call(manager, "post", `/api/approvals/${a1.id}/reject`, decision(a1))).status).toBe(403);
    expect((await call(accountable(), "post", `/api/approvals/${a1.id}/reject`, decision(a1))).status).toBe(200);

    // P2: filed, then withdrawn by the manager.
    const p2 = await draft(manager, (b) => (b.identity.audience = "Finance"));
    const filed2 = await call(manager, "post", `${profile()}/revisions/${p2}/propose`, { reason: "Narrower audience" });
    expect(filed2.status).toBe(201);
    const withdrawn = await call(manager, "post", `${profile()}/revisions/${p2}/withdraw`, { reason: "Not yet" });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.proposedByCapacity).toBe("performance_manager");

    // P3: the manager drafts a responsibility and runtime change, the accountable person edits it, the manager files it.
    const p3 = await draft(manager, (b) => {
      b.responsibilities[0]!.outcome = "Every item shipped with a check";
      b.runtime = { adapterType: "process", heartbeat: { intervalSec: 1800 } };
    });
    const current = await call(accountable(), "get", `${profile()}/revisions/${p3}`);
    const edited = structuredClone(current.body.body) as AgentOperatingProfileV1;
    edited.identity.summary = "Builds and ships the work.";
    expect((await call(accountable(), "patch", `${profile()}/revisions/${p3}`, { body: edited }, { "If-Match": current.body.bodyHash })).status).toBe(200);
    const filed3 = await call(manager, "post", `${profile()}/revisions/${p3}/propose`, { reason: "Shipped work needs a check", evidence: { cardVersion: 1 } });
    expect(filed3.status, JSON.stringify(filed3.body)).toBe(201);
    expect(filed3.body.payload.requiredAuthority).toBe("admin");
    expect(filed3.body.payload.affectedResponsibilities).toEqual(["work"]);
    const a3 = await db.select().from(approvals).where(eq(approvals.id, filed3.body.approvalId)).then((r) => r[0]!);
    // Field authority: the runtime field needs an administrator, whoever proposed it.
    expect((await call(manager, "post", `/api/approvals/${a3.id}/approve`, decision(a3))).status).toBe(403);
    expect((await call(accountable(), "post", `/api/approvals/${a3.id}/approve`, decision(a3))).status).toBe(403);
    const approved = await call(owner(), "post", `/api/approvals/${a3.id}/approve`, decision(a3));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const application = await db.select().from(agentProfileApplications).where(eq(agentProfileApplications.approvalId, a3.id)).then((r) => r[0]!);
    expect(application.status).toBe("applied");
    state.approved = a3.id;

    // P4.3: revisions carry proposedByCapacity from their approval's payload, so the UI fetches no approval.
    const history = await call(accountable(), "get", `${profile()}/revisions`);
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    const capacityById = new Map((history.body as Body[]).map((r) => [r.id, r.proposedByCapacity]));
    expect(capacityById.get(p1)).toBe("performance_manager");
    expect(capacityById.get(p2)).toBe("performance_manager");
    expect(capacityById.get(p3)).toBe("performance_manager");
    // The seeded revision was never proposed through an approval: null, never absent.
    const others = (history.body as Body[]).filter((r) => ![p1, p2, p3].includes(r.id));
    expect(others.length).toBeGreaterThan(0);
    for (const r of others) expect(r).toHaveProperty("proposedByCapacity", null);
    expect((await call(accountable(), "get", `${profile()}/revisions/${p3}`)).body.proposedByCapacity).toBe("performance_manager");
    const profileView = await call(accountable(), "get", profile());
    expect(profileView.body.active).toMatchObject({ id: p3, proposedByCapacity: "performance_manager" });
    // A person's own proposal is not marked.
    const byPerson = await draft(accountable(), (b) => (b.identity.audience = "Support"));
    const personFiled = await call(accountable(), "post", `${profile()}/revisions/${byPerson}/propose`, { reason: "Mine" });
    expect(personFiled.status, JSON.stringify(personFiled.body)).toBe(201);
    expect(personFiled.body.revision.proposedByCapacity).toBeNull();
    expect((await call(accountable(), "get", profile())).body.pendingProposal).toMatchObject({ id: byPerson, proposedByCapacity: null });
    expect((await call(accountable(), "post", `${profile()}/revisions/${byPerson}/withdraw`, { reason: "Later" })).status).toBe(200);
  });

  it("5. recommendations: the manager files them with readable evidence, people decide once, and pause pauses nothing", async () => {
    const manager = asAgent(chief);
    // The first card stored after the step 4 application (it moved the cut).
    const stored = await call(owner(), "post", `${cards()}/${builder.id}/snapshot`, {});
    expect(stored.status, JSON.stringify(stored.body)).toBe(201);
    expect(stored.body.snapshot.version).toBe(2);
    const cutBefore = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(evaluationScorecards)
      .where(and(eq(evaluationScorecards.companyId, companyId), eq(evaluationScorecards.milestoneId, builder.id)))
      .then((r) => r[0]!.n);
    // Only the manager files.
    const body = { kind: "pause", reason: "Two late items this window", evidence: [{ kind: "card", ref: "1" }, { kind: "event", ref: openEventId }] };
    for (const actor of [asAgent(builder), asAgent(deputy), evaluatorActor(), owner()]) {
      expect((await call(actor, "post", recs(), body)).status).toBe(403);
    }
    // Evidence must exist and be readable by the manager.
    for (const evidence of [[{ kind: "event", ref: privateEventId }], [{ kind: "event", ref: randomUUID() }], [{ kind: "card", ref: "99" }]]) {
      const bad = await call(manager, "post", recs(), { ...body, evidence });
      expect(bad.status, JSON.stringify(bad.body)).toBe(422);
      expect(bad.body.details.code).toBe("AGENT_RECOMMENDATION_EVIDENCE_INVALID");
    }
    expect((await call(manager, "post", recs(), { ...body, evidence: [] })).status).toBe(400);

    const filed = await call(manager, "post", recs(), body);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    expect(filed.body).toMatchObject({ agentId: builder.id, kind: "pause", recommendedByAgentId: chief.id, advisory: true, decision: null });
    state.companyRecommendationId = filed.body.id;
    const [row] = await db.select().from(evaluationEvents).where(eq(evaluationEvents.id, filed.body.eventId));
    expect(row).toMatchObject({ eventType: "evaluation.agent_recommendation", accessClass: "company", actorType: "agent", actorId: chief.id, subjectAgentId: builder.id, sourceVersion: "recommended" });
    const [created] = await activityRows(db, companyId, "evaluation.agent_recommendation_created");
    expect(created!.details).toMatchObject({ recommendationId: filed.body.id, kind: "pause", advisory: true });

    // Citing the restricted project's event (the manager has project access since step 3) stores that project's class.
    const scoped = await call(manager, "post", recs(), { kind: "narrow", reason: "Keep to the open project", evidence: [{ kind: "event", ref: hiddenEventId }] });
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(201);
    state.projectRecommendationId = scoped.body.id;
    expect((await db.select().from(evaluationEvents).where(eq(evaluationEvents.id, scoped.body.eventId)))[0]!.accessClass).toBe(`project:${restrictedProject}`);

    // Listed for anyone who can read the card, filtered by class.
    const ids = async (actor: Record<string, unknown>) => (await call(actor, "get", recs())).body.recommendations.map((r: Body) => r.id).sort();
    expect(await ids(owner())).toEqual([state.companyRecommendationId, state.projectRecommendationId].sort());
    expect(await ids(manager)).toEqual([state.companyRecommendationId, state.projectRecommendationId].sort());
    expect(await ids(outsider())).toEqual([state.companyRecommendationId]);
    expect((await call(asAgent(builder), "get", recs())).status).toBe(403);
    // P4.3: viewer.canDecide is the decision route's guard: the accountable person or an admin, never the manager.
    const canDecide = async (actor: Record<string, unknown>) => (await call(actor, "get", recs())).body.viewer;
    expect(await canDecide(owner())).toEqual({ canDecide: true });
    expect(await canDecide(accountable())).toEqual({ canDecide: true });
    expect(await canDecide(outsider())).toEqual({ canDecide: false });
    expect(await canDecide(manager)).toEqual({ canDecide: false });

    // Deciding: the accountable person or an admin; once only.
    const decisionPath = `${recs()}/${state.companyRecommendationId}/decision`;
    expect((await call(outsider(), "post", decisionPath, { decision: "accepted" })).status).toBe(403);
    expect((await call(manager, "post", decisionPath, { decision: "accepted" })).status).toBe(403);
    const decided = await call(accountable(), "post", decisionPath, { decision: "accepted", note: "Agreed; I will pause it myself if needed" });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body).toMatchObject({ effect: "none", recommendation: { decision: { decision: "accepted", decidedByUserId: accountableId } } });
    expect(decided.body.next).toContain("Nothing was paused");
    expect((await call(owner(), "post", decisionPath, { decision: "declined" })).status).toBe(409);
    // The accountable person cannot read the project-classed one, so it is not there for them; the admin can decide it.
    expect((await call(accountable(), "post", `${recs()}/${state.projectRecommendationId}/decision`, { decision: "declined" })).status).toBe(404);
    expect((await call(owner(), "post", `${recs()}/${randomUUID()}/decision`, { decision: "declined" })).status).toBe(404);
    expect(await activityRows(db, companyId, "evaluation.agent_recommendation_decided")).toHaveLength(1);

    // Pause pauses nothing, and no card moves: a fresh snapshot reuses the stored version.
    const agentNow = await db.select({ status: agents.status, pausedAt: agents.pausedAt }).from(agents).where(eq(agents.id, builder.id)).then((r) => r[0]!);
    expect(agentNow.status).not.toBe("paused");
    expect(agentNow.pausedAt).toBeNull();
    const again = await call(owner(), "post", `${cards()}/${builder.id}/snapshot`, {});
    const cutAfter = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(evaluationScorecards)
      .where(and(eq(evaluationScorecards.companyId, companyId), eq(evaluationScorecards.milestoneId, builder.id)))
      .then((r) => r[0]!.n);
    expect(again.body.snapshot.reused, "recommendations are not card inputs").toBe(true);
    expect(cutAfter).toBe(cutBefore);
  });

  it("6. the manager's record: proposal outcomes, recommendations by decision, and descriptive before/after card sections", async () => {
    // Version 1 was stored in step 3 (before the step 4 application), version 2 in step 5 (after it).
    const record = await call(owner(), "get", recordPath());
    expect(record.status, JSON.stringify(record.body)).toBe(200);
    expect(record.body).toMatchObject({ kind: "performance_manager_record", managerAgentId: chief.id, isEffectiveManager: true });
    expect(record.body.proposals).toMatchObject({ filed: 3, pending: 0, approved: 1, rejected: 1, withdrawn: 1, editedByOwnerBeforeDeciding: 1, applied: 1 });
    expect(record.body.proposals.items.map((i: Body) => i.outcome)).toEqual(["rejected", "withdrawn", "applied"]);
    expect(record.body.proposals.items.map((i: Body) => i.editedByOwnerBeforeDeciding)).toEqual([false, false, true]);
    expect(record.body.recommendations.total).toBe(2);
    expect(record.body.recommendations.byKind.pause).toEqual({ total: 1, accepted: 1, declined: 0, undecided: 0 });
    expect(record.body.recommendations.byKind.narrow).toEqual({ total: 1, accepted: 0, declined: 0, undecided: 1 });
    // P4.3: each recommendation, oldest first, beside the tallies.
    expect(record.body.recommendations.items).toEqual([
      { id: state.companyRecommendationId, agentId: builder.id, agentName: "Builder", kind: "pause", at: expect.any(String), decision: "accepted", decidedAt: expect.any(String) },
      { id: state.projectRecommendationId, agentId: builder.id, agentName: "Builder", kind: "narrow", at: expect.any(String), decision: null, decidedAt: null },
    ]);
    const [first] = record.body.recommendations.items;
    expect(Date.parse(first.decidedAt)).toBeGreaterThanOrEqual(Date.parse(first.at));
    expect(record.body.note).toContain("does not say the change caused");
    expect(JSON.stringify(record.body)).not.toMatch(/"score"/);

    expect(record.body.applied).toHaveLength(1);
    const applied = record.body.applied[0];
    expect(applied).toMatchObject({ approvalId: state.approved, agentId: builder.id, affectedResponsibilities: ["work"], before: { version: 1 }, after: { version: 2 } });
    expect(applied.sections).toHaveLength(1);
    expect(applied.sections[0].responsibilityKey).toBe("work");
    expect(applied.sections[0].before).toMatchObject({ cardVersion: 1, obligations: { visibility: "visible" } });
    expect(applied.sections[0].before.obligations.rows.reduce((n: number, r: Body) => n + (r.owed ?? 0), 0)).toBe(2);
    expect(applied.sections[0].after).toMatchObject({ cardVersion: 2 });

    // A member reads it through their own projection: the restricted recommendation and project work are not there.
    const asMember = await call(outsider(), "get", recordPath());
    expect(asMember.status).toBe(200);
    expect(asMember.body.restricted).toBe(true);
    expect(asMember.body.recommendations.total).toBe(1);
    expect(asMember.body.recommendations.items.map((i: Body) => i.id)).toEqual([state.companyRecommendationId]);
    expect(asMember.body.applied[0].sections[0].before.obligations.rows.reduce((n: number, r: Body) => n + (r.owed ?? 0), 0)).toBe(1);
    expect(JSON.stringify(asMember.body)).not.toContain("MGR-2");

    // The manager reads its own record; any other agent is refused.
    expect((await call(asAgent(chief), "get", recordPath())).status).toBe(200);
    expect((await call(asAgent(chief), "get", `${recordPath()}?agentId=${deputy.id}`)).status).toBe(403);
    expect((await call(asAgent(builder), "get", recordPath())).status).toBe(403);
    expect((await call(evaluatorActor(), "get", recordPath())).status).toBe(403);
    // People can read a named agent's record; one with no proposals is empty, not an error.
    const deputyRecord = await call(owner(), "get", `${recordPath()}?agentId=${deputy.id}`);
    expect(deputyRecord.body).toMatchObject({ managerAgentId: deputy.id, isEffectiveManager: false, proposals: { filed: 0 } });
    // A company with no manager says so.
    await db.update(companies).set({ performanceManagerAgentId: deputy.id }).where(eq(companies.id, companyId));
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, deputy.id));
    expect((await call(owner(), "get", recordPath())).status).toBe(404);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, deputy.id));
    await db.update(companies).set({ performanceManagerAgentId: null }).where(eq(companies.id, companyId));
  });
});

// P4.3: the proposer capacity a revision summary carries, read from its approval's payload. Pure.
describe("proposerCapacityOfApproval", () => {
  const manager = { kind: "agent", agentId: "a-1", runId: null, capacity: "performance_manager" };
  it("reads an agent_profile_change payload and a profile hire's profileChange", () => {
    expect(proposerCapacityOfApproval({ type: "agent_profile_change", payload: { proposedBy: manager } })).toBe("performance_manager");
    expect(proposerCapacityOfApproval({ type: "hire_agent", payload: { profileChange: { proposedBy: manager } } })).toBe("performance_manager");
  });
  it("is null for any other proposer, approval type or shape", () => {
    expect(proposerCapacityOfApproval({ type: "agent_profile_change", payload: { proposedBy: { kind: "agent", agentId: "a-1" } } })).toBeNull();
    expect(proposerCapacityOfApproval({ type: "agent_profile_change", payload: { proposedBy: { kind: "user", userId: "u", capacity: "performance_manager" } } })).toBeNull();
    expect(proposerCapacityOfApproval({ type: "hire_agent", payload: { proposedBy: manager } })).toBeNull();
    expect(proposerCapacityOfApproval({ type: "approve_ceo_strategy", payload: { proposedBy: manager } })).toBeNull();
    expect(proposerCapacityOfApproval({ type: "agent_profile_change", payload: null })).toBeNull();
  });
});
