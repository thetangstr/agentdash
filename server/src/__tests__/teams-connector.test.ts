import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentStewardships,
  approvals,
  channelCallbackTokens,
  companies,
  companyMemberships,
  createDb,
  externalChannelEvents,
  humanChannelBindings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { teamsConnectorRoutes } from "../routes/teams-connector.js";
import { teamsConnectorService } from "../services/teams-connector.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { humanChannelService } from "../services/human-channels.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const TENANT = "tenant-1";
const AAD_ID = "aad-user-1";

describeEmbeddedPostgres("teams connector", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let outbound: Array<{ url: string; body: unknown }>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-teams-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(() => {
    outbound = [];
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      outbound.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({}) } as never;
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(activityLog);
    await db.delete(channelCallbackTokens);
    await db.delete(externalChannelEvents);
    await db.delete(humanChannelBindings);
    await db.delete(approvals);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const company = await db
      .insert(companies)
      .values({
        name: `Teams ${randomUUID()}`,
        issuePrefix: `TM${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: "agentdash_mk",
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
    const binding = await humanChannelService(db).verifyBinding(company.id, {
      provider: "teams",
      userId: steward.principalId,
      externalTenantId: TENANT,
      externalUserId: AAD_ID,
      externalConversationId: "conv-1",
      metadata: { serviceUrl: "https://smba.example/teams" },
    });
    const approval = await db
      .insert(approvals)
      .values({
        companyId: company.id,
        type: "request_board_approval",
        requestedByAgentId: agent.id,
        status: "pending",
        payload: { summary: "Ship it" },
      })
      .returning()
      .then((rows) => rows[0]!);
    return { company, owner, steward, agent, binding, approval };
  }

  /**
   * The route is created with an explicit validator so tests never rely on a
   * global skipAuth. Production wires the real SDK validator instead.
   */
  function createApp(options: { authenticate?: boolean } = {}) {
    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      teamsConnectorRoutes(db, {
        verifyActivity: async (req) =>
          options.authenticate === false
            ? null
            : req.header("authorization")
              ? { tenantId: TENANT, aadObjectId: AAD_ID }
              : null,
      }),
    );
    app.use(errorHandler);
    return app;
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

  const messagesPath = "/api/connectors/teams/messages";

  function invokeActivity(token: string, overrides: Record<string, unknown> = {}) {
    return {
      type: "invoke",
      name: "adaptiveCard/action",
      id: `activity-${randomUUID()}`,
      channelData: { tenant: { id: TENANT } },
      from: { aadObjectId: AAD_ID },
      conversation: { id: "conv-1" },
      serviceUrl: "https://smba.example/teams",
      value: {
        action: {
          type: "Action.Execute",
          verb: "agentdash.approval.decide",
          data: { token },
        },
      },
      ...overrides,
    };
  }

  it("rejects an unauthenticated Teams activity", async () => {
    await seed();
    const app = createApp({ authenticate: false });

    const res = await call(app, (baseUrl) =>
      request(baseUrl).post(messagesPath).send({ type: "message", id: "a-1" }),
    );

    expect(res.status).toBe(401);
    expect(await db.select().from(externalChannelEvents)).toHaveLength(0);
  });

  it("builds Adaptive Cards with Action.Execute and never legacy Action.Submit", async () => {
    const { company, approval, binding } = await seed();
    const card = await teamsConnectorService(db).buildApprovalCard({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      bindingId: binding.id,
      summary: "Ship it",
    });

    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("Action.Submit");
    const actions = card.body ? card.actions ?? [] : card.actions ?? [];
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action.type).toBe("Action.Execute");
      expect(action.verb).toBe("agentdash.approval.decide");
      // Opaque handle only — the card must not carry the authority itself.
      expect(JSON.stringify(action.data)).not.toContain(approval.id);
    }
  });

  it("routes Action.Execute through the shared approval authority", async () => {
    const { company, approval, binding, steward } = await seed();
    const token = await teamsConnectorService(db).issueCallbackToken({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      decision: "approved",
      bindingId: binding.id,
    });

    const app = createApp();
    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(messagesPath)
        .set("authorization", "Bearer test")
        .send(invokeActivity(token)),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("approved");
    expect(stored.decisionChannel).toBe("teams");
    expect(stored.decisionActorRole).toBe("steward");
    expect(stored.decidedByUserId).toBe(steward.principalId);
  });

  it("deduplicates a redelivered activity so it decides only once", async () => {
    const { company, approval, binding } = await seed();
    const token = await teamsConnectorService(db).issueCallbackToken({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      decision: "approved",
      bindingId: binding.id,
    });
    const activity = invokeActivity(token);
    const app = createApp();

    await call(app, (baseUrl) =>
      request(baseUrl).post(messagesPath).set("authorization", "Bearer test").send(activity),
    );
    await call(app, (baseUrl) =>
      request(baseUrl).post(messagesPath).set("authorization", "Bearer test").send(activity),
    );

    const decisions = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "approval.approved"));
    expect(decisions).toHaveLength(1);
  });

  it("fails closed when the Entra tenant does not match the binding", async () => {
    const { company, approval, binding } = await seed();
    const token = await teamsConnectorService(db).issueCallbackToken({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      decision: "approved",
      bindingId: binding.id,
    });

    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      teamsConnectorRoutes(db, {
        // Same AAD user id, different tenant — a cross-tenant replay.
        verifyActivity: async () => ({ tenantId: "other-tenant", aadObjectId: AAD_ID }),
      }),
    );
    app.use(errorHandler);

    const res = await call(app, (baseUrl) =>
      request(baseUrl).post(messagesPath).set("authorization", "Bearer test").send(invokeActivity(token)),
    );

    expect(res.status).toBe(200);
    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("pending");
  });

  it("fails closed when the acting identity does not match the binding", async () => {
    const { company, approval, binding } = await seed();
    const token = await teamsConnectorService(db).issueCallbackToken({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      decision: "approved",
      bindingId: binding.id,
    });

    const app = express();
    app.use(express.json());
    app.use(
      "/api",
      teamsConnectorRoutes(db, {
        verifyActivity: async () => ({ tenantId: TENANT, aadObjectId: "someone-else" }),
      }),
    );
    app.use(errorHandler);

    const res = await call(app, (baseUrl) =>
      request(baseUrl).post(messagesPath).set("authorization", "Bearer test").send(invokeActivity(token)),
    );

    expect(res.status).toBe(200);
    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("pending");
  });

  it("fails a stale revision closed", async () => {
    const { company, approval, binding } = await seed();
    const token = await teamsConnectorService(db).issueCallbackToken({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      decision: "approved",
      bindingId: binding.id,
    });
    await db.update(approvals).set({ revision: 9 }).where(eq(approvals.id, approval.id));

    const app = createApp();
    const res = await call(app, (baseUrl) =>
      request(baseUrl).post(messagesPath).set("authorization", "Bearer test").send(invokeActivity(token)),
    );

    expect(res.status).toBe(200);
    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("pending");
  });

  it("refuses a decision from a revoked binding", async () => {
    const { company, approval, binding } = await seed();
    const token = await teamsConnectorService(db).issueCallbackToken({
      companyId: company.id,
      approvalId: approval.id,
      revision: approval.revision,
      decision: "approved",
      bindingId: binding.id,
    });
    await humanChannelService(db).revokeBinding(company.id, binding.id, { actorUserId: null });

    const app = createApp();
    const res = await call(app, (baseUrl) =>
      request(baseUrl).post(messagesPath).set("authorization", "Bearer test").send(invokeActivity(token)),
    );

    expect(res.status).toBe(200);
    const stored = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("pending");
  });

  it("retains the conversation reference needed for a proactive reply", async () => {
    const { company, binding } = await seed();
    const reference = await teamsConnectorService(db).resolveConversationReference(
      company.id,
      binding.userId,
    );

    expect(reference).toMatchObject({
      conversationId: "conv-1",
      serviceUrl: "https://smba.example/teams",
      tenantId: TENANT,
    });
  });
});
