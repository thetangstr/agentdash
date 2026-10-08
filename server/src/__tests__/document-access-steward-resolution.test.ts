import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentGovernancePolicies,
  agentStewardships,
  agents,
  companies,
  companyMemberships,
  connections,
  createDb,
  humanChannelBindings,
} from "@paperclipai/db";
import {
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  AGENT_POLICY_WILDCARD,
  DOCUMENT_PROVIDERS,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { connectorRoutes } from "../routes/connectors.js";
import { agentGovernanceService } from "../services/agent-governance.js";
import {
  agentStewardshipService,
  endStewardshipForTerminatedAgent,
} from "../services/agent-stewardships.js";
import { connectorService } from "../services/connectors.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const MIGRATION_FILE = path.join(
  repoRoot,
  "packages/db/src/migrations/0147_document_connection_owner_uq.sql",
);

/**
 * Document access, slice 1: an agent resolves a document-provider connection
 * ONLY through its live stewardship, and only the steward's own private row.
 *
 * A document connection is one person's delegated access to their own files.
 * The generic resolver also admits agent-owned and workspace-visible rows, and
 * consults the steward only when neither matched, so a shared row would shadow
 * the steward and hand every agent one person's documents. These tests pin the
 * narrower rule and the create-time refusals that keep those shapes out.
 */
