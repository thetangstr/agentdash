import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentStewardships,
  approvals,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentdashMkInboxRoutes } from "../routes/agentdash-mk-inbox.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

describeEmbeddedPostgres("agentdash-mk personal inbox", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mk-inbox-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(profile: "default" | "agentdash_mk" = "agentdash_mk") {
    return db
      .insert(companies)
      .values({
        name: `Inbox ${randomUUID()}`,
        issuePrefix: `IN${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: profile,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createMember(companyId: string, role = "operator") {
    return db
      .insert(companyMemberships)
      .values({
        companyId,
        principalType: "user",
        principalId: randomUUID(),
        status: "active",
        membershipRole: role,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createAgent(companyId: string, name = "Agent") {
    return db
      .insert(agents)
      .values({
        companyId,
        name: `${name} ${randomUUID()}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createApproval(companyId: string, requestedByAgentId: string | null) {
    return db
      .insert(approvals)
      .values({
        companyId,
        type: "request_board_approval",
        requestedByAgentId,
        status: "pending",
        payload: { summary: "Ship the board deck" },
      })
      .returning()
      .then((rows) => rows[0]!);
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

  async function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor, companyIds: [...((actor.companyIds as string[]) ?? [])] };
      next();
    });
    app.use("/api", agentdashMkInboxRoutes(db));
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

  async function seed() {
    const company = await createCompany();
    const owner = await createMember(company.id, "owner");
    const steward = await createMember(company.id);
    const otherSteward = await createMember(company.id);
    const myAgent = await createAgent(company.id, "Mine");
    const otherAgent = await createAgent(company.id, "Theirs");
    const svc = agentStewardshipService(db);
    await svc.assign(company.id, {
      agentId: myAgent.id,
      userId: steward.principalId,
      assignedByUserId: owner.principalId,
    });
    await svc.assign(company.id, {
      agentId: otherAgent.id,
      userId: otherSteward.principalId,
      assignedByUserId: owner.principalId,
    });
    const mine = await createApproval(company.id, myAgent.id);
    const theirs = await createApproval(company.id, otherAgent.id);
    return { company, owner, steward, otherSteward, myAgent, otherAgent, mine, theirs };
  }

  it("returns only approvals requested by the caller's stewarded agent", async () => {
    const { company, steward, mine, myAgent } = await seed();
    const app = await createApp(boardActor(company.id, steward.principalId));

    const res = await call(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/me/inbox`),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items.map((item: { approvalId: string }) => item.approvalId)).toEqual([mine.id]);
    expect(res.body.items[0]).toMatchObject({
      approvalId: mine.id,
      requestingAgent: { id: myAgent.id },
      revision: 1,
      status: "pending",
    });
  });

  it("never accepts a caller-supplied user id", async () => {
    const { company, steward, otherSteward, mine } = await seed();
    const app = await createApp(boardActor(company.id, steward.principalId));

    // The identity is the authenticated session, full stop — a query parameter
    // must not be able to read another member's inbox.
    const res = await call(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/me/inbox?userId=${otherSteward.principalId}`),
    );

    expect(res.status).toBe(200);
    expect(res.body.items.map((item: { approvalId: string }) => item.approvalId)).toEqual([mine.id]);
  });

  it("returns an empty inbox rather than an error when the caller stewards no agent", async () => {
    const { company, owner } = await seed();
    const app = await createApp(boardActor(company.id, owner.principalId, "owner"));

    const res = await call(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/me/inbox`),
    );

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.stewardedAgent).toBeNull();
  });

  it("exposes an owner/admin override view that is separate from the ordinary inbox", async () => {
    const { company, owner, steward, mine, theirs } = await seed();

    const ownerApp = await createApp(boardActor(company.id, owner.principalId, "owner"));
    const overrideRes = await call(ownerApp, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/inbox/override`),
    );
    expect(overrideRes.status, JSON.stringify(overrideRes.body)).toBe(200);
    expect(overrideRes.body.items.map((item: { approvalId: string }) => item.approvalId).sort()).toEqual(
      [mine.id, theirs.id].sort(),
    );
    // Override items must be labelled as exceptional so the UI cannot render
    // them as ordinary approval controls.
    for (const item of overrideRes.body.items) {
      expect(item.requiresOverride).toBe(true);
    }

    const stewardApp = await createApp(boardActor(company.id, steward.principalId));
    const denied = await call(stewardApp, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/inbox/override`),
    );
    expect(denied.status).toBe(403);
  });

  it("404s both routes for a company that is not agentdash_mk", async () => {
    const company = await createCompany("default");
    const member = await createMember(company.id, "owner");
    const app = await createApp(boardActor(company.id, member.principalId, "owner"));

    const inbox = await call(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/me/inbox`),
    );
    expect(inbox.status).toBe(404);

    const override = await call(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/inbox/override`),
    );
    expect(override.status).toBe(404);
  });

  it("denies agent-authenticated callers", async () => {
    const { company, myAgent } = await seed();
    const app = await createApp({ type: "agent", companyId: company.id, agentId: myAgent.id });

    const res = await call(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/me/inbox`),
    );

    expect(res.status).toBe(403);
  });
});
