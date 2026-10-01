import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import express, { type Express } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  instanceUserRoles,
  workforceEnrollments,
  activityLog,
  agents,
  agentStewardships,
  approvals,
  assistantAccessTokens,
  assistantActionHandles,
  assistantGrants,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
  projects,
} from "@paperclipai/db";
import {
  ASSISTANT_GATED_CONFIRM_LIMIT_PER_HOUR,
  ASSISTANT_GATED_HIRE_LIMIT_PER_HOUR,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { mcpRoutes } from "../routes/mcp.js";
import { assistantRoutes } from "../routes/assistant.js";
import { projectRoutes } from "../routes/projects.js";
import {
  mintAssistantLoopbackToken,
  resetAssistantLoopbackTokens,
} from "../services/assistant-loopback.js";
import { resetAssistantWriteLimits } from "../services/assistant-write-limits.js";
import { approvalService } from "../services/approvals.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";

/**
 * GH #679 acceptance: the three M4 gated tools ride real REST routes end to
 * end — a `tools/call` POST to /api/mcp/assistant mints the pcin_ loopback,
 * the middleware's decide-scope gate fires, and prepare→confirm executes the
 * resolved action once, under the person's re-resolved authority, with the
 * refusal modes the spec's §7 requires.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const USER_ID = randomUUID();
const STEWARD_USER_ID = randomUUID();
const MEMBER_USER_ID = randomUUID();
const DECIDE_SCOPES = ["agentdash:read", "agentdash:work", "agentdash:decide"];

describeEmbeddedPostgres("assistant MCP gated actions (M4)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempHome = "";
  let server: http.Server | null = null;
  let baseUrl = "";
  let resourceUri = "";
  let companyId = "";
  let otherCompanyId = "";
  let mkCompanyId = "";
  let requesterAgentId = "";
  let mkAgentId = "";
  let pendingHireAgentId = "";
  let projectId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mcp-gated-");
    db = createDb(tempDb.connectionString);
    // The confirmed-hire path materializes the managed instructions bundle on
    // disk — point the instance root at a temp dir so tests stay hermetic.
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gated-test-"));

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
    api.use(assistantRoutes(db, { autoDispatchQueuedRuns: false }));
    // request_hire's `project` argument resolves through the real projects
    // list — a ref is never guessed.
    api.use(projectRoutes(db));
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
    vi.stubEnv("PAPERCLIP_HOME", tempHome);
    vi.stubEnv("AGENTDASH_DEFAULT_ADAPTER", "");

    const now = new Date();
    await db.insert(authUsers).values([
      { id: USER_ID, name: "Deciding Person", email: "decider@example.test", createdAt: now, updatedAt: now },
      { id: STEWARD_USER_ID, name: "Steward Person", email: "steward@example.test", createdAt: now, updatedAt: now },
      { id: MEMBER_USER_ID, name: "Member Person", email: "member@example.test", createdAt: now, updatedAt: now },
    ]);

    const company = await db
      .insert(companies)
      .values({ name: "Gated E2E", issuePrefix: "GE" })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;
    otherCompanyId = (
      await db
        .insert(companies)
        .values({ name: "Other Co", issuePrefix: "OC" })
        .returning()
        .then((rows) => rows[0]!)
    ).id;
    mkCompanyId = (
      await db
        .insert(companies)
        .values({ name: "MK Co", issuePrefix: "MK", productProfile: "agentdash_mk" })
        .returning()
        .then((rows) => rows[0]!)
    ).id;

    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: USER_ID, status: "active", membershipRole: "owner" },
      // A plain member — can hire by role, but holds no agents:create grant.
      { companyId, principalType: "user", principalId: MEMBER_USER_ID, status: "active", membershipRole: "operator" },
      { companyId: mkCompanyId, principalType: "user", principalId: USER_ID, status: "active", membershipRole: "operator" },
      { companyId: mkCompanyId, principalType: "user", principalId: STEWARD_USER_ID, status: "active", membershipRole: "operator" },
    ]);

    const seedAgent = (cid: string, name: string, status = "idle") =>
      db
        .insert(agents)
        .values({ companyId: cid, name, role: "engineer", status, adapterType: "process", adapterConfig: { command: "echo" } })
        .returning()
        .then((rows) => rows[0]!);
    requesterAgentId = (await seedAgent(companyId, "Priya")).id;
    pendingHireAgentId = (await seedAgent(companyId, "Pending Hire", "pending_approval")).id;
    mkAgentId = (await seedAgent(mkCompanyId, "MK Agent")).id;

    projectId = (
      await db
        .insert(projects)
        .values({ companyId, name: "Checkout", status: "active" })
        .returning()
        .then((rows) => rows[0]!)
    ).id;

    // MK company: STEWARD_USER_ID stewards the requesting agent; USER_ID is a
    // plain member — the authority refusal case.
    await agentStewardshipService(db).assign(mkCompanyId, {
      agentId: mkAgentId,
      userId: STEWARD_USER_ID,
      assignedByUserId: STEWARD_USER_ID,
    });
  }, 90_000);

  afterEach(async () => {
    await db.delete(assistantActionHandles);
    await db.delete(assistantAccessTokens);
    await db.delete(assistantGrants);
    await db.delete(activityLog);
    await db.delete(approvals);
    resetAssistantWriteLimits();
    resetAssistantLoopbackTokens();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await tempDb?.cleanup();
    await fs.rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  async function grantToken(
    scopes: string[],
    cid = companyId,
    opts: { decisionsNeedTap?: boolean; userId?: string } = {},
  ) {
    const grant = await db
      .insert(assistantGrants)
      .values({
        companyId: cid,
        userId: opts.userId ?? USER_ID,
        clientId: `client-${randomUUID().slice(0, 8)}`,
        clientName: "Muse (Meta)",
        redirectHost: "agent.meta.ai",
        scopes,
        decisionsNeedTap: opts.decisionsNeedTap ?? false,
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
      links?: Record<string, string>;
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

  async function seedApproval(
    cid: string,
    input: { type?: string; requestedByAgentId?: string | null; payload?: Record<string, unknown>; status?: string } = {},
  ) {
    return db
      .insert(approvals)
      .values({
        companyId: cid,
        type: input.type ?? "request_board_approval",
        requestedByAgentId: input.requestedByAgentId ?? null,
        status: input.status ?? "pending",
        payload: input.payload ?? { summary: "Ship the board deck" },
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function readApproval(id: string) {
    return db.select().from(approvals).where(eq(approvals.id, id)).then((rows) => rows[0] ?? null);
  }

  const handleTokenHash = (token: string) =>
    createHash("sha256").update(token).digest("hex");

  async function handleRowFor(token: string) {
    return db
      .select()
      .from(assistantActionHandles)
      .where(eq(assistantActionHandles.token, handleTokenHash(token)))
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Already-spent handles for the gated-budget tests. The budget counts
   * `consumedAt` inside the rolling hour, so these rows read as confirms that
   * already happened; expiresAt stays inside the sweep's grace window.
   */
  async function seedConsumedHandles(
    grantId: string,
    kind: "approval_decision" | "hire_request",
    count: number,
  ) {
    const now = Date.now();
    await db.insert(assistantActionHandles).values(
      Array.from({ length: count }, () => ({
        token: handleTokenHash(`spent-${randomUUID()}`),
        companyId,
        grantId,
        actorUserId: USER_ID,
        kind,
        payload: {},
        expiresAt: new Date(now + 15 * 60 * 1000),
        consumedAt: new Date(now),
      })),
    );
  }

  async function prepareAndConfirm(token: string, approvalId: string, personSaid?: string) {
    const prep = envelope(await callTool(token, "prepare_decision", { approval: approvalId, decision: "approve" }));
    expect(prep.status, prep.summary).toBe("ok");
    const handle = prep.data?.handle as string;
    const conf = envelope(await callTool(token, "confirm_action", { handle, ...(personSaid ? { personSaid } : {}) }));
    return { prep, conf, handle };
  }

  it("lists seventeen tools for a decide grant; confirm_action is destructive", async () => {
    const { token } = await grantToken(DECIDE_SCOPES);
    const tools = await listTools(token);
    expect(tools).toHaveLength(17);
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["prepare_decision", "request_hire", "confirm_action"]) {
      expect(byName.has(name)).toBe(true);
      expect(byName.get(name)?.annotations?.readOnlyHint).toBe(false);
    }
    expect(byName.get("confirm_action")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("prepare_decision")?.annotations?.destructiveHint).toBe(false);
  });

  it("a work-scope grant does not see the gated tools", async () => {
    const { token } = await grantToken(["agentdash:read", "agentdash:work"]);
    const tools = await listTools(token);
    expect(tools).toHaveLength(14);
    expect(tools.map((t) => t.name)).not.toContain("confirm_action");
  });

  it("prepare_decision mints a bound handle and changes nothing", async () => {
    const { token, grant } = await grantToken(DECIDE_SCOPES);
    const approval = await seedApproval(companyId, { requestedByAgentId: requesterAgentId });

    const env = envelope(
      await callTool(token, "prepare_decision", { approval: approval.id, decision: "approve", note: "ship it" }),
    );
    expect(env.status, env.summary).toBe("ok");
    expect(env.summary).toContain("Approve");
    expect(env.summary).toContain("Priya");
    expect(env.data?.handle).toMatch(/^aah_/);
    expect(env.data?.pendingConfirmation).toBe(true);
    expect(Array.isArray(env.data?.effects)).toBe(true);

    const handle = await handleRowFor(env.data!.handle as string);
    expect(handle).toBeTruthy();
    // Stored sha256-hashed like the OAuth tokens — the raw handle never rests.
    expect(handle!.token).toBe(handleTokenHash(env.data!.handle as string));
    expect(handle!.grantId).toBe(grant.id);
    expect(handle!.actorUserId).toBe(USER_ID);
    expect(handle!.kind).toBe("approval_decision");
    expect((handle!.payload as Record<string, unknown>).approvalId).toBe(approval.id);
    expect(handle!.consumedAt).toBeNull();

    // Prepare is read-only in effect — the approval is untouched.
    expect((await readApproval(approval.id))!.status).toBe("pending");
  });

  it("confirm_action approves under channel 'assistant' and records personSaid + latency", async () => {
    const { token, grant } = await grantToken(DECIDE_SCOPES);
    const approval = await seedApproval(companyId);

    const { conf, handle } = await prepareAndConfirm(token, approval.id, "yes, approve it");
    expect(conf.status, conf.summary).toBe("ok");
    expect(conf.summary).toContain("Approved");
    expect(conf.links?.approval).toContain(`/approvals/${approval.id}`);

    const stored = (await readApproval(approval.id))!;
    expect(stored.status).toBe("approved");
    expect(stored.decidedByUserId).toBe(USER_ID);
    expect(stored.decisionChannel).toBe("assistant");

    const handleRow = (await handleRowFor(handle))!;
    expect(handleRow.consumedAt).not.toBeNull();
    expect(stored.decisionIdempotencyKey).toBe(`assistant:${handleRow.id}`);

    const gated = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "assistant.gated_action"), eq(activityLog.entityId, handleRow.id)))
      .then((rows) => rows[0]!);
    expect(gated.details?.personSaid).toBe("yes, approve it");
    expect(gated.details?.grantId).toBe(grant.id);
    expect(gated.details?.via).toContain("Muse (Meta)");
    expect(typeof gated.details?.prepareToConfirmMs).toBe("number");
    expect(gated.details?.decision).toBe("approve");
    expect(gated.details?.applied).toBe(true);

    const decided = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "approval.approved"), eq(activityLog.entityId, approval.id)))
      .then((rows) => rows[0]!);
    expect(decided.actorId).toBe(USER_ID);
  });

  it("a handle works exactly once", async () => {
    const { token } = await grantToken(DECIDE_SCOPES);
    const approval = await seedApproval(companyId);
    const { handle } = await prepareAndConfirm(token, approval.id);
    expect((await readApproval(approval.id))!.status).toBe("approved");

    const second = envelope(await callTool(token, "confirm_action", { handle }));
    expect(second.status).toBe("refused");
    expect(second.summary).toContain("already used");
  });

  it("an expired handle refuses", async () => {
    const { token } = await grantToken(DECIDE_SCOPES);
    const approval = await seedApproval(companyId);
    const prep = envelope(await callTool(token, "prepare_decision", { approval: approval.id, decision: "approve" }));
    const handle = prep.data!.handle as string;
    await db
      .update(assistantActionHandles)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(assistantActionHandles.token, handleTokenHash(handle)));

    const conf = envelope(await callTool(token, "confirm_action", { handle }));
    expect(conf.status).toBe("refused");
    expect(conf.summary).toContain("expired");
    expect((await readApproval(approval.id))!.status).toBe("pending");
  });

  it("a superseded approval revision refuses", async () => {
    const { token } = await grantToken(DECIDE_SCOPES);
    const approval = await seedApproval(companyId);
    const prep = envelope(await callTool(token, "prepare_decision", { approval: approval.id, decision: "approve" }));
    await db.update(approvals).set({ revision: approval.revision + 1 }).where(eq(approvals.id, approval.id));

    const conf = envelope(await callTool(token, "confirm_action", { handle: prep.data!.handle as string }));
    expect(conf.status).toBe("refused");
    expect(conf.summary).toContain("changed since");
    expect((await readApproval(approval.id))!.status).toBe("pending");
  });

  it("an approval decided between prepare and confirm refuses", async () => {
    const { token } = await grantToken(DECIDE_SCOPES);
    const approval = await seedApproval(companyId);
    const prep = envelope(await callTool(token, "prepare_decision", { approval: approval.id, decision: "approve" }));

    await approvalService(db).reject(approval.id, USER_ID, null, { channel: "web" });

    const conf = envelope(await callTool(token, "confirm_action", { handle: prep.data!.handle as string }));
    expect(conf.status).toBe("refused");
    expect(conf.summary).toContain("already rejected");
  });

  it("request_changes moves the approval to revision_requested", async () => {
    const { token } = await grantToken(DECIDE_SCOPES);
    const approval = await seedApproval(companyId);

    const prep = envelope(
      await callTool(token, "prepare_decision", { approval: approval.id, decision: "request_changes", note: "needs more detail" }),
    );
    expect(prep.status, prep.summary).toBe("ok");
    const conf = envelope(
      await callTool(token, "confirm_action", { handle: prep.data!.handle as string, personSaid: "send it back" }),
    );
    expect(conf.status, conf.summary).toBe("ok");

    const stored = (await readApproval(approval.id))!;
    expect(stored.status).toBe("revision_requested");
    expect(stored.decisionNote).toBe("needs more detail");
  });

  it("'decisions need a tap' returns the approval link and leaves it pending", async () => {
    const { token } = await grantToken(DECIDE_SCOPES, companyId, { decisionsNeedTap: true });
    const approval = await seedApproval(companyId);

    const { conf } = await prepareAndConfirm(token, approval.id, "yes");
    expect(conf.status, conf.summary).toBe("ok");
    expect(conf.summary).toContain("keep decisions on the page");
    expect(conf.data?.tapReturned).toBe(true);
    expect(conf.links?.approval).toContain(`/approvals/${approval.id}`);
    expect((await readApproval(approval.id))!.status).toBe("pending");
  });

  it("a handle minted for one grant cannot be confirmed by another", async () => {
    const grantA = await grantToken(DECIDE_SCOPES);
    const grantB = await grantToken(DECIDE_SCOPES);
    const approval = await seedApproval(companyId);

    const prep = envelope(
      await callTool(grantA.token, "prepare_decision", { approval: approval.id, decision: "approve" }),
    );
    const conf = envelope(
      await callTool(grantB.token, "confirm_action", { handle: prep.data!.handle as string }),
    );
    expect(conf.status).toBe("refused");
    expect(conf.summary).toContain("isn't valid");
    expect((await readApproval(approval.id))!.status).toBe("pending");
  });

  it("a grant revoked between prepare and confirm refuses the confirmation", async () => {
    const { token, grant } = await grantToken(DECIDE_SCOPES);
    const approval = await seedApproval(companyId);
    const prep = envelope(
      await callTool(token, "prepare_decision", { approval: approval.id, decision: "approve" }),
    );
    expect(prep.status, prep.summary).toBe("ok");

    await db.update(assistantGrants).set({ revokedAt: new Date() }).where(eq(assistantGrants.id, grant.id));

    const conf = await callTool(token, "confirm_action", { handle: prep.data!.handle as string });
    // Refusal lands wherever revocation catches it first — token resolution
    // (a revoked grant's pcpa_ stops resolving) or the confirm's own
    // grant_revoked check. Either way: refused, and nothing was decided.
    const env = envelope(conf);
    if (env) {
      expect(env.status).toBe("refused");
    } else {
      expect(conf.httpStatus !== 200 || conf.error).toBeTruthy();
    }
    expect((await readApproval(approval.id))!.status).toBe("pending");
  });

  it("a decide-scope-less credential cannot reach the actions routes directly", async () => {
    const { grant } = await grantToken(["agentdash:read", "agentdash:work"]);
    const loopback = mintAssistantLoopbackToken({
      origin: { kind: "internal" },
      userId: USER_ID,
      companyId,
      membershipRole: "owner",
      grantId: grant.id,
      scopes: ["agentdash:read", "agentdash:work"],
      clientName: "Muse (Meta)",
    });
    const res = await fetch(`${baseUrl}/api/companies/${companyId}/assistant/actions/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${loopback}` },
      body: JSON.stringify({ handle: "aah_whatever" }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("insufficient_scope");
    expect(body.required_scope).toBe("agentdash:decide");
  });

  it("an unexpected body field on a gated route is refused in middleware", async () => {
    const { grant } = await grantToken(DECIDE_SCOPES);
    const loopback = mintAssistantLoopbackToken({
      origin: { kind: "internal" },
      userId: USER_ID,
      companyId,
      membershipRole: "owner",
      grantId: grant.id,
      scopes: DECIDE_SCOPES,
      clientName: "Muse (Meta)",
    });
    const res = await fetch(`${baseUrl}/api/companies/${companyId}/assistant/actions/prepare-hire`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${loopback}` },
      body: JSON.stringify({ role: "qa", reason: "coverage", adapterConfig: { command: "rm -rf /" } }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("assistant_write_field_forbidden");
    expect(body.fields).toContain("adapterConfig");
  });

  it("a handle bound to one company refuses through another company's route", async () => {
    const { token, grant } = await grantToken(DECIDE_SCOPES);
    const approval = await seedApproval(companyId);
    const prep = envelope(await callTool(token, "prepare_decision", { approval: approval.id, decision: "approve" }));

    // The MCP endpoint pins the grant's company, so exercise the REST layer
    // directly with a company-mismatched loopback identity.
    const foreign = mintAssistantLoopbackToken({
      origin: { kind: "internal" },
      userId: USER_ID,
      companyId: otherCompanyId,
      membershipRole: "owner",
      grantId: grant.id,
      scopes: DECIDE_SCOPES,
      clientName: "Muse (Meta)",
    });
    // The foreign company needs the caller to have access — grant a membership
    // so the refusal is the handle binding, not the company gate.
    await db.insert(companyMemberships).values({
      companyId: otherCompanyId,
      principalType: "user",
      principalId: USER_ID,
      status: "active",
      membershipRole: "owner",
    });
    const res = await fetch(`${baseUrl}/api/companies/${otherCompanyId}/assistant/actions/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${foreign}` },
      body: JSON.stringify({ handle: prep.data!.handle as string }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("handle_invalid");
    expect((await readApproval(approval.id))!.status).toBe("pending");
  });

  it("in an agentdash_mk company a non-steward cannot even prepare a decision", async () => {
    const { token } = await grantToken(DECIDE_SCOPES, mkCompanyId);
    const approval = await seedApproval(mkCompanyId, { requestedByAgentId: mkAgentId });

    const prep = envelope(
      await callTool(token, "prepare_decision", { approval: approval.id, decision: "approve" }),
    );
    expect(prep.status).toBe("refused");
    expect(prep.summary).toContain("not the person who can decide");
    expect((await readApproval(approval.id))!.status).toBe("pending");
  });

  it("pins a selected workforce template/version through assistant prepare, isolation, confirm and replay", async () => {
    const { token } = await grantToken(DECIDE_SCOPES);
    const prep = envelope(await callTool(token, "request_hire", { role: "writer", reason: "campaign", nameHint: "TemplateWriter", workforceTemplateId: "marketing-content" }));
    expect(prep.status, prep.summary).toBe("ok");
    const handle = prep.data!.handle as string;
    expect((await handleRowFor(handle))!.payload).toMatchObject({ workforceTemplateId: "marketing-content", workforceTemplateVersion: 1 });
    expect(prep.summary).toContain("Marketing");
    const foreign = await grantToken(DECIDE_SCOPES, otherCompanyId);
    expect(envelope(await callTool(foreign.token, "confirm_action", { handle })).status).toBe("refused");
    const conf = envelope(await callTool(token, "confirm_action", { handle, personSaid: "yes", workforceTemplateId: "sales-support" }));
    expect(conf.status, conf.summary).toBe("ok");
    const rows = await db.select().from(workforceEnrollments).where(eq(workforceEnrollments.companyId, companyId));
    expect(rows.find(row => row.templateId === "marketing-content")).toMatchObject({ templateVersion: 1, skillInstallError: null });
    expect(rows.find(row => row.templateId === "marketing-content")!.installedSkillKeys).toHaveLength(1);
    expect(envelope(await callTool(token, "confirm_action", { handle })).status).toBe("refused");
  });

  it("honors existing instance-admin direction authority for a selected assistant hire", async () => {
    await db.insert(instanceUserRoles).values({ userId: MEMBER_USER_ID, role: "instance_admin" });
    try {
      const { token } = await grantToken(DECIDE_SCOPES, companyId, { userId: MEMBER_USER_ID });
      const prep = envelope(await callTool(token, "request_hire", { role: "writer", reason: "campaign", workforceTemplateId: "marketing-content" }));
      expect(prep.status, prep.summary).toBe("ok");
      expect(envelope(await callTool(token, "confirm_action", { handle: prep.data!.handle })).status).toBe("ok");
    } finally { await db.delete(instanceUserRoles).where(eq(instanceUserRoles.userId, MEMBER_USER_ID)); }
  });

  it("refuses member selection and rechecks direction authority at assistant confirmation", async () => {
    const member = await grantToken(DECIDE_SCOPES, companyId, { userId: MEMBER_USER_ID });
    expect(envelope(await callTool(member.token, "request_hire", { role: "writer", reason: "campaign", workforceTemplateId: "marketing-content" })).status).toBe("refused");
    const { token } = await grantToken(DECIDE_SCOPES);
    const prep = envelope(await callTool(token, "request_hire", { role: "writer", reason: "campaign", workforceTemplateId: "marketing-content" }));
    expect(prep.status, prep.summary).toBe("ok");
    await db.update(companyMemberships).set({ membershipRole: "member" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, USER_ID)));
    try {
      expect(envelope(await callTool(token, "confirm_action", { handle: prep.data!.handle })).status).toBe("refused");
    } finally {
      await db.update(companyMemberships).set({ membershipRole: "admin" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, USER_ID)));
    }
  });

  it("request_hire confirms into an active agent with membership and attribution", async () => {
    const { token } = await grantToken(DECIDE_SCOPES);

    const prep = envelope(
      await callTool(token, "request_hire", {
        role: "qa",
        reason: "release gate needs coverage",
        nameHint: "Quinn",
        project: "Checkout",
      }),
    );
    expect(prep.status, prep.summary).toBe("ok");
    expect(prep.summary).toContain("Quinn");
    expect(prep.data?.wouldNeedApproval).toBe(false);
    expect(prep.data?.handle).toMatch(/^aah_/);

    const conf = envelope(
      await callTool(token, "confirm_action", { handle: prep.data!.handle as string, personSaid: "yes hire them" }),
    );
    expect(conf.status, conf.summary).toBe("ok");
    expect(conf.summary).toContain("Hired Quinn");

    const hired = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.name, "Quinn")))
      .then((rows) => rows[0]!);
    expect(hired.status).toBe("idle");
    expect(hired.autonomy).toBe("stewarded");
    expect(hired.adapterType).toBe("hermes_local");
    expect(hired.createdByUserId).toBe(USER_ID);
    // The assistant never picks host-executed config — it stays empty.
    expect(hired.adapterConfig?.command).toBeUndefined();
    // agent-hires parity: normalizeNewAgentRuntimeConfig filled the heartbeat
    // block the board route would have (GH #679 review).
    const rc = hired.runtimeConfig as { heartbeat?: { enabled?: boolean; maxConcurrentRuns?: number } };
    expect(rc?.heartbeat?.enabled).toBe(false);
    expect(typeof rc?.heartbeat?.maxConcurrentRuns).toBe("number");
    expect((hired.metadata as Record<string, unknown>)?.source).toBe("assistant_hire_request");
    expect((hired.metadata as Record<string, unknown>)?.projectId).toBe(projectId);

    const membership = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "agent"),
          eq(companyMemberships.principalId, hired.id),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(membership?.status).toBe("active");

    const grant = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "agent"),
          eq(principalPermissionGrants.principalId, hired.id),
          eq(principalPermissionGrants.permissionKey, "tasks:assign"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(grant).toBeTruthy();

    const activity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "agent.hire_created"), eq(activityLog.entityId, hired.id)))
      .orderBy(desc(activityLog.createdAt))
      .then((rows) => rows[0]!);
    expect(activity.details?.via).toContain("Muse (Meta)");
    expect(activity.details?.requiresApproval).toBe(false);
  });

  it("request_hire under requireBoardApprovalForNewAgents files a pending hire approval", async () => {
    await db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, companyId));
    try {
      const { token } = await grantToken(DECIDE_SCOPES);
      const prep = envelope(
        await callTool(token, "request_hire", { role: "designer", reason: "marketing needs a refresh" }),
      );
      expect(prep.status, prep.summary).toBe("ok");
      expect(prep.data?.wouldNeedApproval).toBe(true);
      expect(prep.summary).toContain("pending approval");

      const conf = envelope(await callTool(token, "confirm_action", { handle: prep.data!.handle as string }));
      expect(conf.status, conf.summary).toBe("ok");
      expect(conf.summary).toContain("waiting for approval");

      const hired = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.name, "Designer")))
        .then((rows) => rows[0]!);
      expect(hired.status).toBe("pending_approval");

      const hireApproval = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.type, "hire_agent")))
        .then((rows) => rows[0]!);
      expect(hireApproval.status).toBe("pending");
      expect((hireApproval.payload as Record<string, unknown>).agentId).toBe(hired.id);
      expect(hireApproval.requestedByUserId).toBe(USER_ID);
    } finally {
      await db.update(companies).set({ requireBoardApprovalForNewAgents: false }).where(eq(companies.id, companyId));
    }
  });

  it("request_hire with tap enabled files nothing and returns the hire link", async () => {
    const { token } = await grantToken(DECIDE_SCOPES, companyId, { decisionsNeedTap: true });
    const prep = envelope(await callTool(token, "request_hire", { role: "qa", reason: "coverage" }));
    const conf = envelope(await callTool(token, "confirm_action", { handle: prep.data!.handle as string }));
    expect(conf.status, conf.summary).toBe("ok");
    expect(conf.data?.tapReturned).toBe(true);
    expect(conf.links?.newAgent).toContain("/agents/new");

    const created = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.name, "Qa")));
    expect(created).toHaveLength(0);
  });

  it("request_hire with a cross-company project refuses", async () => {
    const foreignProject = await db
      .insert(projects)
      .values({ companyId: otherCompanyId, name: "Not Mine", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    const { token } = await grantToken(DECIDE_SCOPES);
    const prep = envelope(
      await callTool(token, "request_hire", { role: "qa", reason: "coverage", project: foreignProject.id }),
    );
    expect(prep.status).toBe("not_found");
    expect(prep.summary).toContain("couldn't find project");
  });

  it("a raw assistant bearer cannot reach the actions routes", async () => {
    const { token } = await grantToken(DECIDE_SCOPES);
    const res = await fetch(`${baseUrl}/api/companies/${companyId}/assistant/actions/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ handle: "aah_whatever" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Assistant credentials cannot reach this route");
  });

  it("two concurrent confirms cannot both execute — the handle spends once", async () => {
    const { token } = await grantToken(DECIDE_SCOPES);
    const approval = await seedApproval(companyId);
    const prep = envelope(
      await callTool(token, "prepare_decision", { approval: approval.id, decision: "approve" }),
    );
    const handle = prep.data!.handle as string;

    const [a, b] = await Promise.all([
      callTool(token, "confirm_action", { handle }),
      callTool(token, "confirm_action", { handle }),
    ]);
    const statuses = [envelope(a).status, envelope(b).status].sort();
    expect(statuses).toEqual(["ok", "refused"]);
    expect((await readApproval(approval.id))!.status).toBe("approved");

    // Exactly one decision was recorded — the conditional UPDATE, not the
    // read, is what makes the handle single-use.
    const decides = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.action, "approval.approved"), eq(activityLog.entityId, approval.id)));
    expect(decides).toHaveLength(1);
  });

  it("losing membership between prepare and confirm refuses the confirmation", async () => {
    const { token } = await grantToken(DECIDE_SCOPES);
    const approval = await seedApproval(companyId);
    const prep = envelope(
      await callTool(token, "prepare_decision", { approval: approval.id, decision: "approve" }),
    );
    expect(prep.status, prep.summary).toBe("ok");

    await db
      .delete(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, USER_ID),
        ),
      );
    try {
      const conf = await callTool(token, "confirm_action", { handle: prep.data!.handle as string });
      // Refusal lands wherever the lost authority is noticed first — token
      // resolution stops resolving without an active membership, or the
      // route's re-check does. Either way: refused, nothing was decided.
      const env = envelope(conf);
      if (env) {
        expect(env.status).toBe("refused");
      } else {
        expect(conf.httpStatus !== 200 || conf.error).toBeTruthy();
      }
      expect((await readApproval(approval.id))!.status).toBe("pending");
    } finally {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: USER_ID,
        status: "active",
        membershipRole: "owner",
      });
    }
  });

  it("request_hire on a full free workspace refuses instead of filing", async () => {
    // isBillingDisabled() bypasses caps whenever no Stripe key is configured —
    // provide one (and a free planTier by default) so the cap actually binds.
    // FREE_AGENT_CAP is 1 and two agents are already seeded.
    const savedStripe = process.env.STRIPE_SECRET_KEY;
    const savedDisabled = process.env.AGENTDASH_BILLING_DISABLED;
    process.env.STRIPE_SECRET_KEY = "sk_test_free_caps";
    delete process.env.AGENTDASH_BILLING_DISABLED;
    try {
      const { token } = await grantToken(DECIDE_SCOPES);
      const prep = envelope(
        await callTool(token, "request_hire", { role: "qa", reason: "coverage" }),
      );
      expect(prep.status, prep.summary).toBe("ok");

      const conf = envelope(
        await callTool(token, "confirm_action", { handle: prep.data!.handle as string }),
      );
      expect(conf.status).toBe("refused");
      expect(conf.summary).toContain("Upgrade to Pro");
      expect(conf.summary).toContain("No hire was filed");

      const hired = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.name, "Qa")));
      expect(hired).toHaveLength(0);
    } finally {
      if (savedStripe === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = savedStripe;
      if (savedDisabled === undefined) delete process.env.AGENTDASH_BILLING_DISABLED;
      else process.env.AGENTDASH_BILLING_DISABLED = savedDisabled;
    }
  });

  it("a member without agents:create cannot decide a hire approval", async () => {
    const { token } = await grantToken(DECIDE_SCOPES, companyId, { userId: MEMBER_USER_ID });
    const approval = await seedApproval(companyId, {
      type: "hire_agent",
      requestedByAgentId: requesterAgentId,
      payload: { name: "Sarah Johnson", title: "QA Engineer", agentId: pendingHireAgentId },
    });

    const prep = envelope(
      await callTool(token, "prepare_decision", { approval: approval.id, decision: "approve" }),
    );
    expect(prep.status).toBe("refused");
    expect(prep.summary).toContain("agents:create");
    expect((await readApproval(approval.id))!.status).toBe("pending");
  });

  it("the read-back quotes agent-written hire fields as the asker's words", async () => {
    const { token } = await grantToken(DECIDE_SCOPES);
    const approval = await seedApproval(companyId, {
      type: "hire_agent",
      requestedByAgentId: requesterAgentId,
      payload: { name: "Sarah Johnson", title: "QA Engineer" },
    });

    const prep = envelope(
      await callTool(token, "prepare_decision", { approval: approval.id, decision: "approve" }),
    );
    expect(prep.status, prep.summary).toBe("ok");
    // Untrusted agent-authored text is attributed, never asserted as fact.
    expect(prep.summary).toContain('Priya wrote: "Sarah Johnson as QA Engineer"');
  });

  it("the per-grant confirm budget refuses the 21st confirm inside the hour", async () => {
    const { token, grant } = await grantToken(DECIDE_SCOPES);
    // Twenty confirms already spent by this grant inside the rolling hour.
    await seedConsumedHandles(grant.id, "approval_decision", ASSISTANT_GATED_CONFIRM_LIMIT_PER_HOUR);
    const approval = await seedApproval(companyId);

    const prep = envelope(
      await callTool(token, "prepare_decision", { approval: approval.id, decision: "approve" }),
    );
    expect(prep.status, prep.summary).toBe("ok");

    const conf = envelope(
      await callTool(token, "confirm_action", { handle: prep.data!.handle as string }),
    );
    expect(conf.status).toBe("refused");
    expect(conf.summary).toContain(`confirmed ${ASSISTANT_GATED_CONFIRM_LIMIT_PER_HOUR} actions`);
    expect((await readApproval(approval.id))!.status).toBe("pending");
  });

  it("the per-grant hire budget refuses the 6th hire inside the hour", async () => {
    const { token, grant } = await grantToken(DECIDE_SCOPES);
    await seedConsumedHandles(grant.id, "hire_request", ASSISTANT_GATED_HIRE_LIMIT_PER_HOUR);

    const prep = envelope(await callTool(token, "request_hire", { role: "qa", reason: "coverage" }));
    expect(prep.status, prep.summary).toBe("ok");

    const conf = envelope(
      await callTool(token, "confirm_action", { handle: prep.data!.handle as string }),
    );
    expect(conf.status).toBe("refused");
    expect(conf.summary).toContain(`hired ${ASSISTANT_GATED_HIRE_LIMIT_PER_HOUR} agents`);

    const hired = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.name, "Qa")));
    expect(hired).toHaveLength(0);
  });

  it("a steward change between prepare and confirm refuses at confirm", async () => {
    const { token } = await grantToken(DECIDE_SCOPES, mkCompanyId, { userId: STEWARD_USER_ID });
    const approval = await seedApproval(mkCompanyId, { requestedByAgentId: mkAgentId });
    const prep = envelope(
      await callTool(token, "prepare_decision", { approval: approval.id, decision: "approve" }),
    );
    expect(prep.status, prep.summary).toBe("ok");

    // The handle survives the transfer — what is gone is the authority it
    // was minted under. Confirm re-resolves the steward, so it refuses here
    // rather than at token lookup: the grant and membership are untouched.
    await agentStewardshipService(db).transfer(mkCompanyId, mkAgentId, {
      userId: USER_ID,
      transferredByUserId: USER_ID,
    });
    try {
      const conf = envelope(
        await callTool(token, "confirm_action", { handle: prep.data!.handle as string }),
      );
      expect(conf.status).toBe("refused");
      expect(conf.summary).toContain("not the person who can decide");
      expect((await readApproval(approval.id))!.status).toBe("pending");
    } finally {
      await agentStewardshipService(db).transfer(mkCompanyId, mkAgentId, {
        userId: STEWARD_USER_ID,
        transferredByUserId: STEWARD_USER_ID,
      });
    }
  });

  it("agents:create removed between prepare and confirm refuses at confirm", async () => {
    const { token } = await grantToken(DECIDE_SCOPES, companyId, { userId: MEMBER_USER_ID });
    // A plain member can decide ordinary approvals but not agent hires — give
    // the permission explicitly so prepare passes, then take it away. The
    // refusal must come from the confirm path's own re-check, not token
    // resolution: the membership stays active throughout.
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: MEMBER_USER_ID,
      permissionKey: "agents:create",
      grantedByUserId: USER_ID,
    });
    const approval = await seedApproval(companyId, {
      type: "hire_agent",
      requestedByAgentId: requesterAgentId,
      payload: { name: "Sarah Johnson", title: "QA Engineer", agentId: pendingHireAgentId },
    });

    const prep = envelope(
      await callTool(token, "prepare_decision", { approval: approval.id, decision: "approve" }),
    );
    expect(prep.status, prep.summary).toBe("ok");

    await db
      .delete(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, MEMBER_USER_ID),
          eq(principalPermissionGrants.permissionKey, "agents:create"),
        ),
      );

    const conf = envelope(
      await callTool(token, "confirm_action", { handle: prep.data!.handle as string }),
    );
    expect(conf.status).toBe("refused");
    expect(conf.summary).toContain("agents:create");
    expect(conf.summary).toContain("nothing was decided");
    expect((await readApproval(approval.id))!.status).toBe("pending");
  });
});
