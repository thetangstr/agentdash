import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agents,
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
    expect(refs).toEqual({ issueIds: [issueId], runIds: [runId], projectIds: [projectId], agentIds: [], malformed: false });
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
      malformed: false,
    });
    // A malformed agent id is simply not a reference; it never fails closed.
    expect(liveEventRefs({ ...base, type: "agent.status", payload: { agentId: "not-an-id" } }).malformed).toBe(false);
  });

  it("flags a non-canonical entity id as unresolvable (fail closed)", () => {
    const refs = liveEventRefs({
      ...base,
      type: "activity.logged",
      payload: { entityType: "issue", entityId: "PAP-1" },
    });
    expect(refs.malformed).toBe(true);
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
});
