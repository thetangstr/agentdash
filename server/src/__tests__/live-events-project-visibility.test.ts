import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  projectAccess,
  projects,
} from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { liveEventRefs } from "../realtime/live-event-visibility.js";
import { publishLiveEvent } from "../services/live-events.js";
import { logActivity } from "../services/activity-log.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as new (url: string, opts?: { headers?: Record<string, string> }) => {
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  close(): void;
};

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("liveEventRefs", () => {
  const issueId = randomUUID();
  const runId = randomUUID();
  const projectId = randomUUID();
  const base = { id: 1, companyId: "c", createdAt: new Date().toISOString() };

  it("reads issue, project and run references from activity events", () => {
    const refs = liveEventRefs({
      ...base,
      type: "activity.logged",
      payload: { entityType: "issue", entityId: issueId, runId, details: { projectId } },
    });
    expect(refs).toEqual({ issueIds: [issueId], runIds: [runId], projectIds: [projectId], agentIds: [], approvalIds: [], malformed: false });
  });

  it("reads the run from heartbeat events, and the agent from agent events (agent visibility, 2026-09-30)", () => {
    expect(liveEventRefs({ ...base, type: "heartbeat.run.log", payload: { runId } }).runIds).toEqual([runId]);
    // An agent event names no issue, run or project — but it is about an
    // agent, and delivery now depends on the subscriber being able to see it.
    const agentId = randomUUID();
    expect(liveEventRefs({ ...base, type: "agent.status", payload: { agentId } })).toEqual({
      issueIds: [],
      runIds: [],
      projectIds: [],
      agentIds: [agentId],
      approvalIds: [],
      malformed: false,
    });
    // A malformed agent id is simply not a reference; it never fails closed.
    expect(liveEventRefs({ ...base, type: "agent.status", payload: { agentId: "not-an-id" } }).malformed).toBe(false);
  });

  it("reads a deleted issue's project from the issue.deleted event instead of the gone row (GH #863)", () => {
    const refs = liveEventRefs({
      ...base,
      type: "activity.logged",
      payload: { action: "issue.deleted", entityType: "issue", entityId: issueId, details: { projectId } },
    });
    expect(refs).toEqual({ issueIds: [], runIds: [], projectIds: [projectId], agentIds: [], approvalIds: [], malformed: false });
    // No project: nothing to resolve, company-visible like any project-less issue.
    expect(
      liveEventRefs({
        ...base,
        type: "activity.logged",
        payload: { action: "issue.deleted", entityType: "issue", entityId: issueId, details: { projectId: null } },
      }).projectIds,
    ).toEqual([]);
    // An older delete event without the project still resolves the issue (and fails closed).
    expect(
      liveEventRefs({
        ...base,
        type: "activity.logged",
        payload: { action: "issue.deleted", entityType: "issue", entityId: issueId },
      }).issueIds,
    ).toEqual([issueId]);
  });

  it("flags a non-canonical entity id as unresolvable (fail closed)", () => {
    const refs = liveEventRefs({
      ...base,
      type: "activity.logged",
      payload: { entityType: "issue", entityId: "PAP-1" },
    });
    expect(refs.malformed).toBe(true);
  });

  it("reads a project-scoped budget activity event's scope as its project (GH #933)", () => {
    const refs = liveEventRefs({
      ...base,
      type: "activity.logged",
      payload: {
        entityType: "budget_incident",
        entityId: randomUUID(),
        details: { scopeType: "project", scopeId: projectId, amountObserved: 1500 },
      },
    });
    expect(refs).toEqual({ issueIds: [], runIds: [], projectIds: [projectId], agentIds: [], approvalIds: [], malformed: false });
    // Same for a budget_policy row.
    expect(
      liveEventRefs({
        ...base,
        type: "activity.logged",
        payload: {
          entityType: "budget_policy",
          entityId: randomUUID(),
          details: { scopeType: "project", scopeId: projectId, amount: 1000 },
        },
      }).projectIds,
    ).toEqual([projectId]);
    // A project scope with no resolvable id fails closed, like any other
    // unresolvable reference.
    expect(
      liveEventRefs({
        ...base,
        type: "activity.logged",
        payload: {
          entityType: "budget_incident",
          entityId: randomUUID(),
          details: { scopeType: "project", scopeId: "not-a-uuid" },
        },
      }).malformed,
    ).toBe(true);
    // Company- and agent-scoped budget rows name no project — company-visible.
    for (const scopeType of ["company", "agent"]) {
      expect(
        liveEventRefs({
          ...base,
          type: "activity.logged",
          payload: {
            entityType: "budget_policy",
            entityId: randomUUID(),
            details: { scopeType, scopeId: randomUUID() },
          },
        }).projectIds,
      ).toEqual([]);
    }
  });

  it("reads an approval activity event's entity for budget-scope resolution (GH #933)", () => {
    const approvalId = randomUUID();
    const refs = liveEventRefs({
      ...base,
      type: "activity.logged",
      payload: { entityType: "approval", entityId: approvalId },
    });
    // The approval row carries the scope in its payload, so the event only
    // names an approval; resolution to a project happens against the table.
    expect(refs.approvalIds).toEqual([approvalId]);
    // A non-canonical approval id fails closed like the other strict entities.
    expect(
      liveEventRefs({
        ...base,
        type: "activity.logged",
        payload: { entityType: "approval", entityId: "not-a-uuid" },
      }).malformed,
    ).toBe(true);
  });
});

