import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { agentService } from "../services/agents.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { truncateWithRetry } from "./helpers/truncate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

/**
 * AgentDash (GH #886 review). Per-agent configuration reads — configuration,
 * config revisions, skills, the instructions bundle and its files — admit
 * whoever the matching write routes admit. In an `agentdash_mk` company a
 * steward who is a plain member (no `agents:create` grant) edits their agent's
 * mandate file and syncs its skills, so they must be able to read them; a
 * member with no authority over the agent still may not.
 */
describeEmbeddedPostgres("per-agent configuration reads follow write authority (GH #886)", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let scratch = "";
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID"];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-config-read-steward-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "config-read-steward-")));
    process.env.PAPERCLIP_HOME = path.join(scratch, "paperclip");
    process.env.PAPERCLIP_INSTANCE_ID = "config-read";
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await fs.rm(scratch, { recursive: true, force: true });
    await truncateWithRetry(db, sql`${companies}, ${authUsers}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function addUser(companyId: string, membershipRole: string) {
    const userId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: `User ${membershipRole}`,
      email: `${userId}@example.test`,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
    });
    return userId;
  }

  async function createAgent(companyId: string, name: string) {
    return db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "echo" },
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seed() {
    const company = await db
      .insert(companies)
      .values({
        name: `ConfigRead ${randomUUID()}`,
        issuePrefix: `CR${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: "agentdash_mk",
      })
      .returning()
      .then((rows) => rows[0]!);
    const ownerUserId = await addUser(company.id, "owner");
    const stewardUserId = await addUser(company.id, "member");
    const outsiderUserId = await addUser(company.id, "member");
    const stewarded = await createAgent(company.id, "Stewarded");
    const other = await createAgent(company.id, "Other");
    await agentStewardshipService(db).assign(company.id, {
      agentId: stewarded.id,
      userId: stewardUserId,
      assignedByUserId: ownerUserId,
    });
    return { company, ownerUserId, stewardUserId, outsiderUserId, stewarded, other };
  }

  function member(companyId: string, userId: string, membershipRole = "member") {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole, status: "active" }],
    };
  }

  function createApp(actor: Record<string, unknown>) {
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

  async function send(actor: Record<string, unknown>, build: (agent: request.Agent) => request.Test) {
    const { createServer } = await import("node:http");
    const server = createServer(createApp(actor));
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      return await build(request.agent(`http://127.0.0.1:${address.port}`));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }

  const readPaths = (agentId: string) => [
    `/api/agents/${agentId}/configuration`,
    `/api/agents/${agentId}/config-revisions`,
    `/api/agents/${agentId}/skills`,
    `/api/agents/${agentId}/instructions-bundle`,
  ];

  for (const authority of ["steward", "creator", "owner", "agent"] as const) {
    for (const responseKind of ["patch", "revision list", "revision detail"] as const) {
      it(`${authority}: ${responseKind} separates configuration access from spend access`, async () => {
        const { company, ownerUserId, stewardUserId, outsiderUserId, stewarded } = await seed();
        await db.update(agents).set({
          budgetMonthlyCents: 876543,
          spentMonthlyCents: 987654,
          createdByUserId: outsiderUserId,
          permissions: { canCreateAgents: true },
          adapterConfig: { command: "echo", apiKey: "synthetic-history-secret" },
        }).where(eq(agents.id, stewarded.id));
        const actor = authority === "agent"
          ? { type: "agent", agentId: stewarded.id, companyId: company.id, source: "agent_key" }
          : member(company.id,
            authority === "owner" ? ownerUserId : authority === "creator" ? outsiderUserId : stewardUserId,
            authority === "owner" ? "owner" : "member");
        const canReadSpend = authority === "owner" || authority === "agent";
        const patched = await send(actor, (r) => r.patch(`/api/agents/${stewarded.id}`).send({ title: "New title" }));
        expect(patched.status, JSON.stringify(patched.body)).toBe(200);
        const storedRevisions = await agentService(db).listConfigRevisions(stewarded.id);
        expect(storedRevisions).toHaveLength(1);
        for (const snapshot of [storedRevisions[0]!.beforeConfig, storedRevisions[0]!.afterConfig]) {
          expect(snapshot.budgetMonthlyCents).toBe(876543);
        }
        if (responseKind === "patch") {
          expect(patched.body.title).toBe("New title");
          expect(patched.body.budgetMonthlyCents).toBe(canReadSpend ? 876543 : null);
          expect(patched.body.spentMonthlyCents).toBe(canReadSpend ? 987654 : null);
        } else {
          const suffix = responseKind === "revision detail" ? `/${storedRevisions[0]!.id}` : "";
          const response = await send(actor, (r) => r.get(`/api/agents/${stewarded.id}/config-revisions${suffix}`));
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          const revision = responseKind === "revision list" ? response.body[0] : response.body;
          for (const snapshot of [revision.beforeConfig, revision.afterConfig]) {
            expect(snapshot.budgetMonthlyCents).toBe(canReadSpend ? 876543 : null);
            expect(snapshot.adapterConfig.command).toBe("echo");
            expect(snapshot.adapterConfig.apiKey).toBe("***REDACTED***");
          }
          expect(revision.afterConfig.title).toBe("New title");
          expect(await agentService(db).listConfigRevisions(stewarded.id)).toEqual(storedRevisions);
        }
      });
    }
  }

  it("lets a steward without agents:create write and then read their agent's mandate file", async () => {
    const { company, ownerUserId, stewardUserId, stewarded } = await seed();
    const steward = member(company.id, stewardUserId);
    // An administrator chooses where the bundle lives; the steward edits it.
    const managed = await send(member(company.id, ownerUserId, "owner"), (r) =>
      r.patch(`/api/agents/${stewarded.id}/instructions-bundle`).send({ mode: "managed" }));
    expect(managed.status, JSON.stringify(managed.body)).toBe(200);

    const write = await send(steward, (r) =>
      r
        .put(`/api/agents/${stewarded.id}/instructions-bundle/file`)
        .send({ path: "AGENTS.md", content: "# Mandate\nShip the deck.\n" }));
    expect(write.status, JSON.stringify(write.body)).toBe(200);

    const bundle = await send(steward, (r) => r.get(`/api/agents/${stewarded.id}/instructions-bundle`));
    expect(bundle.status, JSON.stringify(bundle.body)).toBe(200);

    const file = await send(steward, (r) =>
      r.get(`/api/agents/${stewarded.id}/instructions-bundle/file`).query({ path: "AGENTS.md" }));
    expect(file.status, JSON.stringify(file.body)).toBe(200);
    expect(JSON.stringify(file.body)).toContain("Ship the deck.");
  });

  it("lets the steward read their agent's configuration, revisions and skills", async () => {
    const { company, stewardUserId, stewarded } = await seed();
    for (const route of readPaths(stewarded.id)) {
      const res = await send(member(company.id, stewardUserId), (r) => r.get(route));
      expect(res.status, `${route} ${JSON.stringify(res.body)}`).toBe(200);
    }
  });

  it("refuses the same steward on an agent they do not steward", async () => {
    const { company, stewardUserId, other } = await seed();
    for (const route of [
      ...readPaths(other.id),
      `/api/agents/${other.id}/instructions-bundle/file?path=AGENTS.md`,
    ]) {
      const res = await send(member(company.id, stewardUserId), (r) => r.get(route));
      expect(res.status, `${route} ${JSON.stringify(res.body)}`).toBe(403);
    }
  });

  it("refuses a member with no authority over the agent", async () => {
    const { company, outsiderUserId, stewarded } = await seed();
    for (const route of [
      ...readPaths(stewarded.id),
      `/api/agents/${stewarded.id}/instructions-bundle/file?path=AGENTS.md`,
    ]) {
      const res = await send(member(company.id, outsiderUserId), (r) => r.get(route));
      expect(res.status, `${route} ${JSON.stringify(res.body)}`).toBe(403);
    }
  });

  it("keeps the company-wide configuration list grant-only, even for a steward", async () => {
    const { company, stewardUserId } = await seed();
    const res = await send(member(company.id, stewardUserId), (r) =>
      r.get(`/api/companies/${company.id}/agent-configurations`));
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it("still lets the company owner read any agent's configuration", async () => {
    const { company, ownerUserId, other } = await seed();
    for (const route of readPaths(other.id)) {
      const res = await send(member(company.id, ownerUserId, "owner"), (r) => r.get(route));
      expect(res.status, `${route} ${JSON.stringify(res.body)}`).toBe(200);
    }
  });

  it("lets a member who may create agents run the create form's environment probe", async () => {
    const { company, outsiderUserId } = await seed();
    const previousBypass = process.env.AGENTDASH_ADAPTER_ENV_BYPASS;
    process.env.AGENTDASH_ADAPTER_ENV_BYPASS = "true";
    try {
      const res = await send(member(company.id, outsiderUserId), (r) =>
        r
          .post(`/api/companies/${company.id}/adapters/codex_local/test-environment`)
          .send({ adapterConfig: {} }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    } finally {
      if (previousBypass === undefined) delete process.env.AGENTDASH_ADAPTER_ENV_BYPASS;
      else process.env.AGENTDASH_ADAPTER_ENV_BYPASS = previousBypass;
    }
  });
});
