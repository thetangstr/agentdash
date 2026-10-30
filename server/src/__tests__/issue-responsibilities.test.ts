import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentStewardships,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issueResponsibilities,
  issues,
  projectAccess,
  projects,
} from "@paperclipai/db";
import type { IssueResponsibilityDto } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";
import { profileBody, responsibility, seedActiveProfile } from "./helpers/responsibility-fixtures.js";
import { errorHandler } from "../middleware/index.js";
import { issueResponsibilityRoutes } from "../routes/issue-responsibilities.js";
import {
  currentResponsibility,
  mapIssueResponsibility,
  resolveActiveProfileResponsibility,
  responsibilityHistory,
} from "../services/issue-responsibilities.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Actor = Record<string, unknown>;

/**
 * AgentDash: Agent Performance Management gate 2 (P2.4) — responsibility
 * mapping: the interval history, key validation against the ACTIVE profile,
 * who may map, the activity row, and the HTTP boundary.
 */
describeEmbeddedPostgres("issue responsibility mapping", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-responsibilities-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function addUser(companyId: string, membershipRole: string) {
    const userId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: `User ${userId.slice(0, 4)}`, email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole });
    return userId;
  }

  async function addAgent(companyId: string, values: Partial<typeof agents.$inferInsert> & { name: string }) {
    return db
      .insert(agents)
      .values({ companyId, role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: {}, ...values })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seed() {
    // Letters only: identifiers are `<LETTERS>-<n>`.
    const prefix = `IR${Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("")}`;
    const company = await db.insert(companies).values({ name: `Map ${randomUUID()}`, issuePrefix: prefix }).returning().then((r) => r[0]!);
    const ownerUserId = await addUser(company.id, "owner");
    const stewardUserId = await addUser(company.id, "member");
    const accountableUserId = await addUser(company.id, "member");
    const outsiderUserId = await addUser(company.id, "member");

    const writer = await addAgent(company.id, { name: "Writer" });
    const runner = await addAgent(company.id, { name: "Runner", autonomy: "autonomous", accountableUserId });
    const peer = await addAgent(company.id, { name: "Peer" });
    const cos = await addAgent(company.id, { name: "Chief of Staff", role: "chief_of_staff" });
    const unprofiled = await addAgent(company.id, { name: "Unprofiled" });
    await db.insert(agentStewardships).values({ companyId: company.id, agentId: writer.id, userId: stewardUserId, assignedByUserId: ownerUserId });

    const writerProfile = await seedActiveProfile(db, {
      companyId: company.id,
      agentId: writer.id,
      body: profileBody([responsibility("weekly-report"), responsibility("ad-hoc")]),
    });
    const runnerProfile = await seedActiveProfile(db, { companyId: company.id, agentId: runner.id, body: profileBody([responsibility("ops")]) });
    await seedActiveProfile(db, { companyId: company.id, agentId: peer.id, body: profileBody([responsibility("peer-work")]) });

    const issue = await db
      .insert(issues)
      .values({ companyId: company.id, title: "Draft the report", status: "todo", assigneeAgentId: writer.id, identifier: `${prefix}-1`, issueNumber: 1 })
      .returning()
      .then((r) => r[0]!);
    const runnerIssue = await db
      .insert(issues)
      .values({ companyId: company.id, title: "Run ops", status: "todo", assigneeAgentId: runner.id })
      .returning()
      .then((r) => r[0]!);

    const other = await db.insert(companies).values({ name: `Other ${randomUUID()}`, issuePrefix: `OT${randomUUID().slice(0, 6).toUpperCase()}` }).returning().then((r) => r[0]!);
    const foreignIssue = await db.insert(issues).values({ companyId: other.id, title: "Elsewhere", status: "todo" }).returning().then((r) => r[0]!);

    return { company, ownerUserId, stewardUserId, accountableUserId, outsiderUserId, writer, runner, peer, cos, unprofiled, writerProfile, runnerProfile, issue, runnerIssue, foreignIssue, prefix };
  }

  function member(companyId: string, userId: string, membershipRole = "member"): Actor {
    return { type: "board", userId, source: "session", isInstanceAdmin: false, companyIds: [companyId], memberships: [{ companyId, membershipRole, status: "active" }] };
  }

  function agentActor(agentId: string, companyId: string, extra: Actor = {}): Actor {
    return { type: "agent", agentId, companyId, source: "agent_key", principalKind: "agent", readOnly: false, ...extra };
  }

  function app(actor: Actor) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as unknown as { actor: Actor }).actor = { ...actor };
      next();
    });
    server.use("/api", issueResponsibilityRoutes(db));
    server.use(errorHandler);
    return server;
  }

  const path = (companyId: string, issueRef: string) => `/api/companies/${companyId}/issues/${issueRef}/responsibility`;

  const mappingActivity = (companyId: string) =>
    db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.responsibility_mapped"))).orderBy(asc(activityLog.createdAt));

  it("keeps an interval history: a remap closes the current row and opens a new one", async () => {
    const s = await seed();
    const steward = { type: "user" as const, userId: s.stewardUserId, source: "session" };
    const first = await mapIssueResponsibility(db, { companyId: s.company.id, issueId: s.issue.id, agentId: s.writer.id, responsibilityKey: "weekly-report" }, steward);
    expect(first).toMatchObject({ agentId: s.writer.id, responsibilityKey: "weekly-report", profileRevisionId: s.writerProfile.revisionId, mappedBy: "human", mappedByActorId: s.stewardUserId, validTo: null });

    const second = await mapIssueResponsibility(db, { companyId: s.company.id, issueId: s.issue.id, agentId: s.writer.id, responsibilityKey: "ad-hoc", reason: "It was a one-off" }, steward);
    const history = await responsibilityHistory(db, { companyId: s.company.id, issueId: s.issue.id });
    expect(history.map((h) => [h.responsibilityKey, h.validTo === null])).toEqual([["weekly-report", false], ["ad-hoc", true]]);
    expect(history[0]!.validTo).toBe(second.validFrom); // half-open intervals meet exactly
    expect(second.reason).toBe("It was a one-off");
    expect(await currentResponsibility(db, s.issue.id, { companyId: s.company.id })).toEqual(second);
    // Company-scoped reads see nothing through another company.
    expect(await currentResponsibility(db, s.issue.id, { companyId: s.foreignIssue.companyId })).toBeNull();

    // A transfer to another agent closes the old interval too.
    const transferred = await mapIssueResponsibility(db, { companyId: s.company.id, issueId: s.issue.id, agentId: s.runner.id, responsibilityKey: "ops" }, { type: "user", userId: s.ownerUserId, source: "session" });
    const after = await responsibilityHistory(db, { companyId: s.company.id, issueId: s.issue.id });
    expect(after).toHaveLength(3);
    expect(after.filter((h) => h.validTo === null)).toEqual([transferred]);

    // Every write is one activity row naming the previous mapping.
    const activity = await mappingActivity(s.company.id);
    expect(activity).toHaveLength(3);
    expect(activity[1]!.details).toMatchObject({ agentId: s.writer.id, responsibilityKey: "ad-hoc", previous: { responsibilityKey: "weekly-report" }, reason: "It was a one-off" });
    expect(activity[0]).toMatchObject({ actorType: "user", actorId: s.stewardUserId, entityType: "issue", entityId: s.issue.id });
  });

  it("mapping to the current responsibility again writes nothing", async () => {
    const s = await seed();
    const actor = { type: "agent" as const, agentId: s.writer.id };
    const first = await mapIssueResponsibility(db, { companyId: s.company.id, issueId: s.issue.id, agentId: s.writer.id, responsibilityKey: "weekly-report" }, actor);
    const again = await mapIssueResponsibility(db, { companyId: s.company.id, issueId: s.issue.id, agentId: s.writer.id, responsibilityKey: "weekly-report", reason: "again" }, actor);
    expect(again).toEqual(first);
    expect(await responsibilityHistory(db, { companyId: s.company.id, issueId: s.issue.id })).toHaveLength(1);
    expect(await mappingActivity(s.company.id)).toHaveLength(1);
  });

  it("validates the key against the ACTIVE profile revision (422)", async () => {
    const s = await seed();
    const steward = member(s.company.id, s.stewardUserId);
    const unknown = await request(app(steward)).post(path(s.company.id, s.issue.id)).send({ agentId: s.writer.id, responsibilityKey: "not-a-duty" });
    expect(unknown.status).toBe(422);
    expect(unknown.body.details).toMatchObject({ code: "AGENT_PROFILE_UNKNOWN_RESPONSIBILITY", responsibilityKey: "not-a-duty", availableKeys: ["weekly-report", "ad-hoc"] });

    // A newer applied revision replaces the keys: the old key is no longer mappable, the new one is.
    const next = await seedActiveProfile(db, { companyId: s.company.id, agentId: s.writer.id, body: profileBody([responsibility("monthly-report")]), revisionNumber: 2 });
    const stale = await request(app(steward)).post(path(s.company.id, s.issue.id)).send({ agentId: s.writer.id, responsibilityKey: "weekly-report" });
    expect(stale.status).toBe(422);
    const ok = await request(app(steward)).post(path(s.company.id, s.issue.id)).send({ agentId: s.writer.id, responsibilityKey: "monthly-report" });
    expect(ok.status).toBe(200);
    expect((ok.body as IssueResponsibilityDto).profileRevisionId).toBe(next.revisionId);
    expect(await resolveActiveProfileResponsibility(db, { companyId: s.company.id, agentId: s.writer.id, responsibilityKey: "weekly-report" })).toBeNull();

    // No active profile at all: nothing can be mapped yet.
    const owner = member(s.company.id, s.ownerUserId, "owner");
    const none = await request(app(owner)).post(path(s.company.id, s.issue.id)).send({ agentId: s.unprofiled.id, responsibilityKey: "anything" });
    expect(none.status).toBe(422);
    expect(none.body.details).toMatchObject({ code: "AGENT_PROFILE_UNKNOWN_RESPONSIBILITY", availableKeys: [] });

    // A malformed key is a 400 from the shared schema, before any lookup.
    expect((await request(app(steward)).post(path(s.company.id, s.issue.id)).send({ agentId: s.writer.id, responsibilityKey: "Weekly Report" })).status).toBe(400);
    expect(await mappingActivity(s.company.id)).toHaveLength(1);
  });

  it("authorizes the assignee agent, the Chief of Staff, the steward, the accountable person and admins only", async () => {
    const s = await seed();
    const body = { agentId: s.writer.id, responsibilityKey: "weekly-report" };
    const post = (actor: Actor, issueId = s.issue.id, payload: Record<string, unknown> = body) =>
      request(app(actor)).post(path(s.company.id, issueId)).send(payload);

    // The assignee maps to its own responsibilities…
    const self = await post(agentActor(s.writer.id, s.company.id));
    expect(self.status).toBe(200);
    expect(self.body).toMatchObject({ mappedBy: "agent", mappedByActorId: s.writer.id });
    // …but not to another agent's, and an agent that is not the assignee may not map it at all.
    expect((await post(agentActor(s.writer.id, s.company.id), s.issue.id, { agentId: s.peer.id, responsibilityKey: "peer-work" })).status).toBe(403);
    expect((await post(agentActor(s.peer.id, s.company.id), s.issue.id, { agentId: s.peer.id, responsibilityKey: "peer-work" })).status).toBe(403);
    expect((await post(agentActor(s.peer.id, s.company.id), s.issue.id, { agentId: s.writer.id, responsibilityKey: "ad-hoc" })).status).toBe(403);

    // The planner (Chief of Staff) may map any issue for any agent.
    const planner = await post(agentActor(s.cos.id, s.company.id), s.issue.id, { agentId: s.peer.id, responsibilityKey: "peer-work" });
    expect(planner.status).toBe(200);
    expect(planner.body).toMatchObject({ mappedBy: "planner", mappedByActorId: s.cos.id, agentId: s.peer.id });

    // People: the steward of the mapped agent, the accountable person of the mapped agent, an admin.
    expect((await post(member(s.company.id, s.stewardUserId), s.issue.id, { agentId: s.writer.id, responsibilityKey: "ad-hoc" })).status).toBe(200);
    expect((await post(member(s.company.id, s.accountableUserId), s.runnerIssue.id, { agentId: s.runner.id, responsibilityKey: "ops" })).status).toBe(200);
    expect((await post(member(s.company.id, s.ownerUserId, "owner"), s.issue.id)).status).toBe(200);
    // The steward of one agent is not the steward of another; a plain member is nobody here.
    expect((await post(member(s.company.id, s.stewardUserId), s.runnerIssue.id, { agentId: s.runner.id, responsibilityKey: "ops" })).status).toBe(403);
    expect((await post(member(s.company.id, s.outsiderUserId))).status).toBe(403);
    // The read-only evaluator principal never maps.
    expect((await post(agentActor(s.cos.id, s.company.id, { principalKind: "evaluator", readOnly: true }))).status).toBe(403);

    // Refusals write no mapping and no mapping activity.
    const history = await responsibilityHistory(db, { companyId: s.company.id, issueId: s.issue.id });
    expect(history.map((h) => h.mappedBy)).toEqual(["agent", "planner", "human", "human"]);
    expect(await mappingActivity(s.company.id)).toHaveLength(5);
  });

  it("treats another company's issue, a hidden project's issue and a hidden agent as nonexistent (404)", async () => {
    const s = await seed();
    const owner = member(s.company.id, s.ownerUserId, "owner");
    expect((await request(app(owner)).post(path(s.company.id, s.foreignIssue.id)).send({ agentId: s.writer.id, responsibilityKey: "ad-hoc" })).status).toBe(404);
    expect((await request(app(owner)).get(path(s.company.id, s.foreignIssue.id))).status).toBe(404);
    expect((await request(app(member(s.company.id, s.outsiderUserId))).post(path(s.foreignIssue.companyId, s.issue.id)).send({ agentId: s.writer.id, responsibilityKey: "ad-hoc" })).status).toBe(403);

    const restricted = await db.insert(projects).values({ companyId: s.company.id, name: "Payroll", visibility: "restricted" }).returning().then((r) => r[0]!);
    await db.insert(projectAccess).values({ projectId: restricted.id, principalType: "user", principalId: s.stewardUserId, grantedByUserId: s.ownerUserId });
    const hiddenIssue = await db.insert(issues).values({ companyId: s.company.id, projectId: restricted.id, title: "Salaries", status: "todo", assigneeAgentId: s.runner.id }).returning().then((r) => r[0]!);
    const accountable = member(s.company.id, s.accountableUserId);
    expect((await request(app(accountable)).post(path(s.company.id, hiddenIssue.id)).send({ agentId: s.runner.id, responsibilityKey: "ops" })).status).toBe(404);
    expect((await request(app(accountable)).get(path(s.company.id, hiddenIssue.id))).status).toBe(404);

    const hiddenAgent = await addAgent(s.company.id, { name: "Hidden", visibility: "owner", createdByUserId: s.ownerUserId });
    expect((await request(app(member(s.company.id, s.stewardUserId))).post(path(s.company.id, s.issue.id)).send({ agentId: hiddenAgent.id, responsibilityKey: "ad-hoc" })).status).toBe(404);

    expect(await db.select().from(issueResponsibilities)).toHaveLength(0);
  });

  it("serves the current mapping and the history, and accepts the issue identifier", async () => {
    const s = await seed();
    const viewer = agentActor(s.peer.id, s.company.id);
    const empty = await request(app(viewer)).get(path(s.company.id, s.issue.id));
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ current: null, history: [] });

    const writer = agentActor(s.writer.id, s.company.id);
    const mapped = await request(app(writer)).post(path(s.company.id, `${s.prefix}-1`)).send({ agentId: s.writer.id, responsibilityKey: "ad-hoc", reason: "Started the draft" });
    expect(mapped.status).toBe(200);
    expect(mapped.body).toMatchObject({ issueId: s.issue.id, responsibilityKey: "ad-hoc", reason: "Started the draft" });

    const read = await request(app(viewer)).get(path(s.company.id, `${s.prefix.toLowerCase()}-1`));
    expect(read.status).toBe(200);
    expect(read.body.current).toEqual(mapped.body);
    expect(read.body.history).toEqual([mapped.body]);
  });
});
