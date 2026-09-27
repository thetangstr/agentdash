import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import express, { type Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  assistantAccessTokens,
  assistantGrants,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  documents,
  goals,
  issueApprovals,
  issueDocuments,
  issues,
  issueWorkProducts,
  projectAccess,
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
import { assistantRoutes } from "../routes/assistant.js";
import { activityRoutes } from "../routes/activity.js";
import { logActivity } from "../services/activity-log.js";
import {
  mintAssistantLoopbackToken,
  resetAssistantLoopbackTokens,
} from "../services/assistant-loopback.js";
import { resetAssistantWriteLimits } from "../services/assistant-write-limits.js";

/**
 * AgentDash consolidation PR-A — the design's acceptance queries (Rev 3
 * §6.1, A1–A9) as automated tests. Every query rides the REAL path a
 * connected assistant uses: a `tools/call` to /api/mcp/assistant on an OAuth
 * grant, the pcin_ loopback, and the production routers over embedded
 * Postgres. The grant's company is "Yarda"; "KiddoQuest" is a second company
 * the Yarda grant must never see.
 *
 * What these prove is the DATA: provenance is server-derived, changed[] is
 * visibility-filtered and never copies `details`, decisions are scoped
 * honestly, and nothing is written. How ChatGPT phrases an answer is the
 * transcript eval's job (§6.1 Eval), not this file's.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const FOUNDER = randomUUID();
const SAM = randomUUID();
const KINDS = new Set(["human_or_system", "agent_state", "agent_text"]);
const SECRET_DETAIL = "do-not-echo-7f3a";

describeEmbeddedPostgres("consolidation acceptance queries (A1–A9)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let server: http.Server | null = null;
  let baseUrl = "";
  let resourceUri = "";
  let yarda = "";
  let kiddo = "";
  let marco = "";
  let lena = "";
  let theo = "";
  let bookingProject = "";
  let dormantProject = "";
  let secretProject = "";
  let shippedIssue = "";
  let blockedIssue = "";
  let secretIssue = "";
  let linkedApproval = "";
  let hireApproval = "";
  let tempHome = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-consolidation-acceptance-");
    db = createDb(tempDb.connectionString);

    const app: Express = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    const api = express.Router();
    api.use(mcpRoutes());
    api.use(issueRoutes(db, {} as never));
    api.use(projectRoutes(db));
    api.use(agentRoutes(db));
    api.use(assistantRoutes(db));
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
    // The gated hire path writes an instructions bundle; keep it hermetic.
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "consolidation-acceptance-"));
    vi.stubEnv("PAPERCLIP_HOME", tempHome);
    vi.stubEnv("AGENTDASH_DEFAULT_ADAPTER", "");

    yarda = (await db.insert(companies).values({ name: "Yarda", issuePrefix: "YAR" }).returning())[0]!.id;
    kiddo = (await db.insert(companies).values({ name: "KiddoQuest", issuePrefix: "KQ" }).returning())[0]!.id;

    const now = new Date();
    await db.insert(authUsers).values([
      { id: FOUNDER, name: "Kai Founder", email: "kai@yarda.test", createdAt: now, updatedAt: now },
      { id: SAM, name: "Sam Member", email: "sam@yarda.test", createdAt: now, updatedAt: now },
    ]);
    await db.insert(companyMemberships).values([
      { companyId: yarda, principalType: "user", principalId: FOUNDER, status: "active", membershipRole: "owner" },
      { companyId: yarda, principalType: "user", principalId: SAM, status: "active", membershipRole: "member" },
      { companyId: kiddo, principalType: "user", principalId: FOUNDER, status: "active", membershipRole: "owner" },
    ]);

    const seedAgent = (companyId: string, name: string, accountableUserId: string | null) =>
      db
        .insert(agents)
        .values({
          companyId,
          name,
          role: "engineer",
          status: "idle",
          autonomy: accountableUserId ? "autonomous" : "supervised",
          accountableUserId,
          adapterType: "process",
          adapterConfig: { command: "echo" },
        } as never)
        .returning()
        .then((rows) => rows[0]!.id);
    marco = await seedAgent(yarda, "Marco", FOUNDER);
    lena = await seedAgent(yarda, "Lena", FOUNDER);
    theo = await seedAgent(yarda, "Theo", SAM);
    const kqAgent = await seedAgent(kiddo, "Quinn", FOUNDER);

    const goalId = (
      await db
        .insert(goals)
        .values({
          companyId: yarda,
          title: "Grow bookings 20%",
          status: "active",
          level: "company",
          metricDefinition: { target: 20, unit: "%", source: "manual", currentValue: 12 },
        })
        .returning()
    )[0]!.id;

    bookingProject = (
      await db
        .insert(projects)
        .values({
          companyId: yarda,
          name: "Booking flow",
          status: "active",
          description: "Let customers book online",
          goalId,
          leadAgentId: lena,
          createdByUserId: FOUNDER,
        })
        .returning()
    )[0]!.id;
    dormantProject = (
      await db
        .insert(projects)
        .values({ companyId: yarda, name: "Dormant garden", status: "active", createdByUserId: FOUNDER })
        .returning()
    )[0]!.id;
    secretProject = (
      await db
        .insert(projects)
        .values({
          companyId: yarda,
          name: "Secret pricing",
          status: "active",
          visibility: "restricted",
          createdByUserId: FOUNDER,
          leadAgentId: marco,
        })
        .returning()
    )[0]!.id;
    await db.insert(projectAccess).values({
      projectId: secretProject,
      principalType: "agent",
      principalId: marco,
      grantedByUserId: FOUNDER,
    });
    await db.insert(projects).values({ companyId: kiddo, name: "KiddoQuest app", status: "active" });

    const seedIssue = (values: Record<string, unknown>) =>
      db
        .insert(issues)
        .values({ priority: "medium", ...values } as never)
        .returning()
        .then((rows) => rows[0]!.id);
    shippedIssue = await seedIssue({
      companyId: yarda,
      projectId: bookingProject,
      identifier: "YAR-1",
      title: "Ship booking calendar",
      status: "done",
      assigneeAgentId: marco,
      completedAt: new Date(),
    });
    blockedIssue = await seedIssue({
      companyId: yarda,
      projectId: bookingProject,
      identifier: "YAR-2",
      title: "Payment webhook retries",
      status: "blocked",
      assigneeAgentId: marco,
    });
    const reportIssue = await seedIssue({
      companyId: yarda,
      projectId: bookingProject,
      identifier: "YAR-3",
      title: "Weekly booking report",
      status: "todo",
      assigneeAgentId: lena,
    });
    secretIssue = await seedIssue({
      companyId: yarda,
      projectId: secretProject,
      identifier: "YAR-4",
      title: "Secret price experiment",
      status: "blocked",
      assigneeAgentId: theo,
    });
    await seedIssue({
      companyId: yarda,
      projectId: dormantProject,
      identifier: "YAR-5",
      title: "Water the garden",
      status: "todo",
      assigneeAgentId: marco,
      updatedAt: new Date(Date.now() - 10 * 24 * 3_600_000),
    });
    await seedIssue({
      companyId: kiddo,
      identifier: "KQ-1",
      title: "KQ secret roadmap",
      status: "blocked",
      assigneeAgentId: kqAgent,
    });

    await db.insert(issueWorkProducts).values({
      companyId: yarda,
      projectId: bookingProject,
      issueId: shippedIssue,
      type: "pull_request",
      provider: "github",
      title: "feat: booking calendar",
      url: "https://github.example/yarda/pull/7",
      status: "merged",
    } as never);

    // Server-emitted activity. Marco (an agent credential) closed YAR-1;
    // Kai (a person) marked YAR-2 blocked; Theo touched the secret issue.
    await logActivity(db, {
      companyId: yarda,
      actorType: "agent",
      actorId: marco,
      agentId: marco,
      action: "issue.updated",
      entityType: "issue",
      entityId: shippedIssue,
      details: { status: "done", _previous: { status: "in_progress" } },
    });
    await logActivity(db, {
      companyId: yarda,
      actorType: "user",
      actorId: FOUNDER,
      action: "issue.updated",
      entityType: "issue",
      entityId: blockedIssue,
      details: { status: "blocked", note: SECRET_DETAIL },
    });
    await logActivity(db, {
      companyId: yarda,
      actorType: "agent",
      actorId: theo,
      agentId: theo,
      action: "issue.updated",
      entityType: "issue",
      entityId: secretIssue,
      details: { status: "blocked" },
    });
    await logActivity(db, {
      companyId: kiddo,
      actorType: "user",
      actorId: FOUNDER,
      action: "issue.updated",
      entityType: "issue",
      entityId: randomUUID(),
      details: { status: "blocked" },
    });

    // Decisions: one linked to YAR-2 (project), one hire with no issue.
    linkedApproval = (
      await db
        .insert(approvals)
        .values({ companyId: yarda, type: "approve_ceo_strategy", requestedByAgentId: marco, status: "pending", payload: {} })
        .returning()
    )[0]!.id;
    await db.insert(issueApprovals).values({ companyId: yarda, issueId: blockedIssue, approvalId: linkedApproval });
    hireApproval = (
      await db
        .insert(approvals)
        .values({ companyId: yarda, type: "hire_agent", requestedByAgentId: marco, status: "pending", payload: { name: "Nora" } })
        .returning()
    )[0]!.id;

    // Lena's lead report on the project.
    const docId = (
      await db
        .insert(documents)
        .values({
          companyId: yarda,
          title: "Lead report",
          latestBody: "Calendar shipped; webhook retries still blocked on the payment provider.",
          createdByAgentId: lena,
          updatedByAgentId: lena,
          updatedAt: new Date(Date.now() - 90 * 60_000),
        })
        .returning()
    )[0]!.id;
    await db.insert(issueDocuments).values({ companyId: yarda, issueId: reportIssue, documentId: docId, key: "lead-report" });
  }, 120_000);

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
    if (tempHome) await fs.rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  async function grantToken(userId: string, scopes: string[] = ["agentdash:read"], companyId = yarda) {
    const grant = (
      await db
        .insert(assistantGrants)
        .values({
          companyId,
          userId,
          clientId: `client-${randomUUID().slice(0, 8)}`,
          clientName: "ChatGPT",
          redirectHost: "chatgpt.com",
          scopes,
        })
        .returning()
    )[0]!;
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

  async function rpc(token: string, method: string, params?: Record<string, unknown>) {
    const res = await fetch(resourceUri, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    });
    return res.json() as Promise<{ result?: any; error?: unknown }>;
  }

  type Envelope = { status: string; summary: string; data?: any };
  async function call(token: string, name: string, args: Record<string, unknown> = {}) {
    const body = await rpc(token, "tools/call", { name, arguments: args });
    return { raw: body, env: body.result?.structuredContent as Envelope | undefined };
  }

  function sourcesIn(data: any) {
    const rows: any[] = [
      ...data.shipped.items,
      ...data.blockedNow.items,
      ...data.newlyBlocked.items,
      ...data.decisionsWaiting.items,
      ...data.changed.items,
    ];
    return rows;
  }

  it("A1: what changed, what is blocked, what needs my decision — a sourced, linked briefing", async () => {
    const { token } = await grantToken(FOUNDER);
    const { env } = await call(token, "whats_new", { since: "24h", format: "briefing" });
    expect(env?.status).toBe("ok");
    const data = env!.data;

    // The briefing is the summary, ≤600 chars plus the trailing link.
    expect(data.briefing.length).toBeLessThanOrEqual(600);
    expect(env!.summary.startsWith(data.briefing)).toBe(true);
    expect(env!.summary).toMatch(new RegExp(`${baseUrl}/YAR/`));
    expect(data.briefing).toContain("At Yarda since");
    expect(data.briefing).toMatch(/2 decisions wait for you/);
    expect(data.briefing).toMatch(/1 finished/);
    // An agent-set status is attributed as the agent's claim, not a fact.
    expect(data.briefing).toContain("Marco marked it done (agent-set)");
    expect(data.briefing).toContain("“Ship booking calendar”");
    expect(data.briefing).toMatch(/As of \d{4}-/);

    // Every row carries a server-derived kind; every changed/attention row a link.
    for (const row of sourcesIn(data)) expect(KINDS.has(row.source.kind)).toBe(true);
    expect(data.changed.total).toBeGreaterThan(0);
    for (const row of data.changed.items) expect(row.link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/YAR\//);
    expect(data.attention.length).toBeGreaterThan(0);
    expect(data.attention.length).toBeLessThanOrEqual(5);
    expect(data.attention.map((a: any) => a.reason)).toEqual(
      [...data.attention.map((a: any) => a.reason)].sort(
        (a: string, b: string) =>
          ["decision_waiting", "blocked", "quiet", "shipped"].indexOf(a) -
          ["decision_waiting", "blocked", "quiet", "shipped"].indexOf(b),
      ),
    );
    for (const item of data.attention) expect(item.link).toBeTruthy();
    expect(data.freshness.asOf).toBe(data.asOf);
    expect(data.freshness.newestRecordAt).toBeTruthy();

    const shipped = data.shipped.items.find((i: any) => i.identifier === "YAR-1");
    expect(shipped.source).toMatchObject({ kind: "agent_state", actor: { type: "agent", name: "Marco" } });
    expect(shipped.titleKind).toBe("agent_text");
    const blocked = data.blockedNow.items.find((i: any) => i.identifier === "YAR-2");
    expect(blocked.source).toMatchObject({ kind: "human_or_system", actor: { type: "user", name: "Kai Founder" } });

    // Company-level call: decisions stay company-wide, labeled as such.
    expect(data.decisionsWaiting.scope).toBe("company");
    expect(data.decisionsWaiting.label).toBe("in Yarda");
  });

  it("whats_new keeps its existing summary unless the briefing is asked for", async () => {
    const { token } = await grantToken(FOUNDER);
    const { env } = await call(token, "whats_new", { since: "24h" });
    expect(env!.summary).toMatch(/^1 thing finished/);
    expect(env!.data.briefing).toBeTruthy();
  });

  it("A2: a project call returns only that project's rows and splits linked from company-level decisions", async () => {
    const { token } = await grantToken(FOUNDER);
    const { env } = await call(token, "whats_new", { project: "Booking flow", since: "24h" });
    const data = env!.data;
    expect(data.scope).toMatchObject({ type: "project", project: "Booking flow" });
    expect(data.changed.total).toBeGreaterThan(0);
    for (const row of data.changed.items) expect(row.project).toBe("Booking flow");
    expect(JSON.stringify(data.changed)).not.toContain("Secret price experiment");

    expect(data.decisionsWaiting.linked.items.map((d: any) => d.approvalId)).toEqual([linkedApproval]);
    expect(data.decisionsWaiting.linked.items[0].issueRef).toBe("YAR-2");
    expect(data.decisionsWaiting.companyLevel.items.map((d: any) => d.approvalId)).toEqual([hireApproval]);
    expect(data.decisionsWaiting.companyLevel.label).toBe("company-level, not tied to Booking flow");
    expect(data.briefing).toContain("company-level, not tied to Booking flow");
  });

  it("A3: every clause maps to a kind, and no agent claim is presented as a record", async () => {
    const { token } = await grantToken(FOUNDER);
    const { env } = await call(token, "whats_new", { since: "24h" });
    for (const row of sourcesIn(env!.data)) {
      expect(KINDS.has(row.source.kind)).toBe(true);
      if (row.source.actor.type === "agent") expect(row.source.kind).toBe("agent_state");
      if (row.source.actor.type === "unknown") expect(row.source.kind).toBe("agent_state");
    }
    for (const row of env!.data.changed.items) {
      if (row.title) expect(row.titleKind).toBe("agent_text");
    }
  });

  it("A4: get_project adds linkedGoal and leadReport and keeps the goal string", async () => {
    const { token } = await grantToken(FOUNDER);
    const { env } = await call(token, "get_project", { project: "Booking flow" });
    const project = env!.data.project;
    expect(project.goal).toBe("Let customers book online");
    expect(project.lead).toBe("Lena");
    expect(project.linkedGoal).toMatchObject({ title: "Grow bookings 20%", status: "active", metric: { target: 20, unit: "%", current: 12 } });
    expect(project.leadReport).toMatchObject({ author: "Lena", kind: "agent_text", agentWrote: true, issueRef: "YAR-3" });
    expect(project.leadReport.ageMinutes).toBeGreaterThanOrEqual(89);
    expect(project.leadReport.link).toContain("/YAR/issues/YAR-3");
    expect(project.notes).toEqual([]);
    expect(env!.data.counts).toMatchObject({ done: 1, blocked: 1, todo: 1 });

    const bare = await call(token, "get_project", { project: "Dormant garden" });
    expect(bare.env!.data.project.linkedGoal).toBeNull();
    expect(bare.env!.data.project.leadReport).toBeNull();
    expect(bare.env!.data.project.notes).toEqual(["no goal linked", "no lead report on file"]);
  });

  it("A5: a project with open work and nothing recorded for 3 days is quiet, and nothing is invented", async () => {
    const { token } = await grantToken(FOUNDER);
    const { env } = await call(token, "whats_new", { project: "Dormant garden", since: "24h" });
    const data = env!.data;
    expect(data.freshness).toMatchObject({ quiet: true, quietDays: 3, newestRecordAt: null });
    expect(data.freshness.quietReason).toBe("1 open task, no recorded activity in the last 3 days");
    expect(data.changed.total).toBe(0);
    expect(data.shipped.total).toBe(0);
    expect(data.blockedNow.total).toBe(0);
    expect(data.attention.filter((a: any) => a.reason === "shipped" || a.reason === "blocked")).toEqual([]);
    expect(data.attention.some((a: any) => a.reason === "quiet")).toBe(true);
    expect(data.briefing).toContain("Quiet: 1 open task");
  });

  it("nothing changed: an empty window reports zero, not a guess", async () => {
    const { token } = await grantToken(FOUNDER);
    const future = new Date(Date.now() + 60_000).toISOString();
    const { env } = await call(token, "whats_new", { since: future });
    expect(env!.data.changed.total).toBe(0);
    expect(env!.data.shipped.total).toBe(0);
    expect(env!.summary).toMatch(/^Nothing finished/);
    expect(env!.data.briefing).toContain("0 recorded changes");
    expect(env!.data.briefing).toContain("nothing finished");
  });

  it("A6: the Yarda grant never sees KiddoQuest", async () => {
    const { token } = await grantToken(FOUNDER);
    const scoped = await call(token, "whats_new", { project: "KiddoQuest app" });
    expect(scoped.env!.status).toBe("not_found");
    const found = await call(token, "find_work", { query: "KQ secret" });
    expect(found.env!.data.total).toBe(0);
    const all = await call(token, "whats_new", { since: "7d" });
    const wire = JSON.stringify(all.raw);
    expect(wire).not.toContain("KiddoQuest");
    expect(wire).not.toContain("KQ secret");
    expect(wire).not.toContain(kiddo);

    // The digest route itself refuses another company's project id.
    const loopback = mintAssistantLoopbackToken({
      userId: FOUNDER,
      companyId: yarda,
      membershipRole: "owner",
      grantId: randomUUID(),
      scopes: ["agentdash:read"],
      clientName: "ChatGPT",
    });
    const kqProject = await db.select().from(projects).where(eq(projects.companyId, kiddo)).then((r) => r[0]!.id);
    const res = await fetch(`${baseUrl}/api/companies/${yarda}/assistant/digest?projectId=${kqProject}`, {
      headers: { authorization: `Bearer ${loopback}` },
    });
    expect(res.status).toBe(404);
  });

  it("A7: a restricted project is not_found and leaks nothing into company-level answers", async () => {
    const { token, grant } = await grantToken(SAM);
    const scoped = await call(token, "whats_new", { project: "Secret pricing" });
    expect(scoped.env!.status).toBe("not_found");

    const all = await call(token, "whats_new", { since: "7d" });
    const data = all.env!.data;
    const wire = JSON.stringify(all.raw);
    expect(wire).not.toContain("Secret price experiment");
    expect(wire).not.toContain("Secret pricing");
    expect(wire).not.toContain(secretIssue);
    // Theo answers to Sam, yet his task in the restricted project is absent.
    expect(data.agentsAnsweredFor).toBe(1);
    expect(data.blockedNow.total).toBe(0);
    for (const row of data.changed.items) expect(row.project).not.toBe("Secret pricing");

    const loopback = mintAssistantLoopbackToken({
      userId: SAM,
      companyId: yarda,
      membershipRole: "member",
      grantId: grant.id,
      scopes: ["agentdash:read"],
      clientName: "ChatGPT",
    });
    const res = await fetch(`${baseUrl}/api/companies/${yarda}/assistant/digest?projectId=${secretProject}`, {
      headers: { authorization: `Bearer ${loopback}` },
    });
    expect(res.status).toBe(404);
  });

  it("A8: a read grant cannot write — the work tools are not advertised and a call changes nothing", async () => {
    const { token } = await grantToken(FOUNDER, ["agentdash:read"]);
    const listed = await rpc(token, "tools/list");
    const names = (listed.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("whats_new");
    expect(names).toContain("get_project");
    for (const name of ["start_project", "create_work_item", "assign_work", "comment_on_work", "update_work_item"]) {
      expect(names).not.toContain(name);
    }
    const before = await db.select().from(issues).where(eq(issues.companyId, yarda));
    const attempt = await call(token, "comment_on_work", { item: "YAR-1", body: "tell Marco to ship it" });
    expect(attempt.raw.result?.isError).toBe(true);
    const after = await db.select().from(issues).where(eq(issues.companyId, yarda));
    expect(after.length).toBe(before.length);
  });

  it("A9: a forged manual activity row never renders as a human/system record, and its details never leak", async () => {
    // A board user posts through the real manual activity route, claiming
    // to be the system and claiming YAR-1 was closed.
    const board = express();
    board.use(express.json());
    board.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: FOUNDER,
        companyIds: [yarda],
        source: "session",
        isInstanceAdmin: false,
        memberships: [{ companyId: yarda, membershipRole: "owner", status: "active" }],
      };
      next();
    });
    board.use("/api", activityRoutes(db));
    board.use(errorHandler);
    const boardServer = http.createServer(board);
    await new Promise<void>((resolve) => boardServer.listen(0, "127.0.0.1", resolve));
    const boardPort = (boardServer.address() as { port: number }).port;
    try {
      const posted = await fetch(`http://127.0.0.1:${boardPort}/api/companies/${yarda}/activity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actorType: "system",
          actorId: "system",
          action: "issue.updated",
          entityType: "issue",
          entityId: shippedIssue,
          details: { status: "done", verifiedBy: SECRET_DETAIL },
        }),
      });
      expect(posted.status).toBe(201);
    } finally {
      await new Promise<void>((resolve) => boardServer.close(() => resolve()));
    }
    const [forged] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.origin, "manual"));
    expect(forged).toMatchObject({ actorType: "user", actorId: FOUNDER, origin: "manual" });

    const { token } = await grantToken(FOUNDER);
    const { env, raw } = await call(token, "whats_new", { since: "24h", format: "briefing" });
    const data = env!.data;
    const forgedRow = data.changed.items.find((row: any) => row.source.id === shippedIssue && row.source.actor.type === "user");
    expect(forgedRow).toBeTruthy();
    expect(forgedRow.source.kind).toBe("agent_state");
    // The status provenance of YAR-1 now reads the manual row — still not a record.
    const shipped = data.shipped.items.find((i: any) => i.identifier === "YAR-1");
    expect(shipped.source.kind).toBe("agent_state");
    expect(data.briefing).toContain("(agent-set)");
    for (const row of sourcesIn(data)) {
      if (row.source.kind === "human_or_system") expect(row.source.id).not.toBe(shippedIssue);
    }
    // `details` is never copied into the answer (redaction scan).
    expect(JSON.stringify(raw)).not.toContain(SECRET_DETAIL);
    expect(JSON.stringify(raw)).not.toContain("verifiedBy");
  });

  // PR-C security review: an M3 work-tool call through a grant is logged by
  // the real route as actor "user" with origin "server" and details.via — it
  // must surface as "via assistant", never as a human/system record.
  it("an M3 tool call through a grant is shown as via assistant, never human_or_system", async () => {
    const viaIssue = (
      await db
        .insert(issues)
        .values({ companyId: yarda, identifier: "YAR-9", title: "Confirm vendor list", status: "todo", priority: "medium", assigneeAgentId: marco } as never)
        .returning()
    )[0]!.id;
    const { token } = await grantToken(FOUNDER, ["agentdash:read", "agentdash:work"]);
    const update = await call(token, "update_work_item", { ref: "YAR-9", status: "done" });
    expect(update.env?.status).toBe("ok");

    const [logged] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, viaIssue));
    expect(logged).toMatchObject({ actorType: "user", actorId: FOUNDER, origin: "server" });
    expect(String((logged!.details as Record<string, unknown>).via)).toMatch(/^assistant_grant /);

    const { env } = await call(token, "whats_new", { since: "24h", format: "briefing" });
    const shipped = env!.data.shipped.items.find((i: any) => i.identifier === "YAR-9");
    expect(shipped.source).toMatchObject({ kind: "agent_state", via: "assistant", actor: { type: "user", name: "Kai Founder" } });
    const changedRows = env!.data.changed.items.filter((row: any) => row.source.id === viaIssue);
    expect(changedRows.length).toBeGreaterThan(0);
    for (const row of changedRows) {
      expect(row.source.via).toBe("assistant");
      expect(row.source.kind).not.toBe("human_or_system");
    }
    for (const row of sourcesIn(env!.data)) {
      if (row.source.via === "assistant") expect(row.source.kind).not.toBe("human_or_system");
    }
  });

  // Review H2 (#827): decisions and hires confirmed through the M4 gated path
  // are the assistant's doing — shown "via assistant", never human_or_system.
  const DECIDE = ["agentdash:read", "agentdash:work", "agentdash:decide"];

  it("a decision confirmed through confirm_action shows as via assistant", async () => {
    const approvalId = (
      await db
        .insert(approvals)
        .values({ companyId: yarda, type: "approve_ceo_strategy", requestedByAgentId: marco, status: "pending", payload: {} })
        .returning()
    )[0]!.id;
    const { token } = await grantToken(FOUNDER, DECIDE);
    const prep = await call(token, "prepare_decision", { approval: approvalId, decision: "approve" });
    expect(prep.env?.status, prep.env?.summary).toBe("ok");
    const conf = await call(token, "confirm_action", { handle: prep.env!.data.handle, personSaid: "yes, approve it" });
    expect(conf.env?.status, conf.env?.summary).toBe("ok");

    const [logged] = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, approvalId), eq(activityLog.action, "approval.approved")));
    expect(logged).toMatchObject({ actorType: "user", actorId: FOUNDER, origin: "server" });
    expect(String((logged!.details as Record<string, unknown>).via)).toMatch(/^assistant_grant /);

    const { env } = await call(token, "whats_new", { since: "24h" });
    const row = env!.data.changed.items.find(
      (item: any) => item.source.id === approvalId && item.action === "approval.approved",
    );
    expect(row).toBeTruthy();
    expect(row.source).toMatchObject({ kind: "agent_state", via: "assistant", actor: { type: "user", name: "Kai Founder" } });
  });

  it("a hire requested through request_hire shows as via assistant", async () => {
    await db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, yarda));
    try {
      const { token } = await grantToken(FOUNDER, DECIDE);
      const prep = await call(token, "request_hire", { role: "designer", reason: "booking pages need a refresh" });
      expect(prep.env?.status, prep.env?.summary).toBe("ok");
      const conf = await call(token, "confirm_action", { handle: prep.env!.data.handle });
      expect(conf.env?.status, conf.env?.summary).toBe("ok");

      const hire = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.companyId, yarda), eq(approvals.type, "hire_agent"), eq(approvals.requestedByUserId, FOUNDER)))
        .then((rows) => rows[0]!);
      const { env } = await call(token, "whats_new", { since: "24h" });
      const waiting = env!.data.decisionsWaiting.items.find((item: any) => item.approvalId === hire.id);
      expect(waiting.source).toMatchObject({ kind: "agent_state", via: "assistant", actor: { type: "user", name: "Kai Founder" } });
      const created = env!.data.changed.items.find(
        (item: any) => item.source.id === hire.id && item.action === "approval.created",
      );
      expect(created.source).toMatchObject({ kind: "agent_state", via: "assistant" });
      for (const row of sourcesIn(env!.data)) {
        if (row.source.via === "assistant") expect(row.source.kind).not.toBe("human_or_system");
      }
    } finally {
      await db.update(companies).set({ requireBoardApprovalForNewAgents: false }).where(eq(companies.id, yarda));
    }
  });

  it("a pre-PR-C row (origin NULL) shows its author as origin unknown, not its stored name", async () => {
    const legacyIssue = (
      await db
        .insert(issues)
        .values({ companyId: yarda, identifier: "YAR-10", title: "Legacy task", status: "blocked", priority: "medium", assigneeAgentId: marco } as never)
        .returning()
    )[0]!.id;
    // Written the way the old manual POST could: any actor, no origin.
    await db.insert(activityLog).values({
      companyId: yarda,
      actorType: "system",
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: legacyIssue,
      details: { status: "blocked" },
    });
    const { token } = await grantToken(FOUNDER);
    const { env, raw } = await call(token, "whats_new", { since: "24h", format: "briefing" });
    const row = env!.data.changed.items.find((item: any) => item.source.id === legacyIssue);
    expect(row.source).toMatchObject({ kind: "agent_state", origin: "unknown", actor: { type: "unknown", name: null } });
    const blocked = env!.data.blockedNow.items.find((item: any) => item.identifier === "YAR-10");
    expect(blocked.source).toMatchObject({ kind: "agent_state", origin: "unknown", actor: { type: "unknown", name: null } });
    expect(JSON.stringify(raw)).not.toMatch(/"name":"AgentDash"[^}]*"id":"${legacyIssue}"/);
  });

  it("manual free text is clipped and marked user-written; rows naming a missing approval are dropped", async () => {
    const board = express();
    board.use(express.json());
    board.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: FOUNDER,
        companyIds: [yarda],
        source: "session",
        isInstanceAdmin: false,
        memberships: [{ companyId: yarda, membershipRole: "owner", status: "active" }],
      };
      next();
    });
    board.use("/api", activityRoutes(db));
    board.use(errorHandler);
    const boardServer = http.createServer(board);
    await new Promise<void>((resolve) => boardServer.listen(0, "127.0.0.1", resolve));
    const boardPort = (boardServer.address() as { port: number }).port;
    const longAction = `issue.updated ${"x".repeat(300)}`;
    try {
      const posted = await fetch(`http://127.0.0.1:${boardPort}/api/companies/${yarda}/activity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: longAction, entityType: "issue", entityId: blockedIssue }),
      });
      expect(posted.status).toBe(201);
    } finally {
      await new Promise<void>((resolve) => boardServer.close(() => resolve()));
    }
    const ghost = randomUUID();
    await logActivity(db, {
      companyId: yarda,
      actorType: "user",
      actorId: FOUNDER,
      action: "approval.created",
      entityType: "approval",
      entityId: ghost,
    });

    const { token } = await grantToken(FOUNDER);
    const { env, raw } = await call(token, "whats_new", { since: "24h" });
    const manual = env!.data.changed.items.find((item: any) => item.actionKind === "user_text");
    expect(manual).toBeTruthy();
    expect(manual.action.length).toBeLessThanOrEqual(80);
    expect(manual.source).toMatchObject({ kind: "agent_state", origin: "manual" });
    expect(JSON.stringify(raw)).not.toContain("x".repeat(100));
    expect(env!.data.changed.items.some((item: any) => item.source.id === ghost)).toBe(false);
  });
});
