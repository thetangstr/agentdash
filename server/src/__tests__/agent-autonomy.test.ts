import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentStewardships,
  authUsers,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import {
  agentAccountabilityService,
  assertAgentMayHoldKey,
  normalizeAgentAutonomy,
} from "../services/agent-accountability.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

async function createCompany(db: TestDb) {
  return db
    .insert(companies)
    .values({
      name: `Autonomy ${randomUUID()}`,
      issuePrefix: `AU${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createMember(
  db: TestDb,
  companyId: string,
  input: { name?: string; email?: string; role?: string; status?: string } = {},
) {
  const userId = randomUUID();
  if (input.name || input.email) {
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: input.name ?? null,
      email: input.email ?? `${userId}@example.test`,
      createdAt: now,
      updatedAt: now,
    });
  }
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: userId,
    status: input.status ?? "active",
    membershipRole: input.role ?? "admin",
  });
  return userId;
}

async function createAgent(
  db: TestDb,
  companyId: string,
  input: { name?: string; autonomy?: string; accountableUserId?: string | null } = {},
) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: input.name ?? `Agent ${randomUUID()}`,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "echo" },
      ...(input.autonomy ? { autonomy: input.autonomy } : {}),
      ...(input.accountableUserId !== undefined
        ? { accountableUserId: input.accountableUserId }
        : {}),
    })
    .returning()
    .then((rows) => rows[0]!);
}

/**
 * The database's own complaint about a rejected write.
 *
 * Drizzle wraps the driver error, so the outer message is only "Failed query:
 * insert into agents" and the constraint that actually refused the row is on the
 * cause. Asserting on the constraint name is the point: it proves the invariant
 * holds below the application, not just in the route.
 */
async function violation(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!error) throw new Error("expected the write to be refused, but it succeeded");
  const cause = (error as { cause?: unknown }).cause;
  return `${String(error)} ${String(cause ?? "")}`;
}

function makeBoardActor(companyId: string, userId: string) {
  return {
    type: "board",
    userId,
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
  };
}

async function createApp(db: TestDb, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await import("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

/**
 * The gap this covers: "no active stewardship" used to mean two opposite things.
 *
 * An agent nobody had paired with and an agent deliberately running without a
 * person were the same row, so an approval card for either was delivered to
 * nobody, no screen could say which case it was showing, and an admin could not
 * hold more than one agent because the only way to be answerable for one was to
 * steward it. `agents.autonomy` names the kind; accountability is resolved from
 * the steward for one kind and from `accountable_user_id` for the other.
 */
describeEmbeddedPostgres("agent autonomy and accountability", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-autonomy-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // TRUNCATE … CASCADE rather than a list of deletes: agents are referenced by
    // connect codes, keys and budget policies, and a per-table cleanup here
    // fails on whichever dependent table a new test happens to touch.
    await db.execute(sql`truncate table ${companies}, ${authUsers} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("resolving who answers for an agent", () => {
    it("names the steward for a stewarded agent", async () => {
      const company = await createCompany(db);
      const userId = await createMember(db, company.id, { name: "Ada", email: "ada@example.test" });
      const agent = await createAgent(db, company.id);
      await agentStewardshipService(db).assign(company.id, {
        agentId: agent.id,
        userId,
        assignedByUserId: userId,
      });

      const resolved = await agentAccountabilityService(db).resolveForAgent(company.id, agent.id);
      expect(resolved).toMatchObject({
        autonomy: "stewarded",
        userId,
        via: "steward",
        name: "Ada",
      });
    });

    it("names the assigned human for an autonomous agent", async () => {
      // The behaviour that did not exist: an autonomous agent had no steward, so
      // every escalation path resolved to null and reached nobody.
      const company = await createCompany(db);
      const userId = await createMember(db, company.id, { name: "Grace", email: "g@example.test" });
      const agent = await createAgent(db, company.id, {
        autonomy: "autonomous",
        accountableUserId: userId,
      });

      const accountability = agentAccountabilityService(db);
      expect(await accountability.escalationUserId(company.id, agent.id)).toBe(userId);
      expect(await accountability.resolveForAgent(company.id, agent.id)).toMatchObject({
        autonomy: "autonomous",
        via: "assignment",
        name: "Grace",
      });
    });

    it("reports a stewarded agent nobody has paired with as unpaired, not autonomous", async () => {
      // The third state, and the one somebody has to fix. Reporting it as
      // autonomous would hide unfinished setup behind a deliberate-looking
      // configuration.
      const company = await createCompany(db);
      const agent = await createAgent(db, company.id);

      expect(await agentAccountabilityService(db).resolveForAgent(company.id, agent.id))
        .toMatchObject({ autonomy: "stewarded", userId: null, via: "unpaired" });
    });

    it("still names the person when they have no auth user row", async () => {
      // `user_id` is a durable principal id, not a foreign key into the auth
      // table, so an accountable party legitimately has no name to show. The id
      // is what identifies them.
      const company = await createCompany(db);
      const userId = await createMember(db, company.id);
      const agent = await createAgent(db, company.id, {
        autonomy: "autonomous",
        accountableUserId: userId,
      });

      expect(await agentAccountabilityService(db).resolveForAgent(company.id, agent.id))
        .toMatchObject({ userId, name: null, email: null, via: "assignment" });
    });

    it("resolves a mix of kinds in one batched call", async () => {
      const company = await createCompany(db);
      const stewardId = await createMember(db, company.id);
      const ownerId = await createMember(db, company.id);
      const paired = await createAgent(db, company.id);
      const autonomous = await createAgent(db, company.id, {
        autonomy: "autonomous",
        accountableUserId: ownerId,
      });
      const unpaired = await createAgent(db, company.id);
      await agentStewardshipService(db).assign(company.id, {
        agentId: paired.id,
        userId: stewardId,
        assignedByUserId: stewardId,
      });

      const map = await agentAccountabilityService(db).resolveForAgents(company.id, [
        paired.id,
        autonomous.id,
        unpaired.id,
      ]);
      expect(map.get(paired.id)?.via).toBe("steward");
      expect(map.get(autonomous.id)?.userId).toBe(ownerId);
      expect(map.get(unpaired.id)?.via).toBe("unpaired");
    });

    it("reads an unrecognised autonomy value as stewarded", () => {
      // The safe direction: a stewarded agent that is really autonomous looks
      // unfinished, while the reverse would strip a real steward's pairing.
      expect(normalizeAgentAutonomy("something-new")).toBe("stewarded");
      expect(normalizeAgentAutonomy(undefined)).toBe("stewarded");
      expect(normalizeAgentAutonomy("autonomous")).toBe("autonomous");
    });
  });

  describe("the invariant: nobody unanswerable for", () => {
    it("refuses an autonomous agent with no accountable human, in the database", async () => {
      // Enforced below the application because a migration or a psql session
      // can create agents too.
      const company = await createCompany(db);
      expect(
        await violation(createAgent(db, company.id, { autonomy: "autonomous", accountableUserId: null })),
      ).toMatch(/agents_accountable_ck/);
    });

    it("refuses an autonomy value that is neither kind", async () => {
      const company = await createCompany(db);
      expect(await violation(createAgent(db, company.id, { autonomy: "semi" }))).toMatch(
        /agents_autonomy_ck/,
      );
    });

    it("refuses to make someone accountable who is not a member here", async () => {
      const company = await createCompany(db);
      await expect(
        agentAccountabilityService(db).assertAccountableMember(company.id, randomUUID()),
      ).rejects.toThrow(/active member of this company/);
    });
  });

  describe("stewardship and keys", () => {
    it("refuses to pair a human with an autonomous agent", async () => {
      const company = await createCompany(db);
      const userId = await createMember(db, company.id);
      const agent = await createAgent(db, company.id, {
        name: "Nightly Sweeper",
        autonomy: "autonomous",
        accountableUserId: userId,
      });

      await expect(
        agentStewardshipService(db).assign(company.id, {
          agentId: agent.id,
          userId,
          assignedByUserId: userId,
        }),
      ).rejects.toThrow(/Nightly Sweeper is an autonomous agent/);
    });

    it("refuses a connect code for an autonomous agent", async () => {
      const company = await createCompany(db);
      const userId = await createMember(db, company.id);
      const agent = await createAgent(db, company.id, {
        autonomy: "autonomous",
        accountableUserId: userId,
      });
      const app = await createApp(db, makeBoardActor(company.id, userId));

      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agent.id}/connect-codes`).send({}),
      );
      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/no key or connect code can be issued/);
    });

    it("still issues a connect code for a stewarded agent", async () => {
      const company = await createCompany(db);
      const userId = await createMember(db, company.id);
      const agent = await createAgent(db, company.id);
      const app = await createApp(db, makeBoardActor(company.id, userId));

      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/agents/${agent.id}/connect-codes`).send({}),
      );
      expect(response.status).toBe(201);
    });

    it("guards the key path on the kind, not on the caller", () => {
      expect(() => assertAgentMayHoldKey({ name: "Scribe", autonomy: "stewarded" })).not.toThrow();
      expect(() => assertAgentMayHoldKey({ name: "Scribe", autonomy: "autonomous" })).toThrow(
        /Scribe is an autonomous agent/,
      );
    });
  });

  describe("creating an agent", () => {
    it("creates a stewarded agent by default and pairs the creator with it", async () => {
      const company = await createCompany(db);
      const userId = await createMember(db, company.id);
      const app = await createApp(db, makeBoardActor(company.id, userId));

      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/companies/${company.id}/agents`).send({
          name: "Personal",
          role: "engineer",
          adapterType: "process",
          adapterConfig: { command: "echo" },
        }),
      );
      expect(response.status).toBe(201);
      expect(response.body.autonomy).toBe("stewarded");
      const pairing = await db
        .select()
        .from(agentStewardships)
        .where(
          and(
            eq(agentStewardships.companyId, company.id),
            eq(agentStewardships.userId, userId),
            isNull(agentStewardships.endedAt),
          ),
        );
      expect(pairing).toHaveLength(1);
    });

    it("makes the creator accountable for an autonomous agent, and pairs nobody with it", async () => {
      const company = await createCompany(db);
      const userId = await createMember(db, company.id);
      const app = await createApp(db, makeBoardActor(company.id, userId));

      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/companies/${company.id}/agents`).send({
          name: "Sweeper",
          role: "engineer",
          adapterType: "process",
          adapterConfig: { command: "echo" },
          autonomy: "autonomous",
        }),
      );
      expect(response.status).toBe(201);
      expect(response.body.autonomy).toBe("autonomous");
      expect(response.body.accountableUserId).toBe(userId);
      const pairings = await db
        .select()
        .from(agentStewardships)
        .where(eq(agentStewardships.companyId, company.id));
      expect(pairings).toHaveLength(0);
    });

    it("lets one person be accountable for several autonomous agents", async () => {
      // The limit that started this: stewardship is 1:1, so being answerable for
      // a second agent was impossible. Accountability is not.
      const company = await createCompany(db);
      const userId = await createMember(db, company.id);
      const app = await createApp(db, makeBoardActor(company.id, userId));

      for (const name of ["Sweeper", "Reporter", "Watcher"]) {
        const response = await requestApp(app, (baseUrl) =>
          request(baseUrl).post(`/api/companies/${company.id}/agents`).send({
            name,
            role: "engineer",
            adapterType: "process",
            adapterConfig: { command: "echo" },
            autonomy: "autonomous",
          }),
        );
        expect(response.status).toBe(201);
      }

      const rows = await db.select().from(agents).where(eq(agents.companyId, company.id));
      expect(rows.filter((row) => row.accountableUserId === userId)).toHaveLength(3);
    });

    it("refuses accountableUserId on a stewarded agent rather than storing a second answer", async () => {
      const company = await createCompany(db);
      const userId = await createMember(db, company.id);
      const other = await createMember(db, company.id);
      const app = await createApp(db, makeBoardActor(company.id, userId));

      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/companies/${company.id}/agents`).send({
          name: "Confused",
          role: "engineer",
          adapterType: "process",
          adapterConfig: { command: "echo" },
          accountableUserId: other,
        }),
      );
      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/takes its accountable human from its steward/);
    });

    it("refuses to make a non-member accountable", async () => {
      const company = await createCompany(db);
      const userId = await createMember(db, company.id);
      const app = await createApp(db, makeBoardActor(company.id, userId));

      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl).post(`/api/companies/${company.id}/agents`).send({
          name: "Orphan",
          role: "engineer",
          adapterType: "process",
          adapterConfig: { command: "echo" },
          autonomy: "autonomous",
          accountableUserId: randomUUID(),
        }),
      );
      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/active member of this company/);
    });
  });

  describe("transferring accountability", () => {
    it("moves an autonomous agent to another member and records it", async () => {
      // Decision 2026-08-19: whoever holds accountability can hand it on. The
      // person who set an agent running is often not the person who should be
      // woken by it later.
      const company = await createCompany(db);
      const owner = await createMember(db, company.id);
      const successor = await createMember(db, company.id);
      const agent = await createAgent(db, company.id, {
        autonomy: "autonomous",
        accountableUserId: owner,
      });
      const app = await createApp(db, makeBoardActor(company.id, owner));

      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agent.id}`).send({ accountableUserId: successor }),
      );
      expect(response.status).toBe(200);
      expect(response.body.accountableUserId).toBe(successor);

      const audit = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "agent.accountability_changed"));
      expect(audit).toHaveLength(1);
      expect(audit[0]!.details).toMatchObject({
        fromAccountableUserId: owner,
        toAccountableUserId: successor,
      });
    });

    it("refuses to make a paired agent autonomous without ending the pairing first", async () => {
      // Doing it silently would take away that person's My Agent page, their
      // connect code and their channel binding as a side effect of a field edit.
      const company = await createCompany(db);
      const steward = await createMember(db, company.id, { name: "Ada", email: "ada@example.test" });
      const agent = await createAgent(db, company.id, { name: "Scribe" });
      await agentStewardshipService(db).assign(company.id, {
        agentId: agent.id,
        userId: steward,
        assignedByUserId: steward,
      });
      const app = await createApp(db, makeBoardActor(company.id, steward));

      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agent.id}`).send({ autonomy: "autonomous" }),
      );
      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/Scribe is stewarded by Ada/);
    });

    it("turns an unpaired agent autonomous, defaulting accountability to the person doing it", async () => {
      const company = await createCompany(db);
      const admin = await createMember(db, company.id);
      const agent = await createAgent(db, company.id);
      const app = await createApp(db, makeBoardActor(company.id, admin));

      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agent.id}`).send({ autonomy: "autonomous" }),
      );
      expect(response.status).toBe(200);
      expect(response.body.autonomy).toBe("autonomous");
      expect(response.body.accountableUserId).toBe(admin);
    });

    it("clears the accountable column when an agent becomes stewarded again", async () => {
      // Otherwise the agent carries two answers to "who answers for this?" the
      // moment a steward is assigned.
      const company = await createCompany(db);
      const owner = await createMember(db, company.id);
      const agent = await createAgent(db, company.id, {
        autonomy: "autonomous",
        accountableUserId: owner,
      });
      const app = await createApp(db, makeBoardActor(company.id, owner));

      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/agents/${agent.id}`).send({ autonomy: "stewarded" }),
      );
      expect(response.status).toBe(200);
      expect(response.body.autonomy).toBe("stewarded");
      expect(response.body.accountableUserId).toBeNull();
    });
  });

  describe("what an agent and a board can read", () => {
    it("carries the kind and the accountable person on the agent list", async () => {
      const company = await createCompany(db);
      const owner = await createMember(db, company.id, { name: "Rowan", email: "rowan@example.test" });
      const autonomous = await createAgent(db, company.id, {
        name: "Sweeper",
        autonomy: "autonomous",
        accountableUserId: owner,
      });
      const app = await createApp(db, makeBoardActor(company.id, owner));

      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl).get(`/api/companies/${company.id}/agents`),
      );
      expect(response.status).toBe(200);
      const row = (response.body as Array<Record<string, any>>).find((a) => a.id === autonomous.id);
      expect(row?.autonomy).toBe("autonomous");
      expect(row?.steward).toBeNull();
      expect(row?.accountable).toMatchObject({ userId: owner, name: "Rowan", via: "assignment" });
    });

    it("reports accountable as null for an unpaired agent, so the two absences differ", async () => {
      const company = await createCompany(db);
      const admin = await createMember(db, company.id);
      const agent = await createAgent(db, company.id);
      const app = await createApp(db, makeBoardActor(company.id, admin));

      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl).get(`/api/companies/${company.id}/agents`),
      );
      const row = (response.body as Array<Record<string, any>>).find((a) => a.id === agent.id);
      expect(row?.autonomy).toBe("stewarded");
      expect(row?.accountable).toBeNull();
    });
  });
});