describeEmbeddedPostgres("document providers resolve only through the live stewardship", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-doc-access-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(humanChannelBindings);
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

  // -- fixtures -----------------------------------------------------------

  /** Steward A stewards Agent A; Steward B stewards Agent B; Member C stewards nobody. */
  async function seed(profile: "agentdash_mk" | "default" = "default") {
    const company = await db
      .insert(companies)
      .values({
        name: `Docs ${randomUUID()}`,
        issuePrefix: `DA${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: profile,
      })
      .returning()
      .then((rows) => rows[0]!);

    async function member(role: string) {
      return db
        .insert(companyMemberships)
        .values({
          companyId: company.id,
          principalType: "user",
          principalId: randomUUID(),
          status: "active",
          membershipRole: role,
        })
        .returning()
        .then((rows) => rows[0]!);
    }

    async function agent(name: string) {
      return db
        .insert(agents)
        .values({
          companyId: company.id,
          name,
          role: "engineer",
          status: "idle",
          adapterType: "process",
        })
        .returning()
        .then((rows) => rows[0]!);
    }

    const owner = await member("owner");
    const stewardA = await member("operator");
    const stewardB = await member("operator");
    const memberC = await member("operator");
    const agentA = await agent("Agent A");
    const agentB = await agent("Agent B");

    const stewardships = agentStewardshipService(db);
    await stewardships.assign(company.id, {
      agentId: agentA.id,
      userId: stewardA.principalId,
      assignedByUserId: owner.principalId,
    });
    await stewardships.assign(company.id, {
      agentId: agentB.id,
      userId: stewardB.principalId,
      assignedByUserId: owner.principalId,
    });

    return { company, owner, stewardA, stewardB, memberC, agentA, agentB };
  }

  /** The production create path: a person's own private connection. */
  async function connectPrivate(companyId: string, userId: string, provider: string) {
    return connectorService(db).create(companyId, {
      ownerType: "user",
      ownerId: userId,
      provider,
      visibility: "private",
      accountLabel: "steward account",
      token: { accessToken: `token-${randomUUID()}` },
    });
  }

  /**
   * A row in a shape `create` now refuses (workspace-visible or agent-owned).
   * Inserted directly to stand for rows written before the refusal existed,
   * which resolution must still ignore.
   */
  async function insertLegacyRow(
    companyId: string,
    input: { provider: string; ownerType: "user" | "agent"; ownerId: string; visibility: string },
  ) {
    return db
      .insert(connections)
      .values({
        companyId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        provider: input.provider,
        visibility: input.visibility,
        status: "active",
        encryptedToken: { scheme: "test", ciphertext: "opaque" },
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function resolveFor(companyId: string, agentId: string, provider: string) {
    return connectorService(db).resolveActingAs(companyId, agentId, "read", provider);
  }

  // -- resolution ---------------------------------------------------------

  for (const provider of DOCUMENT_PROVIDERS) {
    it(`${provider}: a workspace-visible row owned by another person is never resolved for the agent`, async () => {
      const { company, memberC, agentA } = await seed();
      await insertLegacyRow(company.id, {
        provider,
        ownerType: "user",
        ownerId: memberC.principalId,
        visibility: "workspace",
      });

      const result = await resolveFor(company.id, agentA.id, provider);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.blocked.reason).toBe("no_connection");
    });

    it(`${provider}: a workspace-visible row does not shadow the steward's own private row`, async () => {
      const { company, stewardA, memberC, agentA } = await seed();
      const own = await connectPrivate(company.id, stewardA.principalId, provider);
      // Newer than the steward's row, so the generic "newest first" pick would
      // choose it if it were admitted at all.
      await insertLegacyRow(company.id, {
        provider,
        ownerType: "user",
        ownerId: memberC.principalId,
        visibility: "workspace",
      });

      const result = await resolveFor(company.id, agentA.id, provider);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.resolution.connectionId).toBe(own.id);
      expect(result.resolution.ownerId).toBe(stewardA.principalId);
    });

    it(`${provider}: an agent-owned row is never resolved, even for the agent that owns it`, async () => {
      const { company, agentA } = await seed();
      await insertLegacyRow(company.id, {
        provider,
        ownerType: "agent",
        ownerId: agentA.id,
        visibility: "private",
      });

      const result = await resolveFor(company.id, agentA.id, provider);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.blocked.reason).toBe("no_connection");
    });
  }

  it("resolves the steward's private row while the stewardship is active, without an owner ceiling", async () => {
    // Default profile: `resolveAgentPolicy` is null here, so this proves the
    // steward path is not gated on the product profile.
    const { company, stewardA, agentA } = await seed("default");
    const own = await connectPrivate(company.id, stewardA.principalId, "microsoft");

    const result = await resolveFor(company.id, agentA.id, "microsoft");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolution.connectionId).toBe(own.id);
    expect(result.resolution.ownerType).toBe("user");
    expect(result.resolution.ownerId).toBe(stewardA.principalId);
  });

  it("resolves the steward's private row in a profile company with a permissive ceiling", async () => {
    const { company, stewardA, agentA } = await seed("agentdash_mk");
    const governance = agentGovernanceService(db);
    const current = await governance.getForAgent(company.id, agentA.id);
    await governance.updateOwnerCeiling(company.id, agentA.id, {
      policy: {
        permissions: [AGENT_POLICY_WILDCARD],
        monthlyBudgetCents: AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
        destructiveActions: "approval_required",
        dataScopes: [AGENT_POLICY_WILDCARD],
        providers: [AGENT_POLICY_WILDCARD],
        minimumApproval: "steward",
      },
      revision: current.revision,
      actorUserId: "owner-1",
      channel: "web",
    });
    const own = await connectPrivate(company.id, stewardA.principalId, "microsoft");

    const result = await resolveFor(company.id, agentA.id, "microsoft");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolution.connectionId).toBe(own.id);
  });

  it("does not resolve the steward's row once it holds no credential", async () => {
    const { company, stewardA, agentA } = await seed();
    const own = await connectPrivate(company.id, stewardA.principalId, "microsoft");
    await db
      .update(connections)
      .set({ encryptedToken: null })
      .where(eq(connections.id, own.id));

    const result = await resolveFor(company.id, agentA.id, "microsoft");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blocked.reason).toBe("no_connection");
  });

  it("ending the stewardship makes the next resolve no_connection, with no revocation", async () => {
    const { company, owner, stewardA, agentA } = await seed();
    const own = await connectPrivate(company.id, stewardA.principalId, "microsoft");

    const before = await resolveFor(company.id, agentA.id, "microsoft");
    expect(before.ok, "precondition: the steward's row should resolve").toBe(true);

    const ended = await endStewardshipForTerminatedAgent(db, {
      companyId: company.id,
      agentId: agentA.id,
      endedByUserId: owner.principalId,
    });
    expect(ended).toHaveLength(1);

    const after = await resolveFor(company.id, agentA.id, "microsoft");
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.blocked.reason).toBe("no_connection");

    // Access lapsed because the stewardship did; the person keeps their grant.
    const row = await db
      .select()
      .from(connections)
      .where(eq(connections.id, own.id))
      .then((rows) => rows[0]!);
    expect(row.status).toBe("active");
    expect(row.revokedAt).toBeNull();
    expect(row.encryptedToken).not.toBeNull();
  });

  it("an agent with no stewardship resolves nothing", async () => {
    const { company, stewardA } = await seed();
    await connectPrivate(company.id, stewardA.principalId, "microsoft");
    const unstewarded = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Agent C",
        role: "engineer",
        status: "idle",
        adapterType: "process",
      })
      .returning()
      .then((rows) => rows[0]!);

    const result = await resolveFor(company.id, unstewarded.id, "microsoft");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blocked.reason).toBe("no_connection");
  });

  it("a second agent stewarded by someone else never resolves the first steward's row", async () => {
    const { company, stewardA, agentB } = await seed();
    const ownA = await connectPrivate(company.id, stewardA.principalId, "microsoft");

    const result = await resolveFor(company.id, agentB.id, "microsoft");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blocked.reason).toBe("no_connection");

    // Naming the row explicitly does not help either.
    const named = await connectorService(db).resolveActingAs(
      company.id,
      agentB.id,
      "read",
      "microsoft",
      { connectionId: ownA.id },
    );
    expect(named.ok).toBe(false);
  });

  it("each agent resolves its own steward's row when both stewards are connected", async () => {
    const { company, stewardA, stewardB, agentA, agentB } = await seed();
    const ownA = await connectPrivate(company.id, stewardA.principalId, "microsoft");
    const ownB = await connectPrivate(company.id, stewardB.principalId, "microsoft");

    const a = await resolveFor(company.id, agentA.id, "microsoft");
    const b = await resolveFor(company.id, agentB.id, "microsoft");
    expect(a.ok && a.resolution.connectionId).toBe(ownA.id);
    expect(b.ok && b.resolution.connectionId).toBe(ownB.id);
  });

  it("a person acting directly resolves only their own row", async () => {
    const { company, stewardA, memberC } = await seed();
    const own = await connectPrivate(company.id, stewardA.principalId, "microsoft");
    await insertLegacyRow(company.id, {
      provider: "microsoft",
      ownerType: "user",
      ownerId: memberC.principalId,
      visibility: "workspace",
    });

    const svc = connectorService(db);
    const self = await svc.resolveActingAs(company.id, stewardA.principalId, "read", "microsoft", {
      actorType: "user",
    });
    expect(self.ok && self.resolution.connectionId).toBe(own.id);

    // Member C's only row is their own (workspace-visible) one; Steward A's
    // private row is not theirs.
    const other = await svc.resolveActingAs(company.id, memberC.principalId, "read", "microsoft", {
      actorType: "user",
      connectionId: own.id,
    });
    expect(other.ok).toBe(false);
  });

  it("leaves non-document providers on the generic rule: a workspace row still resolves", async () => {
    const { company, memberC, agentA } = await seed();
    const shared = await insertLegacyRow(company.id, {
      provider: "slack",
      ownerType: "user",
      ownerId: memberC.principalId,
      visibility: "workspace",
    });

    const result = await resolveFor(company.id, agentA.id, "slack");
    expect(result.ok && result.resolution.connectionId).toBe(shared.id);
  });

  // -- create-time refusals -----------------------------------------------

  it("the service refuses an agent-owned or workspace-visible document connection with 422", async () => {
    const { company, stewardA, agentA } = await seed();
    const svc = connectorService(db);
    for (const provider of DOCUMENT_PROVIDERS) {
      await expect(
        svc.create(company.id, {
          ownerType: "agent",
          ownerId: agentA.id,
          provider,
          token: { accessToken: "x" },
        }),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        svc.create(company.id, {
          ownerType: "user",
          ownerId: stewardA.principalId,
          provider,
          visibility: "workspace",
          token: { accessToken: "x" },
        }),
      ).rejects.toSatisfy((error: unknown) => error instanceof HttpError && error.status === 422);
    }
    expect(await db.select().from(connections)).toHaveLength(0);
  });

  function boardActor(companyId: string, userId: string, role: string) {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
    };
  }

  function mountRoutes(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", connectorRoutes(db));
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

  it("the route refuses workspace visibility for document providers with 422 and a reason", async () => {
    const { company, stewardA } = await seed();
    const app = mountRoutes(boardActor(company.id, stewardA.principalId, "operator"));

    for (const provider of DOCUMENT_PROVIDERS) {
      const res = await call(app, (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${company.id}/connections`)
          .send({ provider, visibility: "workspace" }),
      );
      expect(res.status, provider).toBe(422);
      expect(String(res.body.error)).toMatch(/cannot be shared with the workspace/);
    }
    expect(await db.select().from(connections)).toHaveLength(0);

    // A private document connection and a workspace connection for a
    // non-document provider are both still accepted.
    const priv = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/connections`)
        .send({ provider: "microsoft", visibility: "private" }),
    );
    expect(priv.status).toBe(201);
    expect(priv.body.ownerType).toBe("user");
    expect(priv.body.visibility).toBe("private");

    const slack = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/connections`)
        .send({ provider: "slack", visibility: "workspace" }),
    );
    expect(slack.status).toBe(201);
  });

  it("the route refuses an agent creating a document connection", async () => {
    const { company, agentA } = await seed();
    // Agents are refused by the board check before ownership is considered;
    // the 422 ownership refusal behind it is covered at the service layer.
    const app = mountRoutes({
      type: "agent",
      agentId: agentA.id,
      companyId: company.id,
      source: "agent_key",
    });
    const res = await call(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/connections`)
        .send({ provider: "microsoft", visibility: "private" }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await db.select().from(connections)).toHaveLength(0);
  });

  it("the route refuses widening an existing document connection to the workspace", async () => {
    const { company, owner, stewardA } = await seed();
    const own = await connectPrivate(company.id, stewardA.principalId, "microsoft");
    const app = mountRoutes({
      ...boardActor(company.id, owner.principalId, "owner"),
      isInstanceAdmin: true,
    });

    const res = await call(app, (baseUrl) =>
      request(baseUrl).patch(`/api/connections/${own.id}`).send({ visibility: "workspace" }),
    );
    expect(res.status).toBe(422);
    const row = await db
      .select()
      .from(connections)
      .where(eq(connections.id, own.id))
      .then((rows) => rows[0]!);
    expect(row.visibility).toBe("private");
  });

  // -- migration ----------------------------------------------------------

  async function errorText(work: () => Promise<unknown>): Promise<string> {
    try {
      await work();
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause;
      return `${String(error)} ${cause ? String((cause as Error).message ?? cause) : ""}`;
    }
    return "";
  }

  it("the unique index rejects a second active microsoft row for the same owner", async () => {
    const { company, stewardA } = await seed();
    await connectPrivate(company.id, stewardA.principalId, "microsoft");

    const text = await errorText(() => connectPrivate(company.id, stewardA.principalId, "microsoft"));
    expect(text).toMatch(/connections_microsoft_active_owner_uq|duplicate key/);
    expect(await db.select().from(connections)).toHaveLength(1);
  });

  it("the unique index allows a new row once the previous one is revoked", async () => {
    const { company, stewardA } = await seed();
    const first = await connectPrivate(company.id, stewardA.principalId, "microsoft");
    await connectorService(db).revoke(first.id, "user", stewardA.principalId);

    const second = await connectPrivate(company.id, stewardA.principalId, "microsoft");
    expect(second.id).not.toBe(first.id);
  });

  it("the migration refuses to apply while duplicate active rows exist", async () => {
    const { company, stewardA } = await seed();
    const statements = readFileSync(MIGRATION_FILE, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);

    await db.execute(sql.raw(`DROP INDEX "connections_microsoft_active_owner_uq"`));
    try {
      for (let i = 0; i < 2; i += 1) {
        await insertLegacyRow(company.id, {
          provider: "microsoft",
          ownerType: "user",
          ownerId: stewardA.principalId,
          visibility: "private",
        });
      }

      const text = await errorText(async () => {
        for (const statement of statements) await db.execute(sql.raw(statement));
      });
      expect(text).toMatch(/more than one active microsoft connection/);

      // Resolving the duplicates lets it apply.
      await db.delete(connections);
      for (const statement of statements) await db.execute(sql.raw(statement));
    } finally {
      // Leave the shared test database with the index whatever happened above.
      if (!(await microsoftIndexExists())) {
        await db.delete(connections);
        await db.execute(sql.raw(statements[1]!));
      }
    }
    expect(await microsoftIndexExists()).toBe(true);
  });

  async function microsoftIndexExists() {
    const rows = await db.execute(
      sql`select indexname from pg_indexes where indexname = 'connections_microsoft_active_owner_uq'`,
    );
    return Array.from(rows as unknown as Array<{ indexname: string }>).length === 1;
  }
});