/**
 * GH #830 part A follow-up: the live-events websocket is a read surface like
 * any REST route. An off-list subscriber must not receive activity or run
 * transcript events for an issue in a restricted project; on-list principals
 * and admins must. Real websocket, real server wiring, real database.
 * Falsification: drop the `shouldDeliver` check in live-events-ws.ts and the
 * "off-list" assertions fail.
 */
describeEmbeddedPostgres("live events respect restricted project visibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let server: Server | null = null;
  let baseUrl = "";

  const COMPANY = randomUUID();
  const OPEN_PROJECT = randomUUID();
  const SECRET_PROJECT = randomUUID();
  const OPEN_ISSUE = randomUUID();
  const SECRET_ISSUE = randomUUID();
  const OPEN_RUN = randomUUID();
  const SECRET_RUN = randomUUID();
  const LEAD_AGENT = randomUUID();
  const OUTSIDE_AGENT = randomUUID();
  const LEAD_TOKEN = `pcp_${randomUUID()}`;
  const OUTSIDE_TOKEN = `pcp_${randomUUID()}`;

  type Client = { events: LiveEvent[]; close: () => void };
  const clients: Client[] = [];

  function hash(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  async function connect(headers: Record<string, string>): Promise<Client> {
    const ws = new WebSocket(`${baseUrl}/api/companies/${COMPANY}/events/ws`, { headers });
    const client: Client = { events: [], close: () => ws.close() };
    ws.on("message", (data) => client.events.push(JSON.parse(data.toString()) as LiveEvent));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    clients.push(client);
    return client;
  }

  const asUser = (userId: string) => connect({ "x-test-user": userId });
  const asAgent = (token: string) => connect({ authorization: `Bearer ${token}` });

  /** Publish a company-wide marker and wait until every client has it: everything before it is decided. */
  async function settle(watch: Client[]) {
    const marker = randomUUID();
    publishLiveEvent({ companyId: COMPANY, type: "agent.status", payload: { agentId: marker } });
    const deadline = Date.now() + 5000;
    while (!watch.every((c) => c.events.some((e) => e.payload.agentId === marker))) {
      if (Date.now() > deadline) throw new Error("marker not delivered");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const sawIssue = (c: Client, issueId: string) =>
    c.events.some((e) => e.type === "activity.logged" && e.payload.entityId === issueId);
  const sawRunLog = (c: Client, runId: string) =>
    c.events.some((e) => e.type === "heartbeat.run.log" && e.payload.runId === runId);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-live-events-visibility-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({ id: COMPANY, name: "Live Visibility Co" });
    for (const [userId, role] of [
      ["admin-user", "admin"],
      ["sam", "member"],
      ["listed-member", "member"],
      ["outsider", "member"],
    ] as const) {
      await db.insert(companyMemberships).values({
        companyId: COMPANY,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: role,
      });
    }
    await db.insert(agents).values([
      { id: LEAD_AGENT, companyId: COMPANY, name: "Lead", role: "general" },
      { id: OUTSIDE_AGENT, companyId: COMPANY, name: "Outside", role: "general" },
    ]);
    await db.insert(agentApiKeys).values([
      { agentId: LEAD_AGENT, companyId: COMPANY, name: "lead", keyHash: hash(LEAD_TOKEN) },
      { agentId: OUTSIDE_AGENT, companyId: COMPANY, name: "outside", keyHash: hash(OUTSIDE_TOKEN) },
    ]);
    await db.insert(projects).values([
      { id: OPEN_PROJECT, companyId: COMPANY, name: "Open project", createdByUserId: "admin-user" },
      {
        id: SECRET_PROJECT,
        companyId: COMPANY,
        name: "Sam's restricted project",
        createdByUserId: "sam",
        visibility: "restricted",
        leadAgentId: LEAD_AGENT,
      },
    ]);
    await db.insert(projectAccess).values([
      { projectId: SECRET_PROJECT, principalType: "agent", principalId: LEAD_AGENT, grantedByUserId: "sam" },
      { projectId: SECRET_PROJECT, principalType: "user", principalId: "listed-member", grantedByUserId: "sam" },
    ]);
    await db.insert(issues).values([
      { id: OPEN_ISSUE, companyId: COMPANY, projectId: OPEN_PROJECT, title: "Open issue", status: "todo" },
      { id: SECRET_ISSUE, companyId: COMPANY, projectId: SECRET_PROJECT, title: "Secret issue", status: "todo" },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: OPEN_RUN, companyId: COMPANY, agentId: LEAD_AGENT, status: "running", contextSnapshot: { issueId: OPEN_ISSUE } },
      { id: SECRET_RUN, companyId: COMPANY, agentId: LEAD_AGENT, status: "running", contextSnapshot: { issueId: SECRET_ISSUE } },
    ]);

    server = createServer();
    setupLiveEventsWebSocketServer(server, db, {
      deploymentMode: "authenticated",
      // Far beyond any test's runtime: no test in this file may rely on the
      // heartbeat re-check. That matters for the agent-visibility generation
      // test below — a change taking effect there can only come from the
      // activity-event-driven generation bump.
      heartbeatIntervalMs: 60 * 60_000,
      resolveSessionFromHeaders: async (headers) => {
        const userId = headers.get("x-test-user");
        if (!userId) return null;
        return {
          session: { id: `session-${userId}`, userId },
          user: { id: userId, email: `${userId}@example.com`, name: userId },
        } as never;
      },
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    baseUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    for (const client of clients) client.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await tempDb?.cleanup();
  });

  it("delivers restricted activity and run logs only to admins, the creator and listed principals", async () => {
    const admin = await asUser("admin-user");
    const creator = await asUser("sam");
    const listed = await asUser("listed-member");
    const outsider = await asUser("outsider");
    const leadAgent = await asAgent(LEAD_TOKEN);
    const outsideAgent = await asAgent(OUTSIDE_TOKEN);
    const all = [admin, creator, listed, outsider, leadAgent, outsideAgent];

    for (const issueId of [OPEN_ISSUE, SECRET_ISSUE]) {
      await logActivity(db, {
        companyId: COMPANY,
        actorType: "user",
        actorId: "sam",
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issueId,
        details: { bodySnippet: `comment on ${issueId}` },
      });
    }
    for (const runId of [OPEN_RUN, SECRET_RUN]) {
      publishLiveEvent({
        companyId: COMPANY,
        type: "heartbeat.run.log",
        payload: { runId, agentId: LEAD_AGENT, ts: new Date().toISOString(), stream: "stdout", chunk: "transcript" },
      });
    }
    await settle(all);

    for (const c of all) {
      expect(sawIssue(c, OPEN_ISSUE)).toBe(true);
      expect(sawRunLog(c, OPEN_RUN)).toBe(true);
    }
    for (const c of [admin, creator, listed, leadAgent]) {
      expect(sawIssue(c, SECRET_ISSUE)).toBe(true);
      expect(sawRunLog(c, SECRET_RUN)).toBe(true);
    }
    for (const c of [outsider, outsideAgent]) {
      expect(sawIssue(c, SECRET_ISSUE)).toBe(false);
      expect(sawRunLog(c, SECRET_RUN)).toBe(false);
      expect(JSON.stringify(c.events)).not.toContain(`comment on ${SECRET_ISSUE}`);
    }
  });

  // GH #933: a budget activity event names its project only in
  // details.scopeId — delivery follows that project, same as a row in the
  // activity feed.
  it("delivers project-scoped budget activity events only to subscribers who can see the project", async () => {
    const admin = await asUser("admin-user");
    const creator = await asUser("sam");
    const listed = await asUser("listed-member");
    const outsider = await asUser("outsider");
    const leadAgent = await asAgent(LEAD_TOKEN);
    const outsideAgent = await asAgent(OUTSIDE_TOKEN);
    const all = [admin, creator, listed, outsider, leadAgent, outsideAgent];

    const secretPolicy = randomUUID();
    const secretIncident = randomUUID();
    const companyPolicy = randomUUID();
    await logActivity(db, {
      companyId: COMPANY,
      actorType: "user",
      actorId: "sam",
      action: "budget.policy_upserted",
      entityType: "budget_policy",
      entityId: secretPolicy,
      details: { scopeType: "project", scopeId: SECRET_PROJECT, scopeName: "Sam's restricted project", amount: 1000 },
    });
    await logActivity(db, {
      companyId: COMPANY,
      actorType: "system",
      actorId: "budget_service",
      action: "budget.hard_threshold_crossed",
      entityType: "budget_incident",
      entityId: secretIncident,
      details: { scopeType: "project", scopeId: SECRET_PROJECT, amountObserved: 1500, amountLimit: 1000 },
    });
    await logActivity(db, {
      companyId: COMPANY,
      actorType: "user",
      actorId: "sam",
      action: "budget.policy_upserted",
      entityType: "budget_policy",
      entityId: companyPolicy,
      details: { scopeType: "company", scopeId: COMPANY, amount: 10_000 },
    });
    await settle(all);

    const saw = (c: Client, entityId: string) =>
      c.events.some((e) => e.type === "activity.logged" && e.payload.entityId === entityId);
    for (const c of all) expect(saw(c, companyPolicy)).toBe(true);
    for (const c of [admin, creator, listed, leadAgent]) {
      expect(saw(c, secretPolicy)).toBe(true);
      expect(saw(c, secretIncident)).toBe(true);
    }
    for (const c of [outsider, outsideAgent]) {
      expect(saw(c, secretPolicy)).toBe(false);
      expect(saw(c, secretIncident)).toBe(false);
      expect(JSON.stringify(c.events)).not.toContain("Sam's restricted project");
    }
  });

  // GH #933 (follow-up to #970): an `approval.*` activity row names only the
  // approval; the feed resolves a budget_override_required approval's payload
  // scope to its project. The socket must apply the same rule — otherwise the
  // row is hidden from the feed but still broadcast live.
  it("delivers approval activity events for a restricted project's budget override only to subscribers who can see it", async () => {
    const admin = await asUser("admin-user");
    const creator = await asUser("sam");
    const listed = await asUser("listed-member");
    const outsider = await asUser("outsider");
    const leadAgent = await asAgent(LEAD_TOKEN);
    const outsideAgent = await asAgent(OUTSIDE_TOKEN);
    const all = [admin, creator, listed, outsider, leadAgent, outsideAgent];

    const secretApproval = randomUUID();
    const openApproval = randomUUID();
    await db.insert(approvals).values([
      {
        id: secretApproval,
        companyId: COMPANY,
        type: "budget_override_required",
        status: "approved",
        payload: {
          scopeType: "project",
          scopeId: SECRET_PROJECT,
          scopeName: "Sam's restricted project",
          budgetAmount: 1_000,
          observedAmount: 1_500,
        },
      },
      {
        id: openApproval,
        companyId: COMPANY,
        type: "budget_override_required",
        status: "pending",
        payload: {
          scopeType: "project",
          scopeId: OPEN_PROJECT,
          scopeName: "Open project",
          budgetAmount: 500,
        },
      },
    ]);
    await logActivity(db, {
      companyId: COMPANY,
      actorType: "user",
      actorId: "sam",
      action: "approval.approved",
      entityType: "approval",
      entityId: secretApproval,
      details: { type: "budget_override_required", linkedIssueIds: [] },
    });
    await logActivity(db, {
      companyId: COMPANY,
      actorType: "user",
      actorId: "sam",
      action: "approval.approved",
      entityType: "approval",
      entityId: openApproval,
      details: { type: "budget_override_required", linkedIssueIds: [] },
    });
    await settle(all);

    const saw = (c: Client, entityId: string) =>
      c.events.some((e) => e.type === "activity.logged" && e.payload.entityId === entityId);
    for (const c of all) expect(saw(c, openApproval)).toBe(true);
    for (const c of [admin, creator, listed, leadAgent]) {
      expect(saw(c, secretApproval)).toBe(true);
    }
    for (const c of [outsider, outsideAgent]) {
      expect(saw(c, secretApproval)).toBe(false);
      expect(JSON.stringify(c.events)).not.toContain("Sam's restricted project");
    }
  });

  it("drops events naming an unknown run for off-list subscribers (fail closed), not for admins", async () => {
    const admin = await asUser("admin-user");
    const outsider = await asUser("outsider");
    const unknownRun = randomUUID();
    publishLiveEvent({
      companyId: COMPANY,
      type: "heartbeat.run.event",
      payload: { runId: unknownRun, agentId: LEAD_AGENT, seq: 1, message: "hidden?" },
    });
    await settle([admin, outsider]);
    expect(admin.events.some((e) => e.payload.runId === unknownRun)).toBe(true);
    expect(outsider.events.some((e) => e.payload.runId === unknownRun)).toBe(false);
  });

  // GH #863 (#868 follow-up): a visible issue's blocker change can name a
  // restricted blocker; the entry is pruned per subscriber, not the event.
  it("prunes a restricted blocker from a visible issue's blockers_updated event for off-list subscribers", async () => {
    const creator = await asUser("sam");
    const outsider = await asUser("outsider");
    const outsideAgent = await asAgent(OUTSIDE_TOKEN);
    await logActivity(db, {
      companyId: COMPANY,
      actorType: "user",
      actorId: "sam",
      action: "issue.blockers_updated",
      entityType: "issue",
      entityId: OPEN_ISSUE,
      details: {
        blockedByIssueIds: [SECRET_ISSUE],
        addedBlockedByIssueIds: [SECRET_ISSUE],
        removedBlockedByIssueIds: [],
        blockedByIssues: [{ id: SECRET_ISSUE, identifier: "SEC-1", title: "Secret issue" }],
        addedBlockedByIssues: [{ id: SECRET_ISSUE, identifier: "SEC-1", title: "Secret issue" }],
        removedBlockedByIssues: [],
      },
    });
    await settle([creator, outsider, outsideAgent]);

    const blockersEvent = (c: Client) =>
      c.events.find((e) => e.type === "activity.logged" && e.payload.action === "issue.blockers_updated");
    expect(JSON.stringify(blockersEvent(creator))).toContain("Secret issue");
    for (const c of [outsider, outsideAgent]) {
      const event = blockersEvent(c);
      expect(event).toBeDefined();
      expect(JSON.stringify(event)).not.toContain("Secret issue");
      expect(JSON.stringify(event)).not.toContain(SECRET_ISSUE);
      expect((event!.payload.details as Record<string, unknown>).blockedByIssues).toEqual([]);
    }
  });

  // GH #863 (#864 follow-up): the issue row is gone when issue.deleted is
  // logged; its project travels on the event, so delivery is decided by it.
  it("delivers issue.deleted, and later run events on the deleted issue, by the issue's last project", async () => {
    const creator = await asUser("sam");
    const outsider = await asUser("outsider");
    const goneOpen = randomUUID();
    const goneSecret = randomUUID();
    const goneOpenRun = randomUUID();
    await db.insert(issues).values([
      { id: goneOpen, companyId: COMPANY, projectId: OPEN_PROJECT, title: "Doomed open", status: "todo" },
      { id: goneSecret, companyId: COMPANY, projectId: SECRET_PROJECT, title: "Doomed secret", status: "todo" },
    ]);
    await db.insert(heartbeatRuns).values({
      id: goneOpenRun,
      companyId: COMPANY,
      agentId: LEAD_AGENT,
      status: "running",
      contextSnapshot: { issueId: goneOpen },
    });
    for (const [issueId, projectId] of [[goneOpen, OPEN_PROJECT], [goneSecret, SECRET_PROJECT]] as const) {
      await db.delete(issues).where(eq(issues.id, issueId));
      await logActivity(db, {
        companyId: COMPANY,
        actorType: "user",
        actorId: "sam",
        action: "issue.deleted",
        entityType: "issue",
        entityId: issueId,
        details: { projectId },
      });
    }
    publishLiveEvent({
      companyId: COMPANY,
      type: "heartbeat.run.log",
      payload: { runId: goneOpenRun, agentId: LEAD_AGENT, ts: new Date().toISOString(), stream: "stdout", chunk: "after delete" },
    });
    await settle([creator, outsider]);

    expect(sawIssue(creator, goneOpen)).toBe(true);
    expect(sawIssue(creator, goneSecret)).toBe(true);
    expect(sawIssue(outsider, goneOpen)).toBe(true);
    expect(sawIssue(outsider, goneSecret)).toBe(false);
    expect(sawRunLog(outsider, goneOpenRun)).toBe(true);
  });

  it("applies an access-list change on the next event, without waiting for a cache TTL", async () => {
    const outsider = await asUser("outsider");
    publishLiveEvent({
      companyId: COMPANY,
      type: "heartbeat.run.log",
      payload: { runId: SECRET_RUN, agentId: LEAD_AGENT, ts: new Date().toISOString(), stream: "stdout", chunk: "before" },
    });
    await settle([outsider]);
    expect(sawRunLog(outsider, SECRET_RUN)).toBe(false);

    await db
      .insert(projectAccess)
      .values({ projectId: SECRET_PROJECT, principalType: "user", principalId: "outsider", grantedByUserId: "sam" });
    await logActivity(db, {
      companyId: COMPANY,
      actorType: "user",
      actorId: "sam",
      action: "project.access_replaced",
      entityType: "project",
      entityId: SECRET_PROJECT,
      details: {},
    });
    publishLiveEvent({
      companyId: COMPANY,
      type: "heartbeat.run.log",
      payload: { runId: SECRET_RUN, agentId: LEAD_AGENT, ts: new Date().toISOString(), stream: "stdout", chunk: "after" },
    });
    await settle([outsider]);
    expect(outsider.events.some((e) => e.type === "heartbeat.run.log" && e.payload.chunk === "after")).toBe(true);
    expect(outsider.events.some((e) => e.type === "heartbeat.run.log" && e.payload.chunk === "before")).toBe(false);
  });

  // GH #937 re-review: the agent-visibility scope is cached on the actor
  // request object; an `agent` (or stewardship / company-default) activity
  // event bumps a per-company generation so the subscriber recomputes the
  // scope on the next event — no heartbeat needed. This server's heartbeat
  // interval is an hour (see beforeAll), so nothing here can have come from
  // a re-check. Falsification: drop the agentScopeGeneration bump in
  // live-event-visibility.ts and the hidden status below is delivered.
  it("applies an agent visibility change on the agent activity event alone, without a heartbeat", async () => {
    const member = await asUser("outsider");
    const admin = await asUser("admin-user");
    const statusOf = (agentId: string, tag: string) =>
      publishLiveEvent({ companyId: COMPANY, type: "agent.status", payload: { agentId, tag } });
    const sawStatus = (c: Client, agentId: string, tag: string) =>
      c.events.some((e) => e.type === "agent.status" && e.payload.agentId === agentId && e.payload.tag === tag);
    const sawAgentEntity = (c: Client, agentId: string) =>
      c.events.some((e) => e.type === "activity.logged" && e.payload.entityId === agentId);

    // A company event with no references is delivered to every subscriber and
    // serializes behind everything before it — once the scope is owner-mode,
    // the usual random-agent marker would itself be filtered out.
    async function barrier(watch: Client[]) {
      const marker = randomUUID();
      publishLiveEvent({
        companyId: COMPANY,
        type: "activity.logged",
        payload: { action: "note.added", entityType: "company", entityId: marker },
      });
      const deadline = Date.now() + 5000;
      while (!watch.every((c) => c.events.some((e) => e.payload.entityId === marker))) {
        if (Date.now() > deadline) throw new Error("barrier not delivered");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    // Warm the member's scope cache: no owner-only agents yet, so it resolves
    // to mode "all" and the probe is delivered.
    const probe = randomUUID();
    statusOf(probe, "warm");
    await barrier([member, admin]);
    expect(sawStatus(member, probe, "warm")).toBe(true);

    // Out of band row insert; the only signal is the agent activity event.
    const hiddenAgent = randomUUID();
    await db.insert(agents).values({
      id: hiddenAgent,
      companyId: COMPANY,
      name: "Hidden",
      role: "general",
      visibility: "owner",
      accountableUserId: "sam",
      createdByUserId: "sam",
    });
    await logActivity(db, {
      companyId: COMPANY,
      actorType: "user",
      actorId: "sam",
      action: "agent.hired",
      entityType: "agent",
      entityId: hiddenAgent,
      details: {},
    });

    statusOf(hiddenAgent, "hidden");
    await barrier([member, admin]);
    // Admin proves the publish really happened; the member's regenerated
    // scope excludes the owner-only agent — even the hire event itself.
    expect(sawStatus(admin, hiddenAgent, "hidden")).toBe(true);
    expect(sawStatus(member, hiddenAgent, "hidden")).toBe(false);
    expect(sawAgentEntity(member, hiddenAgent)).toBe(false);

    // The reverse direction, same mechanism: visible again on the next
    // agent event, still with no heartbeat.
    await db.update(agents).set({ visibility: "company" }).where(eq(agents.id, hiddenAgent));
    await logActivity(db, {
      companyId: COMPANY,
      actorType: "user",
      actorId: "sam",
      action: "agent.updated",
      entityType: "agent",
      entityId: hiddenAgent,
      details: {},
    });
    statusOf(hiddenAgent, "visible");
    await barrier([member, admin]);
    expect(sawStatus(member, hiddenAgent, "visible")).toBe(true);
  });
});
