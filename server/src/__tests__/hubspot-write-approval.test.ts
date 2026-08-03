import { createHash, randomUUID } from "node:crypto";
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
} from "@paperclipai/db";
import {
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  AGENT_POLICY_WILDCARD,
  type AgentGovernancePolicy,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { approvalRoutes } from "../routes/approvals.js";
import { hubspotConnectorRoutes } from "../routes/hubspot-connector.js";
import { agentGovernanceService } from "../services/agent-governance.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { connectorService } from "../services/connectors.js";
import { __resetHubspotLimiterState } from "../services/hubspot-connector.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

/**
 * Steward-approved HubSpot writes.
 *
 * The invariant: an agent never writes to the CRM. It asks; the steward
 * decides; the server executes with the connection owner's credential. Every
 * test that matters here is about what happens BETWEEN the decision and the
 * write, because that gap is where authority goes stale.
 */
describeEmbeddedPostgres("hubspot steward-approved writes", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let writeCalls: Array<{ url: string; body: unknown }>;
  let handler: (url: string, init?: RequestInit) => { status: number; body: unknown };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hs-write-");
    db = createDb(tempDb.connectionString);
  }, 25_000);

  beforeEach(() => {
    writeCalls = [];
    __resetHubspotLimiterState();
    handler = () => ({ status: 200, body: { id: "hs-999", properties: {} } });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" || method === "PATCH") {
        writeCalls.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
      }
      const { status, body } = handler(String(url), init);
      return { ok: status >= 200 && status < 300, status, json: async () => body } as never;
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(activityLog);
    // Approving an approval can queue a run and a wakeup; both reference agents.
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

  /** Only CRM object writes count; token validation also POSTs. */
  function crmWrites() {
    return writeCalls.filter((call) => call.url.includes("/crm/v3/objects/"));
  }

  async function seed(profile: "agentdash_mk" | "default" = "agentdash_mk") {
    const company = await db
      .insert(companies)
      .values({
        name: `HSW ${randomUUID()}`,
        issuePrefix: `HW${randomUUID().slice(0, 6).toUpperCase()}`,
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
    // The STEWARD's own private key, created exactly as the connect route makes
    // it. This used to hand-build an `ownerType: "agent"` row with the comment
    // "Agent-owned so resolveActingAs can find it" — which was the workaround
    // documenting the bug: a real user's key never resolved, so the whole write
    // path was only ever exercised against a connection no product flow creates.
    const connection = await connectorService(db).create(company.id, {
      ownerType: "user",
      ownerId: steward.principalId,
      provider: "hubspot",
      scopes: ["crm.objects.contacts.write"],
      visibility: "private",
      accountLabel: "12345",
      token: { accessToken: "pat-write" },
    });
    return { company, owner, steward, agent, connection };
  }

  async function setCeiling(
    companyId: string,
    agentId: string,
    overrides: Partial<AgentGovernancePolicy>,
  ) {
    const svc = agentGovernanceService(db);
    const current = await svc.getForAgent(companyId, agentId);
    return svc.updateOwnerCeiling(companyId, agentId, {
      policy: {
        permissions: [AGENT_POLICY_WILDCARD],
        monthlyBudgetCents: AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
        destructiveActions: "approval_required",
        dataScopes: [AGENT_POLICY_WILDCARD],
        providers: [AGENT_POLICY_WILDCARD],
        minimumApproval: "steward",
        ...overrides,
      },
      revision: current.revision,
      actorUserId: "owner-1",
      channel: "web",
    });
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
    app.use(errorHandler);
    return app;
  }

  function agentActor(companyId: string, agentId: string) {
    return { type: "agent", agentId, companyId, source: "agent_key", companyIds: [companyId] };
  }

  function stewardActor(companyId: string, userId: string) {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
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

  /** Agent files a write request through the real route. */
  async function requestWrite(
    company: { id: string },
    agent: { id: string },
    body: Record<string, unknown> = {},
  ) {
    const app = makeApp(agentActor(company.id, agent.id));
    return call(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/hubspot/contacts/write`)
        .send({ operation: "create", properties: PROPERTIES, ...body }),
    );
  }

  /** Steward decides through the real approval route. */
  async function decide(
    company: { id: string },
    steward: { principalId: string },
    approvalId: string,
    action: "approve" | "reject",
    extra: Record<string, unknown> = {},
  ) {
    const app = makeApp(stewardActor(company.id, steward.principalId));
    const approval = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0]!);
    return call(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/approvals/${approvalId}/${action}`)
        .send({
          revision: approval.revision,
          idempotencyKey: `test-${action}-${randomUUID()}`,
          channel: "web",
          ...extra,
        }),
    );
  }

  // -- request -------------------------------------------------------------

  it("turns an agent write request into an approval and writes nothing yet", async () => {
    const { company, agent } = await seed();

    const res = await requestWrite(company, agent);

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.approvalId).toBeTruthy();
    const stored = await db.select().from(approvals).then((rows) => rows[0]!);
    expect(stored.type).toBe("connector_send");
    expect(stored.status).toBe("pending");
    expect(stored.requestedByAgentId).toBe(agent.id);
    // The whole point: asking is not doing.
    expect(crmWrites(), "the agent's request reached HubSpot before any decision").toHaveLength(0);
  });

  it("records the digest of exactly what was approved", async () => {
    const { company, agent } = await seed();

    await requestWrite(company, agent);

    const stored = await db.select().from(approvals).then((rows) => rows[0]!);
    const payload = stored.payload as Record<string, unknown>;
    const expected = createHash("sha256")
      .update(JSON.stringify(PROPERTIES))
      .digest("hex");
    // Without this a payload could be swapped between decision and execution
    // and nothing downstream would notice.
    expect(payload.payloadDigest).toBe(expected);
  });

  it("gives a connector_send approval an expiry", async () => {
    const { company, agent } = await seed();

    await requestWrite(company, agent);

    const stored = await db.select().from(approvals).then((rows) => rows[0]!);
    expect(stored.expiresAt, "connector_send approvals must expire").not.toBeNull();
  });

  it("refuses a write request the ceiling does not allow", async () => {
    const { company, agent } = await seed();
    await setCeiling(company.id, agent.id, { providers: ["telegram"] });

    const res = await requestWrite(company, agent);

    expect(res.status).toBe(403);
    expect(await db.select().from(approvals)).toHaveLength(0);
  });

  it("refuses a board user on the agent-facing write route", async () => {
    const { company, steward } = await seed();
    const app = makeApp(stewardActor(company.id, steward.principalId));

    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/hubspot/contacts/write`)
        .send({ operation: "create", properties: PROPERTIES }),
    );

    expect(res.status).toBe(403);
  });

  // -- execution on approval ----------------------------------------------

  it("executes the write when the steward approves, through the real route", async () => {
    // The wiring is the thing under test. A service-level test would prove the
    // executor works and say nothing about whether approving calls it.
    const { company, agent, steward, connection } = await seed();
    const filed = await requestWrite(company, agent);

    const decided = await decide(company, steward, filed.body.approvalId, "approve");

    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    const writes = crmWrites();
    expect(writes, "approving did not execute the write").toHaveLength(1);
    expect(writes[0].url).toContain("/crm/v3/objects/contacts");

    const execution = await db.select().from(connectorSendExecutions).then((rows) => rows[0]!);
    expect(execution.outcome).toBe("succeeded");
    expect(execution.externalId).toBe("hs-999");
    // Structured provenance: what ran, under whose credential, against which
    // decision, over which bytes.
    expect(execution.connectionId).toBe(connection.id);
    expect(execution.approvalId).toBe(filed.body.approvalId);
    expect(execution.payloadDigest).toBe(
      createHash("sha256").update(JSON.stringify(PROPERTIES)).digest("hex"),
    );
  });

  it("cancels a pending write when the ceiling narrows, so it can never be decided", async () => {
    // Two mechanisms guard this and they meet here. The ceiling clamp cancels
    // the pending approval outright, which means the steward is never shown a
    // card for work that can no longer happen — better than letting them
    // approve something that would then be refused at execution.
    const { company, agent, steward } = await seed();
    const filed = await requestWrite(company, agent);

    await setCeiling(company.id, agent.id, { providers: ["telegram"] });

    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, filed.body.approvalId))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("cancelled");

    const decided = await decide(company, steward, filed.body.approvalId, "approve");

    expect(decided.status, "a cancelled write was still decidable").toBeGreaterThanOrEqual(400);
    expect(crmWrites(), "a narrowed ceiling did not stop the write").toHaveLength(0);
  });

  it("re-checks the ceiling at execution even when the clamp did not fire", async () => {
    // The clamp only runs when the ceiling changes through applyUpdate. This
    // narrows the stored policy directly, which is the shape of any path that
    // bypasses it — the execution-time check is the backstop, and it has to
    // hold on its own.
    const { company, agent, steward } = await seed();
    await setCeiling(company.id, agent.id, { providers: ["hubspot"] });
    const filed = await requestWrite(company, agent);

    await db
      .update(agentGovernancePolicies)
      .set({
        effectivePolicy: {
          permissions: [AGENT_POLICY_WILDCARD],
          monthlyBudgetCents: AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
          destructiveActions: "approval_required",
          dataScopes: [AGENT_POLICY_WILDCARD],
          providers: ["telegram"],
          minimumApproval: "steward",
        },
      })
      .where(eq(agentGovernancePolicies.agentId, agent.id));

    await decide(company, steward, filed.body.approvalId, "approve");

    expect(crmWrites(), "the execution-time ceiling check did not hold").toHaveLength(0);
    const execution = await db.select().from(connectorSendExecutions).then((rows) => rows[0] ?? null);
    expect(execution?.outcome).toBe("failed");
    expect(execution?.reason).toBe("provider_not_allowed");
  });

  it("blocks execution when the connection was revoked after the request was filed", async () => {
    const { company, agent, steward, connection } = await seed();
    const filed = await requestWrite(company, agent);
    await connectorService(db).revoke(connection.id, "user", "owner-1");

    await decide(company, steward, filed.body.approvalId, "approve");

    expect(crmWrites()).toHaveLength(0);
    const execution = await db.select().from(connectorSendExecutions).then((rows) => rows[0] ?? null);
    expect(execution?.outcome).toBe("failed");
  });

  it("refuses to execute an approval that has expired", async () => {
    const { company, agent, steward } = await seed();
    const filed = await requestWrite(company, agent);
    await db
      .update(approvals)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(approvals.id, filed.body.approvalId));

    await decide(company, steward, filed.body.approvalId, "approve");

    expect(crmWrites(), "an expired approval executed anyway").toHaveLength(0);
    const execution = await db.select().from(connectorSendExecutions).then((rows) => rows[0] ?? null);
    expect(execution?.outcome).toBe("failed");
    expect(execution?.reason).toBe("approval_expired");
  });

  it("terminates an ambiguous provider failure as outcome_unknown", async () => {
    // A 5xx may mean the write landed. Recording it as `failed` invites a retry
    // that duplicates a CRM record, which is worse than a missing one.
    const { company, agent, steward } = await seed();
    handler = (url) =>
      url.includes("/crm/v3/objects/") ? { status: 502, body: {} } : { status: 200, body: {} };
    const filed = await requestWrite(company, agent);

    await decide(company, steward, filed.body.approvalId, "approve");

    const execution = await db.select().from(connectorSendExecutions).then((rows) => rows[0]!);
    expect(execution.outcome).toBe("outcome_unknown");
  });

  it("treats a clean 4xx as failed rather than unknown", async () => {
    // A 400 is unambiguous: nothing landed. Calling that `outcome_unknown`
    // would make the genuinely ambiguous case unreadable.
    const { company, agent, steward } = await seed();
    handler = (url) =>
      url.includes("/crm/v3/objects/") ? { status: 400, body: {} } : { status: 200, body: {} };
    const filed = await requestWrite(company, agent);

    await decide(company, steward, filed.body.approvalId, "approve");

    const execution = await db.select().from(connectorSendExecutions).then((rows) => rows[0]!);
    expect(execution.outcome).toBe("failed");
  });

  it("never executes the same approval twice", async () => {
    const { company, agent, steward } = await seed();
    const filed = await requestWrite(company, agent);
    await decide(company, steward, filed.body.approvalId, "approve");
    const afterFirst = crmWrites().length;

    // A replayed decision must not produce a second write.
    await decide(company, steward, filed.body.approvalId, "approve");

    expect(crmWrites().length, "a replayed approval wrote twice").toBe(afterFirst);
    expect(await db.select().from(connectorSendExecutions)).toHaveLength(1);
  });

  it("records a rejection as a reasoned terminal state and writes nothing", async () => {
    const { company, agent, steward } = await seed();
    const filed = await requestWrite(company, agent);

    await decide(company, steward, filed.body.approvalId, "reject", {
      decisionNote: "Wrong contact — this is a duplicate of an existing lead.",
    });

    expect(crmWrites()).toHaveLength(0);
    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, filed.body.approvalId))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("rejected");
    // The agent has to be able to read WHY, or it will refile the same request.
    expect(stored.decisionNote).toContain("duplicate");
  });

  it("keeps the written payload out of the completion record", async () => {
    // Reference-not-content: the execution row is the agent's feedback channel,
    // and echoing the payload back into it duplicates CRM data into a second
    // store with different access rules.
    const { company, agent, steward } = await seed();
    const filed = await requestWrite(company, agent);

    await decide(company, steward, filed.body.approvalId, "approve");

    const execution = await db.select().from(connectorSendExecutions).then((rows) => rows[0]!);
    const serialized = JSON.stringify(execution);
    expect(serialized).not.toContain("lead@example.com");
    expect(serialized).not.toContain("Ada");
  });

  it("leaves default-profile companies alone", async () => {
    const { company, agent } = await seed("default");

    const res = await requestWrite(company, agent);

    // Off-profile the MK routes are 404, exactly as every other profile route.
    expect(res.status).toBe(404);
  });
});
