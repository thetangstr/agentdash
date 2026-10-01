import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import express, { type Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  assistantAccessTokens,
  assistantGrants,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { requestActorSourceMiddleware } from "../lib/request-actor-source.js";
import { mcpRoutes } from "../routes/mcp.js";
import { issueRoutes } from "../routes/issues.js";
import {
  mintAssistantLoopbackToken,
  resetAssistantLoopbackTokens,
} from "../services/assistant-loopback.js";
import { resetAssistantWriteLimits } from "../services/assistant-write-limits.js";

/**
 * AgentDash (Ross launch M2): the assistant's governed Ross request, end to
 * end through the real stack — `tools/call` on /api/mcp/assistant → pcin_
 * loopback write gate (allowlist + agentdash:work + body fields) → the
 * issues router (identifier + A5 project rule) → the canonical comment
 * accept/dispatch pipeline with the request-key check under the issue lock.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const OWNER_ID = randomUUID();
const MEMBER_ID = randomUUID();

describeEmbeddedPostgres("Ross request route + MCP tools (Ross launch M2)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let server: http.Server | null = null;
  let baseUrl = "";
  let resourceUri = "";
  let companyId = "";
  let rossAgentId = "";
  let otherAgentId = "";
  let projectId = "";
  let restrictedProjectId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ross-request-");
    db = createDb(tempDb.connectionString);

    const app: Express = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.use(requestActorSourceMiddleware());
    const api = express.Router();
    api.use(mcpRoutes());
    api.use(issueRoutes(db, {} as never));
    api.get("/companies/:id", async (req, res) => {
      const row = await db.select().from(companies).where(eq(companies.id, req.params.id as string)).then((r) => r[0]);
      if (!row) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json({ id: row.id, name: row.name, issuePrefix: row.issuePrefix });
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

    companyId = (await db.insert(companies).values({ name: "Ross Co", issuePrefix: "RC" }).returning())[0]!.id;
    const now = new Date();
    for (const [id, role] of [[OWNER_ID, "owner"], [MEMBER_ID, "member"]] as const) {
      await db.insert(authUsers).values({ id, name: `${role} person`, email: `${role}@example.test`, createdAt: now, updatedAt: now });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: id, status: "active", membershipRole: role });
    }
    const seedAgent = (name: string) =>
      db
        .insert(agents)
        .values({ companyId, name, role: "general", status: "idle", adapterType: "process", adapterConfig: { command: "echo" } })
        .returning()
        .then((rows) => rows[0]!);
    rossAgentId = (await seedAgent("Ross")).id;
    otherAgentId = (await seedAgent("Echo")).id;
    projectId = (await db.insert(projects).values({ companyId, name: "Launch", status: "active" }).returning())[0]!.id;
    restrictedProjectId = (
      await db
        .insert(projects)
        .values({ companyId, name: "Board only", status: "active", visibility: "restricted", createdByUserId: OWNER_ID })
        .returning()
    )[0]!.id;
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

  async function grantToken(scopes: string[], userId = OWNER_ID) {
    const grant = await db
      .insert(assistantGrants)
      .values({ companyId, userId, clientId: `client-${randomUUID().slice(0, 8)}`, clientName: "Monica", redirectHost: "monica.example.test", scopes })
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

  function loopbackFor(grantId: string, scopes: string[], userId = OWNER_ID, membershipRole = "owner") {
    return mintAssistantLoopbackToken({ origin: { kind: "internal" }, userId, companyId, membershipRole, grantId, scopes, clientName: "Monica" });
  }

  async function mcp(token: string, method: string, params?: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}/api/mcp/assistant`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    });
    return (await res.json()) as { result?: any; error?: unknown };
  }

  async function callTool(token: string, name: string, args: Record<string, unknown>) {
    const body = await mcp(token, "tools/call", { name, arguments: args });
    return body.result?.structuredContent as { status: string; summary: string; data?: Record<string, any> };
  }

  async function seedIssue(values: Partial<typeof issues.$inferInsert> = {}) {
    return db
      .insert(issues)
      .values({ companyId, title: `Ross task ${randomUUID().slice(0, 6)}`, status: "in_progress", assigneeAgentId: rossAgentId, projectId, ...values })
      .returning()
      .then((rows) => rows[0]!);
  }

  const commentsOn = (issueId: string) => db.select().from(issueComments).where(eq(issueComments.issueId, issueId));

  async function wakeFor(commentId: string) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const row = await db
        .select()
        .from(agentWakeupRequests)
        .where(sql`${agentWakeupRequests.payload} ->> 'commentId' = ${commentId}`)
        .then((rows) => rows[0] ?? null);
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  it("lists the request tool only for a work grant, and the status read for every grant", async () => {
    const work = await grantToken(["agentdash:read", "agentdash:work"]);
    const workNames = ((await mcp(work.token, "tools/list")).result.tools as Array<{ name: string; annotations?: Record<string, unknown> }>);
    const request = workNames.find((t) => t.name === "request_ross_assessment");
    expect(request?.annotations?.readOnlyHint).toBe(false);
    expect(workNames.map((t) => t.name)).toContain("ross_request_status");

    const read = await grantToken(["agentdash:read"]);
    const readNames = ((await mcp(read.token, "tools/list")).result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(readNames).not.toContain("request_ross_assessment");
    expect(readNames).toContain("ross_request_status");

    // The gate itself: a read-only loopback cannot reach the write route.
    const issue = await seedIssue();
    const direct = await fetch(`${baseUrl}/api/issues/${issue.id}/ross-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${loopbackFor(read.grant.id, ["agentdash:read"])}` },
      body: JSON.stringify({ requestKey: "req-readonly-01", question: "Can I?" }),
    });
    expect(direct.status).toBe(403);
    expect((await direct.json()).required_scope).toBe("agentdash:work");
    expect(await commentsOn(issue.id)).toHaveLength(0);
  });

  it("files one governed, person-attributed comment whose wake is recorded as automatic (#869)", async () => {
    const issue = await seedIssue();
    const { token, grant } = await grantToken(["agentdash:read", "agentdash:work"]);
    const out = await callTool(token, "request_ross_assessment", { ref: issue.id, question: "Should we cut scope to ship Friday?" });
    expect(out.status).toBe("ok");
    expect(out.data?.requestStatus).toBe("submitted");
    expect(out.data?.inference).toMatchObject({ state: "delegated-to-native-run-gates", startedByThisCall: false });
    expect(out.data?.attribution).toMatchObject({ verified: true, credential: "assistant_grant" });
    expect(out.data?.wake).toMatchObject({ automatic: true });
    const requestKey = out.data?.requestKey as string;

    const rows = await commentsOn(issue.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe(`[ross-assessment-request:${requestKey}]\nShould we cut scope to ship Friday?`);
    expect(rows[0]!.authorUserId).toBe(OWNER_ID);
    expect(rows[0]!.authorAgentId).toBeNull();
    expect(out.data?.receipt.commentId).toBe(rows[0]!.id);

    const activity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "issue.comment_added"), eq(activityLog.entityId, issue.id)))
      .then((r) => r[0]!);
    expect(activity.actorId).toBe(OWNER_ID);
    expect(activity.details?.via).toBe(`assistant_grant ${grant.id} (Monica)`);
    expect(activity.details?.rossRequestKey).toBe(requestKey);

    const wake = await wakeFor(rows[0]!.id);
    expect(wake?.agentId).toBe(rossAgentId);
    expect(wake?.requestedByActorId).toBe(OWNER_ID);
    expect(wake?.runId).toBeTruthy();
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake!.runId!)).then((r) => r[0]!);
    expect(run.contextSnapshot?.requestedByActorSource).toBe("assistant_grant");

    // An identical re-delivery coalesces; a different question on the key conflicts.
    const again = await callTool(token, "request_ross_assessment", { ref: issue.id, question: "Should we cut scope to ship Friday?", requestKey });
    expect(again.data?.requestStatus).toBe("coalesced");
    expect(again.data?.receipt.commentId).toBe(rows[0]!.id);
    const different = await callTool(token, "request_ross_assessment", { ref: issue.id, question: "Something else", requestKey });
    expect(different.data?.requestStatus).toBe("conflict");
    expect(different.data?.reason).toBe("request-key-carries-different-question");
    expect(await commentsOn(issue.id)).toHaveLength(1);

    // Status: pending until the assigned agent publishes a review after the request.
    const pending = await callTool(token, "ross_request_status", { ref: issue.id, requestKey });
    expect(pending.data?.requestStatus).toBe("pending");
    expect(pending.data?.review).toBeNull();

    const later = new Date();
    const [byOther] = await db
      .insert(documents)
      .values({ companyId, latestBody: "Echo's take: ship it.", latestRevisionNumber: 1, updatedByAgentId: otherAgentId, updatedAt: later })
      .returning();
    await db.insert(issueDocuments).values({ companyId, issueId: issue.id, documentId: byOther!.id, key: "ross-review" });
    const unattributed = await callTool(token, "ross_request_status", { ref: issue.id, requestKey });
    expect(unattributed.data?.requestStatus).toBe("pending");
    expect(unattributed.data?.reason).toBe("review-author-not-assigned-agent");
    expect(unattributed.data?.review.agentWrote).toBeUndefined();

    await db.update(documents).set({ latestBody: "Ross: cut the export feature; ship Friday.", updatedByAgentId: rossAgentId, updatedAt: new Date() }).where(eq(documents.id, byOther!.id));
    const answered = await callTool(token, "ross_request_status", { ref: issue.id, requestKey });
    expect(answered.status).toBe("ok");
    expect(answered.data?.requestStatus).toBe("answered");
    expect(answered.data?.review.agentWrote).toBe("Ross: cut the export feature; ship Friday.");
    expect(answered.data?.businessOutcomeVerified).toBe(false);
  });

  it("two concurrent deliveries of one key post exactly once", async () => {
    const issue = await seedIssue();
    const { grant } = await grantToken(["agentdash:read", "agentdash:work"]);
    const loopback = loopbackFor(grant.id, ["agentdash:read", "agentdash:work"]);
    const post = () =>
      fetch(`${baseUrl}/api/issues/${issue.id}/ross-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${loopback}` },
        body: JSON.stringify({ requestKey: "req-race-000001", question: "Race?" }),
      }).then(async (res) => ({ status: res.status, body: await res.json() }));
    const results = await Promise.all([post(), post(), post()]);
    const statuses = results.map((r) => r.body.status).sort();
    expect(statuses).toEqual(["coalesced", "coalesced", "submitted"]);
    const commentIds = new Set(results.map((r) => r.body.receipt.commentId));
    expect(commentIds.size).toBe(1);
    expect(await commentsOn(issue.id)).toHaveLength(1);
  });

  it("a foreign echo of the marker contests the key and never yields a receipt", async () => {
    const issue = await seedIssue();
    await db.insert(issueComments).values({
      companyId,
      issueId: issue.id,
      authorAgentId: otherAgentId,
      body: "[ross-assessment-request:req-echoed-0001]\nShould we cut scope?",
    });
    const { token } = await grantToken(["agentdash:read", "agentdash:work"]);
    const out = await callTool(token, "request_ross_assessment", { ref: issue.id, question: "Should we cut scope?", requestKey: "req-echoed-0001" });
    expect(out.data?.requestStatus).toBe("conflict");
    expect(out.data?.reason).toBe("request-key-contested-by-foreign-comment");
    expect(out.data?.receipt).toBeUndefined();
    expect(await commentsOn(issue.id)).toHaveLength(1);
    const status = await callTool(token, "ross_request_status", { ref: issue.id, requestKey: "req-echoed-0001" });
    expect(status.data?.requestStatus).toBe("conflict");
  });

  it("refuses before writing on an exhausted recovery budget, and with no assignee", async () => {
    const exhausted = await seedIssue({
      status: "blocked",
      executionState: { recoveryBudget: { status: "exhausted", exhaustedBy: ["runs"] } } as never,
    });
    const unassigned = await seedIssue({ assigneeAgentId: null, status: "todo" });
    const { token } = await grantToken(["agentdash:read", "agentdash:work"]);

    const refused = await callTool(token, "request_ross_assessment", { ref: exhausted.id, question: "Why stuck?" });
    expect(refused.status).toBe("refused");
    expect(refused.data?.requestStatus).toBe("refused");
    expect(refused.data?.reason).toBe("recovery-exhausted");
    expect(refused.data?.posted).toBe(false);
    expect(await commentsOn(exhausted.id)).toHaveLength(0);

    const none = await callTool(token, "request_ross_assessment", { ref: unassigned.id, question: "Anyone?" });
    expect(none.data?.requestStatus).toBe("unavailable");
    expect(none.data?.reason).toBe("no-assigned-agent");
    expect(await commentsOn(unassigned.id)).toHaveLength(0);
  });

  it("a request filed before exhaustion reads refused after it — pending only while a #890 permit is authorized", async () => {
    const issue = await seedIssue();
    const { token } = await grantToken(["agentdash:read", "agentdash:work"]);
    const filed = await callTool(token, "request_ross_assessment", { ref: issue.id, question: "Still on track?", requestKey: "req-before-exhaust" });
    expect(filed.data?.requestStatus).toBe("submitted");

    await db
      .update(issues)
      .set({ executionState: { recoveryBudget: { status: "exhausted", exhaustedBy: ["runs"] } } as never })
      .where(eq(issues.id, issue.id));
    // Re-delivery is still the same recorded request, not a second post.
    const again = await callTool(token, "request_ross_assessment", { ref: issue.id, question: "Still on track?", requestKey: "req-before-exhaust" });
    expect(again.data?.requestStatus).toBe("coalesced");
    expect(await commentsOn(issue.id)).toHaveLength(1);
    const refused = await callTool(token, "ross_request_status", { ref: issue.id, requestKey: "req-before-exhaust" });
    expect(refused.data?.requestStatus).toBe("refused");
    expect(refused.data?.reason).toBe("recovery-exhausted");

    const permitRunId = randomUUID();
    await db
      .update(issues)
      .set({
        executionState: {
          recoveryBudget: { status: "exhausted", exhaustedBy: ["runs"], remediation: { status: "authorized", runId: permitRunId } },
        } as never,
      })
      .where(eq(issues.id, issue.id));
    const permitted = await callTool(token, "ross_request_status", { ref: issue.id, requestKey: "req-before-exhaust" });
    expect(permitted.data?.requestStatus).toBe("pending");
    expect(permitted.data?.gate).toMatchObject({ state: "remediation-permit-authorized", runId: permitRunId });
  });

  it("an issue in a restricted project is unavailable (404) to a member off its access list", async () => {
    const hidden = await seedIssue({ projectId: restrictedProjectId });
    const { token, grant } = await grantToken(["agentdash:read", "agentdash:work"], MEMBER_ID);
    const out = await callTool(token, "request_ross_assessment", { ref: hidden.id, question: "Peek?" });
    expect(out.status).toBe("not_found");
    expect(await commentsOn(hidden.id)).toHaveLength(0);

    const direct = await fetch(`${baseUrl}/api/issues/${hidden.id}/ross-requests`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${loopbackFor(grant.id, ["agentdash:read", "agentdash:work"], MEMBER_ID, "member")}`,
      },
      body: JSON.stringify({ requestKey: "req-hidden-0001", question: "Peek?" }),
    });
    expect(direct.status).toBe(404);
    expect(await commentsOn(hidden.id)).toHaveLength(0);
  });

  it("the loopback gate refuses any body field beyond {requestKey, question}", async () => {
    const issue = await seedIssue();
    const { grant } = await grantToken(["agentdash:read", "agentdash:work"]);
    const res = await fetch(`${baseUrl}/api/issues/${issue.id}/ross-requests`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${loopbackFor(grant.id, ["agentdash:read", "agentdash:work"])}` },
      body: JSON.stringify({ requestKey: "req-extra-00001", question: "Q", resume: true }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("assistant_write_field_forbidden");
    expect(await commentsOn(issue.id)).toHaveLength(0);
  });
});
