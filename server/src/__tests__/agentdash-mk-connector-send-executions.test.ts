import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentGovernancePolicies,
  agentStewardships,
  agents,
  approvals,
  companies,
  companyMemberships,
  connections,
  connectorSendExecutions,
  agentWakeupRequests,
  createDb,
  heartbeatRuns,
  workflowEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { approvalRoutes } from "../routes/approvals.js";
import { connectorSendExecutionRoutes } from "../routes/connector-send-executions.js";
import { hubspotConnectorRoutes } from "../routes/hubspot-connector.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { connectorService } from "../services/connectors.js";
import { __resetHubspotLimiterState } from "../services/hubspot-connector.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

/**
 * AgentDash-MK T4: the `outcome_unknown` operator surface.
 *
 * An ambiguous connector write is recorded and never retried, and until this
 * slice nothing could list it or let a human resolve it. These tests exercise
 * the two real routes end to end: the list of unresolved rows, and the
 * reconcile that records a human's verdict as an audit record (a workflow_event
 * plus an activity-log actor attribution) WITHOUT resending anything.
 */
describeEmbeddedPostgres("agentdash-mk outcome_unknown operator surface", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let handler: (url: string, init?: RequestInit) => { status: number; body: unknown };
  let crmWriteCount: number;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mk-cse-");
    db = createDb(tempDb.connectionString);
  }, 25_000);

  beforeEach(() => {
    crmWriteCount = 0;
    __resetHubspotLimiterState();
    // Default: the ambiguous provider outcome. A 5xx on the CRM object write is
    // exactly what leaves an `outcome_unknown` row behind.
    handler = (url) =>
      url.includes("/crm/v3/objects/") ? { status: 502, body: {} } : { status: 200, body: {} };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if ((method === "POST" || method === "PATCH") && String(url).includes("/crm/v3/objects/")) {
        crmWriteCount += 1;
      }
      const { status, body } = handler(String(url), init);
      return { ok: status >= 200 && status < 300, status, json: async () => body } as never;
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(workflowEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(connectorSendExecutions);
    await db.delete(approvals);
    await db.delete(connections);
    await db.delete(agentGovernancePolicies);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(profile: "agentdash_mk" | "default" = "agentdash_mk") {
    const company = await db
      .insert(companies)
      .values({
        name: `CSE ${randomUUID()}`,
        issuePrefix: `CS${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: profile,
      })
      .returning()
      .then((rows) => rows[0]!);
    const owner = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: randomUUID(),
        status: "active",
        membershipRole: "owner",
      })
      .returning()
      .then((rows) => rows[0]!);
    const steward = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: randomUUID(),
        status: "active",
        membershipRole: "operator",
      })
      .returning()
      .then((rows) => rows[0]!);
    // An ordinary member who stewards nothing and is not an owner/admin.
    const bystander = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: randomUUID(),
        status: "active",
        membershipRole: "operator",
      })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: `Agent ${randomUUID()}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
      })
      .returning()
      .then((rows) => rows[0]!);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: steward.principalId,
      assignedByUserId: owner.principalId,
    });
    const connection = await connectorService(db).create(company.id, {
      ownerType: "user",
      ownerId: steward.principalId,
      provider: "hubspot",
      scopes: ["crm.objects.contacts.write"],
      visibility: "private",
      accountLabel: "12345",
      token: { accessToken: "pat-write" },
    });
    return { company, owner, steward, bystander, agent, connection };
  }

  function makeApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor, companyIds: [...((actor.companyIds as string[]) ?? [])] };
      next();
    });
    app.use("/api", hubspotConnectorRoutes(db));
    app.use("/api", approvalRoutes(db, { autoDispatchQueuedRuns: false }));
    app.use("/api", connectorSendExecutionRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function agentActor(companyId: string, agentId: string) {
    return { type: "agent", agentId, companyId, source: "agent_key", companyIds: [companyId] };
  }

  function boardActor(companyId: string, userId: string, role = "operator") {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
    };
  }

  async function call(app: express.Express, build: (baseUrl: string) => request.Test) {
    const { createServer } = await import("node:http");
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      return await build(`http://127.0.0.1:${address.port}`);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  }

  const PROPERTIES = { email: "lead@example.com", firstname: "Ada" };

  /**
   * Drive the REAL HubSpot write path (G3) so an `outcome_unknown` row is
   * produced exactly the way production produces one: an agent files a write,
   * the steward approves it through the approval route, and the provider returns
   * an ambiguous 5xx.
   */
  async function createUnknownExecution(ctx: Awaited<ReturnType<typeof seed>>) {
    const { company, agent, steward } = ctx;
    const filed = await call(makeApp(agentActor(company.id, agent.id)), (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/hubspot/contacts/write`)
        .send({ operation: "create", properties: PROPERTIES }),
    );
    expect(filed.status, JSON.stringify(filed.body)).toBe(202);

    const approval = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, filed.body.approvalId))
      .then((rows) => rows[0]!);
    const decided = await call(makeApp(boardActor(company.id, steward.principalId)), (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${filed.body.approvalId}/approve`)
        .send({ revision: approval.revision, idempotencyKey: `t-${randomUUID()}`, channel: "web" }),
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    const execution = await db
      .select()
      .from(connectorSendExecutions)
      .where(eq(connectorSendExecutions.approvalId, filed.body.approvalId))
      .then((rows) => rows[0]!);
    expect(execution.outcome).toBe("outcome_unknown");
    return execution;
  }

  // -- T4a: happy path -----------------------------------------------------

  it("lists the unresolved row, then removes it once reconciled (T4a)", async () => {
    const ctx = await seed();
    const execution = await createUnknownExecution(ctx);

    const app = makeApp(boardActor(ctx.company.id, ctx.steward.principalId));
    const listed = await call(app, (baseUrl) =>
      request(baseUrl).get(
        `/api/companies/${ctx.company.id}/connector-send-executions?status=outcome_unknown`,
      ),
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const ids = listed.body.items.map((item: { id: string }) => item.id);
    expect(ids).toEqual([execution.id]);
    // Reference-not-content: the surface never carries the written payload.
    expect(JSON.stringify(listed.body)).not.toContain("lead@example.com");
    const revision = listed.body.items[0].revision;

    const reconciled = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(
          `/api/companies/${ctx.company.id}/connector-send-executions/${execution.id}/reconcile`,
        )
        .send({ verdict: "confirmed_delivered", revision }),
    );
    expect(reconciled.status, JSON.stringify(reconciled.body)).toBe(200);

    // Reconcile is an audit record, not a retry: no second CRM write.
    expect(crmWriteCount, "reconcile resent the write").toBe(1);

    const after = await call(app, (baseUrl) =>
      request(baseUrl).get(
        `/api/companies/${ctx.company.id}/connector-send-executions?status=outcome_unknown`,
      ),
    );
    expect(after.status).toBe(200);
    expect(after.body.items.map((item: { id: string }) => item.id)).toEqual([]);
  });

  it("lets an owner/admin see and reconcile the row too (T4a)", async () => {
    const ctx = await seed();
    const execution = await createUnknownExecution(ctx);

    const app = makeApp(boardActor(ctx.company.id, ctx.owner.principalId, "owner"));
    const listed = await call(app, (baseUrl) =>
      request(baseUrl).get(
        `/api/companies/${ctx.company.id}/connector-send-executions?status=outcome_unknown`,
      ),
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.items.map((item: { id: string }) => item.id)).toEqual([execution.id]);
  });

  // -- T4b: adversarial (G4) ----------------------------------------------

  it("404/403s another company and a non-steward non-admin of the same company (T4b)", async () => {
    const ctx = await seed();
    await createUnknownExecution(ctx);
    const other = await seed();

    // Another company: the caller has no access to ctx's company.
    const crossApp = makeApp(boardActor(other.company.id, other.steward.principalId));
    const cross = await call(crossApp, (baseUrl) =>
      request(baseUrl).get(
        `/api/companies/${ctx.company.id}/connector-send-executions?status=outcome_unknown`,
      ),
    );
    expect([403, 404]).toContain(cross.status);

    // A member of the same company who stewards nothing and is not owner/admin.
    const bystanderApp = makeApp(boardActor(ctx.company.id, ctx.bystander.principalId));
    const bystander = await call(bystanderApp, (baseUrl) =>
      request(baseUrl).get(
        `/api/companies/${ctx.company.id}/connector-send-executions?status=outcome_unknown`,
      ),
    );
    expect([403, 404]).toContain(bystander.status);
  });

  it("404s the list for a company that is not agentdash_mk (T4b)", async () => {
    const ctx = await seed("default");
    const app = makeApp(boardActor(ctx.company.id, ctx.owner.principalId, "owner"));
    const res = await call(app, (baseUrl) =>
      request(baseUrl).get(
        `/api/companies/${ctx.company.id}/connector-send-executions?status=outcome_unknown`,
      ),
    );
    expect(res.status).toBe(404);
  });

  // -- T4c: idempotent + revision-bound -----------------------------------

  it("is idempotent on the same verdict and refuses a stale flip (T4c)", async () => {
    const ctx = await seed();
    const execution = await createUnknownExecution(ctx);
    const app = makeApp(boardActor(ctx.company.id, ctx.steward.principalId));

    const first = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(
          `/api/companies/${ctx.company.id}/connector-send-executions/${execution.id}/reconcile`,
        )
        .send({ verdict: "confirmed_delivered", revision: 0 }),
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    // Same verdict, same (now stale) revision — idempotent, no second event.
    const replay = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(
          `/api/companies/${ctx.company.id}/connector-send-executions/${execution.id}/reconcile`,
        )
        .send({ verdict: "confirmed_delivered", revision: 0 }),
    );
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);

    // A stale button trying to FLIP the verdict must be refused.
    const flip = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(
          `/api/companies/${ctx.company.id}/connector-send-executions/${execution.id}/reconcile`,
        )
        .send({ verdict: "confirmed_failed", revision: 0 }),
    );
    expect(flip.status).toBe(409);

    const events = await db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.runId, execution.id));
    expect(events, "a replay or a refused flip wrote a second event").toHaveLength(1);
    expect((events[0].payload as { verdict?: string }).verdict).toBe("confirmed_delivered");
  });

  it("refuses a reconcile whose revision does not match current state (T4c)", async () => {
    const ctx = await seed();
    const execution = await createUnknownExecution(ctx);
    const app = makeApp(boardActor(ctx.company.id, ctx.steward.principalId));

    const stale = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(
          `/api/companies/${ctx.company.id}/connector-send-executions/${execution.id}/reconcile`,
        )
        .send({ verdict: "confirmed_delivered", revision: 7 }),
    );
    expect(stale.status).toBe(409);

    const events = await db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.runId, execution.id));
    expect(events).toHaveLength(0);
  });

  // -- T4d: workflow_events audit record -----------------------------------

  it("emits a content-appropriate human workflow_events row on reconcile (T4d)", async () => {
    const ctx = await seed();
    const execution = await createUnknownExecution(ctx);
    const app = makeApp(boardActor(ctx.company.id, ctx.steward.principalId));

    const reconciled = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(
          `/api/companies/${ctx.company.id}/connector-send-executions/${execution.id}/reconcile`,
        )
        .send({ verdict: "confirmed_failed", revision: 0 }),
    );
    expect(reconciled.status, JSON.stringify(reconciled.body)).toBe(200);

    // The approval pipeline emits its own events; the reconcile audit record is
    // the one keyed to this execution id.
    const events = await db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.runId, execution.id));
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.eventType).toBe("outcome_reconciled");
    expect(event.actorKind).toBe("human");
    expect(event.runId).toBe(execution.id);
    expect((event.payload as { verdict?: string }).verdict).toBe("confirmed_failed");
    // B3: what kind of actor acted, never which one. No user subject anywhere.
    const serialized = JSON.stringify(event.payload);
    expect(serialized).not.toContain(ctx.steward.principalId);
    expect(serialized.toLowerCase()).not.toContain("userid");

    // Actor attribution lives in the audit trail that is allowed to name people.
    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, ctx.company.id));
    const reconcileLog = activity.find((row) => row.action === "connector_send.reconciled");
    expect(reconcileLog?.actorId).toBe(ctx.steward.principalId);
  });
});
