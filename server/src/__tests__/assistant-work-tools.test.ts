import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import express, { type Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  assistantAccessTokens,
  assistantGrants,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  issues,
  issueComments,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { mcpRoutes } from "../routes/mcp.js";
import { issueRoutes } from "../routes/issues.js";
import { projectRoutes } from "../routes/projects.js";
import { agentRoutes } from "../routes/agents.js";
import {
  mintAssistantLoopbackToken,
  resetAssistantLoopbackTokens,
} from "../services/assistant-loopback.js";
import { resetAssistantWriteLimits } from "../services/assistant-write-limits.js";

/**
 * GH #678 acceptance: the five M3 work tools ride real REST routes end to
 * end — a `tools/call` POST to /api/mcp/assistant mints the pcin_ loopback,
 * the middleware's write gate (allowlist + agentdash:work + per-grant hourly
 * budget) fires, and the wrapped route mutates with activity attributed to
 * the person `via assistant_grant <client>`.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const USER_ID = randomUUID();

describeEmbeddedPostgres("assistant MCP work tools (M3)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let server: http.Server | null = null;
  let baseUrl = "";
  let resourceUri = "";
  let companyId = "";
  let prefix = "";
  let cosAgentId = "";
  let priyaAgentId = "";
  let projectId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mcp-work-");
    db = createDb(tempDb.connectionString);

    const app: Express = express();
    app.use(express.json());
    app.use(
      actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async () => null,
      }),
    );
    const api = express.Router();
    api.use(mcpRoutes());
    // The tool loopback hits these over real HTTP on the pcin_ credential —
    // mounting the production routers is what makes the write gate's
    // allowlist meaningful.
    api.use(issueRoutes(db, {} as never));
    api.use(projectRoutes(db));
    api.use(agentRoutes(db));
    api.get("/companies/:id", async (req, res) => {
      const row = await db
        .select()
        .from(companies)
        .where(eq(companies.id, req.params.id as string))
        .then((rows) => rows[0]);
      if (!row) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json({ id: row.id, name: row.name, issuePrefix: row.issuePrefix });
    });
    api.get("/companies/:id/people", (_req, res) => {
      res.json({ people: [] });
    });
    api.get("/health", (_req, res) => {
      res.json({ publicBaseUrl: baseUrl });
    });
    app.use("/api", api);
    app.use(errorHandler);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    resourceUri = `${baseUrl}/api/mcp/assistant`;
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", baseUrl);

    const company = await db
      .insert(companies)
      .values({ name: "Work E2E", issuePrefix: "WE" })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
    prefix = company.issuePrefix;

    const now = new Date();
    await db.insert(authUsers).values({
      id: USER_ID,
      name: "Work Person",
      email: "work@example.test",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: USER_ID,
      status: "active",
      membershipRole: "owner",
    });

    const seedAgent = (name: string, role: string) =>
      db
        .insert(agents)
        .values({
          companyId,
          name,
          role,
          status: "idle",
          adapterType: "process",
          adapterConfig: { command: "echo" },
        })
        .returning()
        .then((rows) => rows[0]!);
    cosAgentId = (await seedAgent("Marlowe", "chief_of_staff")).id;
    priyaAgentId = (await seedAgent("Priya", "engineer")).id;

    projectId = (
      await db
        .insert(projects)
        .values({ companyId, name: "Checkout", status: "active" })
        .returning()
        .then((rows) => rows[0]!)
    ).id;
  }, 90_000);

  afterEach(async () => {
    await db.delete(assistantAccessTokens);
    await db.delete(assistantGrants);
    resetAssistantWriteLimits();
    resetAssistantLoopbackTokens();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await tempDb?.cleanup();
  });

  async function grantToken(scopes: string[], clientName = "Muse (Meta)") {
    const grant = await db
      .insert(assistantGrants)
      .values({
        companyId,
        userId: USER_ID,
        clientId: `client-${randomUUID().slice(0, 8)}`,
        clientName,
        redirectHost: "agent.meta.ai",
        scopes,
      })
      .returning()
      .then((rows) => rows[0]!);
    const token = `pcpa_${randomBytes(24).toString("base64url")}`;
    await db.insert(assistantAccessTokens).values({
      tokenHash: createHash("sha256").update(token).digest("hex"),
      grantId: grant.id,
      familyId: randomUUID(),
      resource: resourceUri,
      scopes,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return { token, grant };
  }

  async function callTool(token: string, name: string, args: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}/api/mcp/assistant`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = await res.json();
    return { httpStatus: res.status, result: body.result, error: body.error };
  }

  const envelope = (result: { result?: { structuredContent?: unknown; isError?: boolean } }) =>
    result.result?.structuredContent as {
      status: string;
      summary: string;
      data?: Record<string, unknown>;
      candidates?: Array<{ label: string; ref: string }>;
    };

  async function listTools(token: string) {
    const res = await fetch(`${baseUrl}/api/mcp/assistant`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = await res.json();
    return body.result.tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
  }

  // The assignment wake is fire-and-forget inside the route — poll for the
  // agent_wakeup_requests row instead of racing it. `issueId` (and `source`)
  // disambiguate: a failed claimed run spawns an assignment-recovery wake for
  // the same issue with source "automation", which otherwise sorts latest.
  async function latestWakeFor(agentId: string, issueId?: string, source?: string) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId))
        .orderBy(desc(agentWakeupRequests.requestedAt));
      const row = rows.find(
        (r) =>
          (!issueId || (r.payload as { issueId?: string })?.issueId === issueId) &&
          (!source || r.source === source),
      );
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  it("lists fourteen tools; the five work tools are not read-only and update_work_item is destructive", async () => {
    const { token } = await grantToken(["agentdash:read", "agentdash:work"]);
    const res = await fetch(`${baseUrl}/api/mcp/assistant`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = await res.json();
    const tools = body.result.tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
    expect(tools).toHaveLength(14);
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["start_project", "create_work_item", "assign_work", "comment_on_work", "update_work_item"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint).toBe(false);
    }
    expect(byName.get("update_work_item")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("create_work_item")?.annotations?.destructiveHint).toBe(false);
    expect(byName.get("whoami")?.annotations?.readOnlyHint).toBe(true);
  });

  it("create_work_item files an assigned task, attributes the user via the client, and queues the wake", async () => {
    const { token, grant } = await grantToken(["agentdash:read", "agentdash:work"]);
    const response = await callTool(token, "create_work_item", {
      title: "Wire the payout webhook",
      assignee: "Priya",
      project: "Checkout",
      priority: "high",
    });
    const env = envelope(response);
    expect(env.status).toBe("ok");
    expect(env.summary).toContain("Priya");

    const created = await db
      .select()
      .from(issues)
      .where(eq(issues.title, "Wire the payout webhook"))
      .then((rows) => rows[0]!);
    expect(created.assigneeAgentId).toBe(priyaAgentId);
    expect(created.projectId).toBe(projectId);
    expect(created.status).toBe("todo");
    expect(created.createdByUserId).toBe(USER_ID);

    const activity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "issue.created"), eq(activityLog.entityId, created.id)))
      .orderBy(desc(activityLog.createdAt))
      .then((rows) => rows[0]!);
    expect(activity.actorType).toBe("user");
    expect(activity.actorId).toBe(USER_ID);
    // GH #745 review: the via string names the grant itself, not just the client.
    expect(activity.details?.via).toBe(`assistant_grant ${grant.id} (Muse (Meta))`);
    expect(activity.details?.via).toContain(grant.clientName);

    const wake = await latestWakeFor(priyaAgentId, created.id, "assignment");
    expect(wake).toBeTruthy();
    expect(wake!.status).not.toBe("skipped");
  });

  it("create_work_item \"best fit\" routes to the Chief of Staff", async () => {
    const { token } = await grantToken(["agentdash:read", "agentdash:work"]);
    const response = await callTool(token, "create_work_item", {
      title: "Draft the hiring plan",
      assignee: "best fit",
    });
    const env = envelope(response);
    expect(env.status).toBe("ok");
    const created = await db
      .select()
      .from(issues)
      .where(eq(issues.title, "Draft the hiring plan"))
      .then((rows) => rows[0]!);
    expect(created.assigneeAgentId).toBe(cosAgentId);
  });

  it("an ambiguous assignee changes nothing and returns candidates", async () => {
    await db
      .insert(agents)
      .values({
        companyId,
        name: "Priya",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "echo" },
      });
    const { token } = await grantToken(["agentdash:read", "agentdash:work"]);
    const before = await db.select().from(issues).then((rows) => rows.length);
    const response = await callTool(token, "create_work_item", {
      title: "Ambiguous owner task",
      assignee: "Priya",
    });
    const env = envelope(response);
    expect(env.status).toBe("needs_clarification");
    expect(env.candidates?.length).toBe(2);
    const after = await db.select().from(issues).then((rows) => rows.length);
    expect(after).toBe(before);
  });

  it("start_project creates the project plus a CoS kickoff task", async () => {
    const { token, grant } = await grantToken(["agentdash:read", "agentdash:work"]);
    const response = await callTool(token, "start_project", {
      name: "Billing revamp",
      goal: "Make invoicing not suck",
    });
    const env = envelope(response);
    expect(env.status).toBe("ok");

    const createdProject = await db
      .select()
      .from(projects)
      .where(eq(projects.name, "Billing revamp"))
      .then((rows) => rows[0]!);
    expect(createdProject.leadAgentId).toBe(cosAgentId);

    const kickoff = await db
      .select()
      .from(issues)
      .where(eq(issues.projectId, createdProject.id))
      .then((rows) => rows[0]!);
    expect(kickoff.assigneeAgentId).toBe(cosAgentId);
    expect(kickoff.title).toContain("Billing revamp");

    const activity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "project.created"), eq(activityLog.entityId, createdProject.id)))
      .then((rows) => rows[0]!);
    expect(activity.actorId).toBe(USER_ID);
    expect(activity.details?.via).toBe(`assistant_grant ${grant.id} (Muse (Meta))`);
  });

  it("assign_work moves the task and reports before/after", async () => {
    const issue = await db
      .insert(issues)
      .values({ companyId, title: "Reassign me", status: "todo", assigneeAgentId: priyaAgentId, projectId })
      .returning()
      .then((rows) => rows[0]!);
    const { token } = await grantToken(["agentdash:read", "agentdash:work"]);
    const response = await callTool(token, "assign_work", {
      ref: issue.id,
      agent: "Marlowe",
    });
    const env = envelope(response);
    expect(env.status).toBe("ok");
    const data = env.data as {
      before: { assignee: string | null };
      after: { assignee: string | null };
      wakeQueued: boolean;
    };
    expect(data.before.assignee).toBe("Priya");
    expect(data.after.assignee).toBe("Marlowe");
    expect(data.wakeQueued).toBe(true);

    const stored = await db.select().from(issues).where(eq(issues.id, issue.id)).then((r) => r[0]!);
    expect(stored.assigneeAgentId).toBe(cosAgentId);

    // The nudge can coalesce into the deferred wake the PATCH already queued
    // for this issue — no dedicated row — so match by issueId, not source.
    const wake = await latestWakeFor(cosAgentId, issue.id);
    expect(wake).toBeTruthy();
  });

  it("comment_on_work posts a user-authored comment", async () => {
    const issue = await db
      .insert(issues)
      .values({ companyId, title: "Needs a note", status: "todo", assigneeAgentId: priyaAgentId, projectId })
      .returning()
      .then((rows) => rows[0]!);
    const { token, grant } = await grantToken(["agentdash:read", "agentdash:work"]);
    const response = await callTool(token, "comment_on_work", {
      ref: issue.id,
      text: "Use the sandbox key from 1Password.",
    });
    const env = envelope(response);
    expect(env.status).toBe("ok");
    const commentId = env.data?.commentId as string;
    const comment = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, commentId))
      .then((rows) => rows[0]!);
    expect(comment.issueId).toBe(issue.id);
    expect(comment.body).toBe("Use the sandbox key from 1Password.");
    expect(comment.authorUserId).toBe(USER_ID);

    const activity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "issue.comment_added"), eq(activityLog.entityId, issue.id)))
      .then((rows) => rows[0]!);
    expect(activity.details?.via).toBe(`assistant_grant ${grant.id} (Muse (Meta))`);
  });

  it("update_work_item returns before/after and refuses an empty change", async () => {
    const issue = await db
      .insert(issues)
      .values({ companyId, title: "Move me", status: "todo", priority: "medium", projectId })
      .returning()
      .then((rows) => rows[0]!);
    const { token } = await grantToken(["agentdash:read", "agentdash:work"]);

    const emptyCall = await callTool(token, "update_work_item", { ref: issue.id });
    expect(envelope(emptyCall).status).toBe("refused");

    const response = await callTool(token, "update_work_item", {
      ref: issue.id,
      status: "done",
      priority: "low",
    });
    const env = envelope(response);
    expect(env.status).toBe("ok");
    const data = env.data as { before: { status: string }; after: { status: string; priority: string } };
    expect(data.before.status).toBe("todo");
    expect(data.after.status).toBe("done");
    expect(data.after.priority).toBe("low");
    const stored = await db.select().from(issues).where(eq(issues.id, issue.id)).then((r) => r[0]!);
    expect(stored.status).toBe("done");
  });

  it("a grant without agentdash:work does not see the work tools and still 403s at the gate", async () => {
    const { token, grant } = await grantToken(["agentdash:read"]);
    // GH #745 review: the work tools are hidden entirely for a read-only
    // grant — the tool name is unknown, not politely refused.
    const listed = await listTools(token);
    expect(listed).toHaveLength(9);
    const names = listed.map((t) => t.name);
    for (const name of ["start_project", "create_work_item", "assign_work", "comment_on_work", "update_work_item"]) {
      expect(names).not.toContain(name);
    }
    const response = await callTool(token, "create_work_item", { title: "Should not land" });
    expect(response.result?.isError).toBe(true);
    expect((response.result?.content?.[0] as { text?: string } | undefined)?.text).toMatch(/unknown tool/i);

    const missing = await db.select().from(issues).where(eq(issues.title, "Should not land"));
    expect(missing).toHaveLength(0);

    // The gate itself, directly: a pcin_ credential carrying only
    // agentdash:read must 403 insufficient_scope on the write route.
    const loopback = mintAssistantLoopbackToken({
      userId: USER_ID,
      companyId,
      membershipRole: "owner",
      grantId: grant.id,
      scopes: ["agentdash:read"],
      clientName: "Muse (Meta)",
    });
    const direct = await fetch(`${baseUrl}/api/companies/${companyId}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${loopback}` },
      body: JSON.stringify({ title: "Direct write" }),
    });
    expect(direct.status).toBe(403);
    const body = await direct.json();
    expect(body.error).toBe("insufficient_scope");
    expect(body.required_scope).toBe("agentdash:work");
  });

  it("the loopback write gate refuses routes outside the five allowlisted ones", async () => {
    const { grant } = await grantToken(["agentdash:read", "agentdash:work"]);
    const loopback = mintAssistantLoopbackToken({
      userId: USER_ID,
      companyId,
      membershipRole: "owner",
      grantId: grant.id,
      scopes: ["agentdash:read", "agentdash:work"],
      clientName: "Muse (Meta)",
    });
    // Agent creation is a wrapped-route lookalike that is NOT on the list.
    const res = await fetch(`${baseUrl}/api/companies/${companyId}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${loopback}` },
      body: JSON.stringify({ name: "Sneaky", role: "engineer", adapterType: "process" }),
    });
    expect(res.status).toBe(403);
    // DELETEs are never allowed.
    const del = await fetch(`${baseUrl}/api/issues/${randomUUID()}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${loopback}` },
    });
    expect(del.status).toBe(403);
  });

  it("the eleventh new task in an hour is refused, not a 500", async () => {
    const { grant } = await grantToken(["agentdash:read", "agentdash:work"]);
    const loopback = mintAssistantLoopbackToken({
      userId: USER_ID,
      companyId,
      membershipRole: "owner",
      grantId: grant.id,
      scopes: ["agentdash:read", "agentdash:work"],
      clientName: "Muse (Meta)",
    });
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${baseUrl}/api/companies/${companyId}/issues`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${loopback}` },
        body: JSON.stringify({ title: `Budgeted task ${i}` }),
      });
      expect(res.status).toBe(201);
    }
    const eleventh = await fetch(`${baseUrl}/api/companies/${companyId}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${loopback}` },
      body: JSON.stringify({ title: "One too many" }),
    });
    expect(eleventh.status).toBe(429);
    const body = await eleventh.json();
    expect(body.error).toBe("assistant_write_rate_limited");
    expect(eleventh.headers.get("retry-after")).toBeTruthy();
    const uncreated = await db.select().from(issues).where(eq(issues.title, "One too many"));
    expect(uncreated).toHaveLength(0);
  });

  /** Mint a work-scoped pcin_ directly against the seeded company. */
  function workLoopback(grantId: string, company = companyId) {
    return mintAssistantLoopbackToken({
      userId: USER_ID,
      companyId: company,
      membershipRole: "owner",
      grantId,
      scopes: ["agentdash:read", "agentdash:work"],
      clientName: "Muse (Meta)",
    });
  }

  async function boardToken() {
    const token = `pcp_board_${randomBytes(24).toString("hex")}`;
    await db.insert(boardApiKeys).values({
      userId: USER_ID,
      name: "test board key",
      keyHash: createHash("sha256").update(token).digest("hex"),
    });
    return token;
  }

  const postIssues = (token: string, body: Record<string, unknown>, path = `/api/companies/${companyId}/issues`) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  describe("idempotent writes (GH #745 review)", () => {
    it("a retried issue create with requestId replays the original row, never a duplicate", async () => {
      const { grant } = await grantToken(["agentdash:read", "agentdash:work"]);
      const loopback = workLoopback(grant.id);
      const body = { title: `Dedup ${randomUUID().slice(0, 8)}`, requestId: `req-${randomUUID()}` };

      const first = await postIssues(loopback, body);
      expect(first.status).toBe(201);
      const created = await first.json();

      const second = await postIssues(loopback, body);
      expect(second.status).toBe(200);
      const replayed = await second.json();
      expect(replayed.id).toBe(created.id);
      expect(replayed.replayed).toBe(true);

      const rows = await db.select().from(issues).where(eq(issues.title, body.title));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.originKind).toBe("assistant_work");
      expect(rows[0]!.originId).toBe(body.requestId);
    });

    it("a retried issue create WITHOUT requestId dedupes on the derived windowed key", async () => {
      const { grant } = await grantToken(["agentdash:read", "agentdash:work"]);
      const loopback = workLoopback(grant.id);
      const body = { title: `Derived dedup ${randomUUID().slice(0, 8)}` };

      const first = await postIssues(loopback, body);
      expect(first.status).toBe(201);
      const created = await first.json();

      const second = await postIssues(loopback, body);
      expect(second.status).toBe(200);
      const replayed = await second.json();
      expect(replayed.id).toBe(created.id);
      expect(replayed.replayed).toBe(true);
      expect(await db.select().from(issues).where(eq(issues.title, body.title))).toHaveLength(1);
    });

    it("requestId is refused on non-assistant writes and on PATCH/children", async () => {
      const board = await boardToken();
      const direct = await postIssues(board, { title: "Board create", requestId: "squat-1" });
      expect(direct.status).toBe(400);

      const parent = await db
        .insert(issues)
        .values({ companyId, title: "Parent", status: "todo" })
        .returning()
        .then((rows) => rows[0]!);
      const patch = await fetch(`${baseUrl}/api/issues/${parent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${board}` },
        body: JSON.stringify({ status: "done", requestId: "squat-2" }),
      });
      expect(patch.status).toBe(400);
      const child = await fetch(`${baseUrl}/api/issues/${parent.id}/children`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${board}` },
        body: JSON.stringify({ title: "Child", requestId: "squat-3" }),
      });
      expect(child.status).toBe(400);
    });

    it("a retried start_project reuses the project and finishes — never duplicates — the kickoff", async () => {
      const { token } = await grantToken(["agentdash:read", "agentdash:work"]);
      const name = `Retry project ${randomUUID().slice(0, 8)}`;

      const first = await callTool(token, "start_project", { name });
      expect(envelope(first).status).toBe("ok");
      const second = await callTool(token, "start_project", { name });
      const env = envelope(second);
      expect(env.status).toBe("ok");
      const data = env.data as { projectReused?: boolean; kickoffReplayed?: boolean };
      expect(data.projectReused).toBe(true);
      expect(data.kickoffReplayed).toBe(true);

      const named = await db.select().from(projects).where(eq(projects.name, name));
      expect(named).toHaveLength(1);
      const kickoffs = await db
        .select()
        .from(issues)
        .where(and(eq(issues.projectId, named[0]!.id), eq(issues.originKind, "assistant_work")));
      expect(kickoffs).toHaveLength(1);
      expect(kickoffs[0]!.originId).toBe(`start_project:${named[0]!.id}`);
    });

    it("the nudge wakeup replays on its idempotencyKey — one paid wake", async () => {
      const { grant } = await grantToken(["agentdash:read", "agentdash:work"]);
      const loopback = workLoopback(grant.id);
      const key = `nudge-test-${randomUUID()}`;
      const send = () =>
        fetch(`${baseUrl}/api/agents/${priyaAgentId}/wakeup`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${loopback}` },
          body: JSON.stringify({
            source: "on_demand",
            triggerDetail: "manual",
            reason: "nudge",
            payload: { issueId: randomUUID() },
            idempotencyKey: key,
          }),
        });
      const first = await send();
      expect(first.status).toBeLessThan(300);
      const second = await send();
      expect(second.status).toBe(200);
      const replayed = await second.json();
      expect(replayed.replayed).toBe(true);

      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, key));
      expect(rows).toHaveLength(1);
    });
  });

  describe("pcin_ body-field allowlist (GH #745 review)", () => {
    it("rejects fields outside the tool contract before the route runs", async () => {
      const { grant } = await grantToken(["agentdash:read", "agentdash:work"]);
      const loopback = workLoopback(grant.id);
      const attempts: Array<{ method: string; path: string; body: Record<string, unknown>; field: string }> = [
        {
          method: "POST",
          path: `/api/companies/${companyId}/issues`,
          body: { title: "x", assigneeAdapterOverrides: { adapterType: "claude_local" } },
          field: "assigneeAdapterOverrides",
        },
        {
          method: "POST",
          path: `/api/companies/${companyId}/issues`,
          body: { title: "x", env: { SECRET: "1" } },
          field: "env",
        },
        {
          method: "POST",
          path: `/api/companies/${companyId}/issues`,
          body: { title: "x", executionWorkspaceSettings: { mode: "shared" } },
          field: "executionWorkspaceSettings",
        },
        {
          method: "PATCH",
          path: `/api/issues/${randomUUID()}`,
          body: { status: "done", reopen: true },
          field: "reopen",
        },
        {
          method: "POST",
          path: `/api/agents/${priyaAgentId}/wakeup`,
          body: { source: "on_demand", contextSnapshot: { evil: true } },
          field: "contextSnapshot",
        },
        {
          method: "POST",
          path: `/api/issues/${randomUUID()}/comments`,
          body: { body: "hi", authorUserId: randomUUID() },
          field: "authorUserId",
        },
        {
          method: "POST",
          path: `/api/companies/${companyId}/projects`,
          body: { name: "x", env: { KEY: "v" } },
          field: "env",
        },
      ];
      for (const attempt of attempts) {
        const res = await fetch(`${baseUrl}${attempt.path}`, {
          method: attempt.method,
          headers: { "content-type": "application/json", authorization: `Bearer ${loopback}` },
          body: JSON.stringify(attempt.body),
        });
        expect(res.status, `${attempt.method} ${attempt.path} field ${attempt.field}`).toBe(403);
        const body = await res.json();
        expect(body.error).toBe("assistant_write_field_forbidden");
        expect(body.fields).toContain(attempt.field);
      }
    });

    it("the five routes still accept their exact tool bodies", async () => {
      const { grant } = await grantToken(["agentdash:read", "agentdash:work"]);
      const loopback = workLoopback(grant.id);
      const created = await postIssues(loopback, {
        title: `Allowed ${randomUUID().slice(0, 8)}`,
        priority: "high",
        status: "todo",
      });
      expect(created.status).toBe(201);
    });
  });

  describe("pcin_ boundary probes (GH #745 review)", () => {
    it("a work-scoped pcin_ cannot touch another company's issue", async () => {
      const other = await db
        .insert(companies)
        .values({ name: `OtherCo ${randomUUID().slice(0, 8)}`, issuePrefix: `OC${randomUUID().slice(0, 2).toUpperCase()}` })
        .returning()
        .then((rows) => rows[0]!);
      const foreign = await db
        .insert(issues)
        .values({ companyId: other.id, title: "Foreign task", status: "todo" })
        .returning()
        .then((rows) => rows[0]!);
      const { grant } = await grantToken(["agentdash:read", "agentdash:work"]);
      const loopback = workLoopback(grant.id);

      const patch = await fetch(`${baseUrl}/api/issues/${foreign.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${loopback}` },
        body: JSON.stringify({ status: "done" }),
      });
      // The route allowlist passes (the shape is fine); the company pin refuses.
      expect(patch.status).toBe(403);
      const stored = await db.select().from(issues).where(eq(issues.id, foreign.id)).then((r) => r[0]!);
      expect(stored.status).toBe("todo");

      const comment = await fetch(`${baseUrl}/api/issues/${foreign.id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${loopback}` },
        body: JSON.stringify({ body: "cross-company" }),
      });
      expect(comment.status).toBe(403);
    });

    it("encoded, case and trailing-slash path variants cannot slip the allowlist", async () => {
      const { grant } = await grantToken(["agentdash:read", "agentdash:work"]);
      const loopback = workLoopback(grant.id);
      const body = JSON.stringify({ title: `Variant ${randomUUID().slice(0, 8)}` });
      const headers = { "content-type": "application/json", authorization: `Bearer ${loopback}` };

      // Encoded segment %2F: one raw segment, allowlist refuses before the route.
      const encoded = await fetch(`${baseUrl}/api/companies/${companyId}%2Fissues`, {
        method: "POST", headers, body,
      });
      expect(encoded.status).toBe(403);

      // Uppercase path: the allowlist is case-sensitive — refused, not routed.
      const upper = await fetch(`${baseUrl}/API/companies/${companyId}/issues`, {
        method: "POST", headers, body,
      });
      expect(upper.status).toBe(403);

      // Trailing slash: normalized to the allowlisted route — reaches the
      // handler and creates normally, NOT a bypass.
      const slash = await fetch(`${baseUrl}/api/companies/${companyId}/issues/`, {
        method: "POST", headers, body: JSON.stringify({ title: `Slash ${randomUUID().slice(0, 8)}` }),
      });
      expect(slash.status).toBe(201);
    });

    it("the 31st write in an hour surfaces as a refused tools/call, not a raw 429", async () => {
      const { token, grant } = await grantToken(["agentdash:read", "agentdash:work"]);
      const loopback = workLoopback(grant.id);
      const target = await db
        .insert(issues)
        .values({ companyId, title: "Rate sink", status: "todo" })
        .returning()
        .then((rows) => rows[0]!);
      // Comments count against the 30-write budget but not the task-create one.
      for (let i = 0; i < 30; i++) {
        const res = await fetch(`${baseUrl}/api/issues/${target.id}/comments`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${loopback}` },
          body: JSON.stringify({ body: `n${i}` }),
        });
        expect(res.status).toBe(201);
      }
      const title = `Over cap ${randomUUID().slice(0, 8)}`;
      const response = await callTool(token, "create_work_item", { title });
      const env = envelope(response);
      expect(env.status).toBe("refused");
      expect(env.summary).toContain("hourly write limit");
      const uncreated = await db.select().from(issues).where(eq(issues.title, title));
      expect(uncreated).toHaveLength(0);
    });
  });
});
