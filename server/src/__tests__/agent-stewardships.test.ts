import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentStewardships,
  bridgeEndpoints,
  companies,
  companyMemberships,
  createDb,
  humanChannelBindings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentStewardshipRoutes } from "../routes/agent-stewardships.js";
import { accessService } from "../services/access.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

async function createCompany(db: TestDb, name = "Stewardship") {
  return db
    .insert(companies)
    .values({
      name: `${name} ${randomUUID()}`,
      issuePrefix: `ST${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createMember(
  db: TestDb,
  companyId: string,
  input: { userId?: string; status?: string; role?: string | null } = {},
) {
  const userId = input.userId ?? randomUUID();
  return db
    .insert(companyMemberships)
    .values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: input.status ?? "active",
      membershipRole: input.role ?? "operator",
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function createAgent(db: TestDb, companyId: string, input: { name?: string; status?: string } = {}) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: input.name ?? `Agent ${randomUUID()}`,
      role: "engineer",
      status: input.status ?? "idle",
      adapterType: "process",
    })
    .returning()
    .then((rows) => rows[0]!);
}

function makeBoardActor(companyId: string, userId: string, role = "owner") {
  return {
    type: "board",
    userId,
    source: "session",
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
  };
}

async function createApp(db: TestDb, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentStewardshipRoutes(db));
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

describeEmbeddedPostgres("agent stewardships", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-stewardships-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(bridgeEndpoints);
    await db.delete(humanChannelBindings);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("enforces one active stewardship per company user and per company agent", async () => {
    const company = await createCompany(db);
    const assigner = await createMember(db, company.id, { role: "owner" });
    const user = await createMember(db, company.id);
    const otherUser = await createMember(db, company.id);
    const agent = await createAgent(db, company.id, { name: "Chief of Staff" });
    const otherAgent = await createAgent(db, company.id, { name: "Operator" });
    const service = agentStewardshipService(db);

    await service.assign(company.id, {
      agentId: agent.id,
      userId: user.principalId,
      assignedByUserId: assigner.principalId,
    });

    await expect(
      service.assign(company.id, {
        agentId: otherAgent.id,
        userId: user.principalId,
        assignedByUserId: assigner.principalId,
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      service.assign(company.id, {
        agentId: agent.id,
        userId: otherUser.principalId,
        assignedByUserId: assigner.principalId,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const activeRows = await db
      .select()
      .from(agentStewardships)
      .where(and(eq(agentStewardships.companyId, company.id), isNull(agentStewardships.endedAt)));
    expect(activeRows).toHaveLength(1);
  });

  it("rejects inactive or non-member users and agents from another company", async () => {
    const company = await createCompany(db);
    const otherCompany = await createCompany(db, "Other");
    const assigner = await createMember(db, company.id, { role: "owner" });
    const suspendedUser = await createMember(db, company.id, { status: "suspended" });
    const activeAgent = await createAgent(db, company.id);
    const otherCompanyAgent = await createAgent(db, otherCompany.id);
    const service = agentStewardshipService(db);

    await expect(
      service.assign(company.id, {
        agentId: activeAgent.id,
        userId: suspendedUser.principalId,
        assignedByUserId: assigner.principalId,
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      service.assign(company.id, {
        agentId: activeAgent.id,
        userId: randomUUID(),
        assignedByUserId: assigner.principalId,
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      service.assign(company.id, {
        agentId: otherCompanyAgent.id,
        userId: assigner.principalId,
        assignedByUserId: assigner.principalId,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("transfers atomically, preserves history, and records reason and actor", async () => {
    const company = await createCompany(db);
    const assigner = await createMember(db, company.id, { role: "owner" });
    const firstUser = await createMember(db, company.id);
    const secondUser = await createMember(db, company.id);
    const agent = await createAgent(db, company.id);
    const service = agentStewardshipService(db);

    const original = await service.assign(company.id, {
      agentId: agent.id,
      userId: firstUser.principalId,
      assignedByUserId: assigner.principalId,
    });
    const transferred = await service.transfer(company.id, agent.id, {
      userId: secondUser.principalId,
      transferredByUserId: assigner.principalId,
      transferReason: "  ownership handoff  ",
    });

    const history = await service.historyForAgent(company.id, agent.id);
    expect(history).toHaveLength(2);
    expect(history.filter((row) => row.endedAt === null)).toHaveLength(1);
    expect(history.find((row) => row.id === original.id)?.endedAt).toBeInstanceOf(Date);
    expect(transferred.userId).toBe(secondUser.principalId);
    expect(transferred.assignedByUserId).toBe(assigner.principalId);
    expect(transferred.transferReason).toBe("ownership handoff");

    const events = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.stewardship_transferred"));
    expect(events).toHaveLength(1);
    expect(events[0]?.actorId).toBe(assigner.principalId);
    expect(events[0]?.entityId).toBe(transferred.id);
  });

  it("does not produce two active rows under concurrent conflicting transfers", async () => {
    const company = await createCompany(db);
    const assigner = await createMember(db, company.id, { role: "owner" });
    const firstUser = await createMember(db, company.id);
    const secondUser = await createMember(db, company.id);
    const thirdUser = await createMember(db, company.id);
    const agent = await createAgent(db, company.id);
    const service = agentStewardshipService(db);

    await service.assign(company.id, {
      agentId: agent.id,
      userId: firstUser.principalId,
      assignedByUserId: assigner.principalId,
    });

    const results = await Promise.allSettled([
      service.transfer(company.id, agent.id, {
        userId: secondUser.principalId,
        transferredByUserId: assigner.principalId,
        transferReason: "handoff A",
      }),
      service.transfer(company.id, agent.id, {
        userId: thirdUser.principalId,
        transferredByUserId: assigner.principalId,
        transferReason: "handoff B",
      }),
    ]);

    const rejected = results.filter((result) => result.status === "rejected");
    expect(results.filter((result) => result.status === "fulfilled").length).toBeGreaterThan(0);
    for (const result of rejected) {
      expect(result.reason).toMatchObject({ status: 409 });
    }
    const activeRows = await db
      .select()
      .from(agentStewardships)
      .where(and(eq(agentStewardships.companyId, company.id), eq(agentStewardships.agentId, agent.id), isNull(agentStewardships.endedAt)));
    expect(activeRows).toHaveLength(1);
  });

  it("isolates reads and mutations by company", async () => {
    const company = await createCompany(db);
    const otherCompany = await createCompany(db, "Other");
    const assigner = await createMember(db, company.id, { role: "owner" });
    const user = await createMember(db, company.id);
    const otherUser = await createMember(db, otherCompany.id);
    const agent = await createAgent(db, company.id);
    const otherAgent = await createAgent(db, otherCompany.id);
    const service = agentStewardshipService(db);

    await service.assign(company.id, {
      agentId: agent.id,
      userId: user.principalId,
      assignedByUserId: assigner.principalId,
    });
    await service.assign(otherCompany.id, {
      agentId: otherAgent.id,
      userId: otherUser.principalId,
      assignedByUserId: otherUser.principalId,
    });

    await expect(
      service.transfer(company.id, otherAgent.id, {
        userId: user.principalId,
        transferredByUserId: assigner.principalId,
        transferReason: "cross-company attempt",
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await service.activeByUser(company.id, otherUser.principalId)).toBeNull();
    expect(await service.activeByAgent(company.id, otherAgent.id)).toBeNull();
  });

  it("returns only the signed-in user's active stewardship through the self route", async () => {
    const company = await createCompany(db);
    const owner = await createMember(db, company.id, { role: "owner" });
    const user = await createMember(db, company.id);
    const otherUser = await createMember(db, company.id);
    const agent = await createAgent(db, company.id, { name: "My Steward" });
    const otherAgent = await createAgent(db, company.id, { name: "Other Steward" });
    const service = agentStewardshipService(db);
    await service.assign(company.id, {
      agentId: agent.id,
      userId: user.principalId,
      assignedByUserId: owner.principalId,
    });
    await service.assign(company.id, {
      agentId: otherAgent.id,
      userId: otherUser.principalId,
      assignedByUserId: owner.principalId,
    });

    const app = await createApp(db, makeBoardActor(company.id, user.principalId, "operator"));
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${company.id}/me/agent?userId=${otherUser.principalId}`),
    );

    expect(res.status).toBe(200);
    expect(res.body.stewardship.userId).toBe(user.principalId);
    expect(res.body.agent.id).toBe(agent.id);
  });

  it("requires owner/admin style agent creation permission for route mutations and rejects agent callers", async () => {
    const company = await createCompany(db);
    const owner = await createMember(db, company.id, { role: "owner" });
    const viewer = await createMember(db, company.id, { role: "viewer" });
    const user = await createMember(db, company.id);
    const agent = await createAgent(db, company.id);

    const viewerApp = await createApp(db, makeBoardActor(company.id, viewer.principalId, "viewer"));
    const viewerRes = await requestApp(viewerApp, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/agent-stewardships`)
        .send({ agentId: agent.id, userId: user.principalId }),
    );
    expect(viewerRes.status).toBe(403);

    const agentApp = await createApp(db, { type: "agent", companyId: company.id, agentId: agent.id });
    const agentRes = await requestApp(agentApp, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/agent-stewardships`)
        .send({ agentId: agent.id, userId: user.principalId }),
    );
    expect(agentRes.status).toBe(403);

    const ownerApp = await createApp(db, makeBoardActor(company.id, owner.principalId, "owner"));
    const ownerRes = await requestApp(ownerApp, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/agent-stewardships`)
        .send({ agentId: agent.id, userId: user.principalId }),
    );
    expect(ownerRes.status).toBe(201);
    expect(ownerRes.body.stewardship.userId).toBe(user.principalId);
  });

  it("rejects unknown keys in assignment payloads", async () => {
    const company = await createCompany(db);
    const owner = await createMember(db, company.id, { role: "owner" });
    const user = await createMember(db, company.id);
    const agent = await createAgent(db, company.id);
    const app = await createApp(db, makeBoardActor(company.id, owner.principalId, "owner"));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/agent-stewardships`)
        .send({ agentId: agent.id, userId: user.principalId, unexpected: true }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(await agentStewardshipService(db).activeByAgent(company.id, agent.id)).toBeNull();
  });

  it("rejects unknown keys in transfer payloads", async () => {
    const company = await createCompany(db);
    const owner = await createMember(db, company.id, { role: "owner" });
    const firstUser = await createMember(db, company.id);
    const secondUser = await createMember(db, company.id);
    const agent = await createAgent(db, company.id);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: firstUser.principalId,
      assignedByUserId: owner.principalId,
    });
    const app = await createApp(db, makeBoardActor(company.id, owner.principalId, "owner"));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/agents/${agent.id}/stewardship/transfer`)
        .send({ userId: secondUser.principalId, transferReason: "handoff", unexpected: true }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    const active = await agentStewardshipService(db).activeByAgent(company.id, agent.id);
    expect(active?.userId).toBe(firstUser.principalId);
  });

  it("member archival ends active stewardship while preserving the agent", async () => {
    const company = await createCompany(db);
    const owner = await createMember(db, company.id, { role: "owner" });
    const user = await createMember(db, company.id);
    const agent = await createAgent(db, company.id);
    const stewardship = await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: user.principalId,
      assignedByUserId: owner.principalId,
    });

    const result = await accessService(db).archiveMember(company.id, user.id, {
      actorUserId: owner.principalId,
    });
    expect(result?.member.status).toBe("archived");

    const archivedStewardship = await db
      .select()
      .from(agentStewardships)
      .where(eq(agentStewardships.id, stewardship.id))
      .then((rows) => rows[0]!);
    expect(archivedStewardship.endedAt).toBeInstanceOf(Date);
    expect(archivedStewardship.endedByUserId).toBe(owner.principalId);

    const preservedAgent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agent.id))
      .then((rows) => rows[0] ?? null);
    expect(preservedAgent?.id).toBe(agent.id);

    const transferEvents = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.stewardship_transferred"));
    expect(transferEvents).toHaveLength(0);

    const endedEvent = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.stewardship_ended"))
      .then((rows) => rows[0]!);
    expect(endedEvent.actorId).toBe(owner.principalId);
    expect(endedEvent.details).toMatchObject({
      userId: user.principalId,
      reason: "member_archived",
    });
  });

  it("records which channels and endpoints a stewardship end revoked, not just that it ended", async () => {
    // Revocation on stewardship end was moved inline into this service and lost
    // its per-row audit on the way. `agent.stewardship_ended` says the
    // stewardship ended; it does not say that this person's Telegram binding
    // and enrolled laptop stopped being able to act for that agent.
    //
    // That is the question an incident review actually asks — "when did this
    // channel stop working, and why" — and the answer was only inferable by
    // joining a revokedAt timestamp against a stewardship row.
    const company = await createCompany(db);
    const owner = await createMember(db, company.id, { role: "owner" });
    const user = await createMember(db, company.id);
    const agent = await createAgent(db, company.id);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: user.principalId,
      assignedByUserId: owner.principalId,
    });

    const now = new Date();
    await db.insert(humanChannelBindings).values({
      companyId: company.id,
      userId: user.principalId,
      agentId: agent.id,
      provider: "telegram",
      externalUserId: "tg-audit-1",
      verifiedAt: now,
    });
    await db.insert(bridgeEndpoints).values({
      companyId: company.id,
      userId: user.principalId,
      label: "laptop",
      tokenHash: "hash-audit-1",
      enrolledAt: now,
      approvedByUserId: owner.principalId,
    });

    await accessService(db).archiveMember(company.id, user.id, {
      actorUserId: owner.principalId,
    });

    const bindingRevoked = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "human_channel.binding_revoked"));
    expect(bindingRevoked, "no audit row named the revoked channel binding").toHaveLength(1);
    expect(bindingRevoked[0].details).toMatchObject({
      provider: "telegram",
      reason: "stewardship_ended",
    });

    const endpointRevoked = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "bridge.endpoint_revoked"));
    expect(endpointRevoked, "no audit row named the revoked bridge endpoint").toHaveLength(1);
    expect(endpointRevoked[0].details).toMatchObject({
      label: "laptop",
      reason: "stewardship_ended",
    });
  });

  /**
   * The third verb, and the reason it exists.
   *
   * `assign` needs somebody to pair with and `transfer` needs somebody to hand
   * the agent to, so an agent that should stand alone had no path at all: the
   * only way to leave one unstewarded was to archive the person. Making an
   * agent autonomous is refused while a pairing is live, which meant the guard
   * pointed at an action nothing exposed.
   */
  it("release ends a pairing and leaves the agent with nobody", async () => {
    const company = await createCompany(db);
    const owner = await createMember(db, company.id, { role: "owner" });
    const user = await createMember(db, company.id);
    const agent = await createAgent(db, company.id);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: user.principalId,
      assignedByUserId: owner.principalId,
    });

    const app = await createApp(db, makeBoardActor(company.id, owner.principalId));
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/agents/${agent.id}/stewardship/release`)
        .send({ releaseReason: "moving it to the autonomous team" }),
    );

    expect(response.status).toBe(200);
    expect(response.body.stewardship.endedAt).toBeTruthy();
    expect(response.body.stewardship.endedByUserId).toBe(owner.principalId);
    expect(await agentStewardshipService(db).activeByAgent(company.id, agent.id)).toBeNull();
    // The person is free to steward something else, which is the other half of
    // what release is for.
    expect(await agentStewardshipService(db).activeByUser(company.id, user.principalId)).toBeNull();
  });

  it("release keeps the history rather than deleting the row", async () => {
    // The table IS the record of who held decision authority. A release that
    // erased it would answer "who was answerable in March" with silence.
    const company = await createCompany(db);
    const owner = await createMember(db, company.id, { role: "owner" });
    const user = await createMember(db, company.id);
    const agent = await createAgent(db, company.id);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: user.principalId,
      assignedByUserId: owner.principalId,
    });
    await agentStewardshipService(db).releaseForAgent(company.id, agent.id, {
      releasedByUserId: owner.principalId,
      releaseReason: "standing alone now",
    });

    const history = await agentStewardshipService(db).historyForAgent(company.id, agent.id);
    expect(history).toHaveLength(1);
    expect(history[0].userId).toBe(user.principalId);

    const ended = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "agent.stewardship_ended"));
    expect(ended).toHaveLength(1);
    expect(ended[0].details).toMatchObject({
      userId: user.principalId,
      reason: "released",
      releaseReason: "standing alone now",
    });
  });

  it("release revokes the outgoing steward's channels and enrolled machines", async () => {
    // A release that left these behind would leave a live path to act for an
    // agent the person no longer stewards — the same rule transfer already
    // applies, for the same reason.
    const company = await createCompany(db);
    const owner = await createMember(db, company.id, { role: "owner" });
    const user = await createMember(db, company.id);
    const agent = await createAgent(db, company.id);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: user.principalId,
      assignedByUserId: owner.principalId,
    });
    await db.insert(humanChannelBindings).values({
      companyId: company.id,
      userId: user.principalId,
      agentId: agent.id,
      provider: "telegram",
      externalUserId: "555",
      verifiedAt: new Date(),
    });
    await db.insert(bridgeEndpoints).values({
      companyId: company.id,
      userId: user.principalId,
      label: "laptop",
      tokenHash: "hash-release-1",
      enrolledAt: new Date(),
      approvedByUserId: owner.principalId,
    });

    await agentStewardshipService(db).releaseForAgent(company.id, agent.id, {
      releasedByUserId: owner.principalId,
      releaseReason: "leaving the team",
    });

    const bindings = await db.select().from(humanChannelBindings);
    expect(bindings.every((row) => row.revokedAt !== null)).toBe(true);
    const endpoints = await db.select().from(bridgeEndpoints);
    expect(endpoints.every((row) => row.revokedAt !== null)).toBe(true);

    const revoked = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "human_channel.binding_revoked"));
    expect(revoked[0].details).toMatchObject({ reason: "stewardship_released" });
  });

  it("release refuses without a reason, and 404s when there is no pairing", async () => {
    const company = await createCompany(db);
    const owner = await createMember(db, company.id, { role: "owner" });
    const agent = await createAgent(db, company.id);
    const app = await createApp(db, makeBoardActor(company.id, owner.principalId));

    const noReason = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/agents/${agent.id}/stewardship/release`)
        .send({}),
    );
    expect(noReason.status).toBe(400);

    const noPairing = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/agents/${agent.id}/stewardship/release`)
        .send({ releaseReason: "nothing to end" }),
    );
    expect(noPairing.status).toBe(404);
  });

  it("release is refused for a caller who may not manage stewardships", async () => {
    const company = await createCompany(db);
    const owner = await createMember(db, company.id, { role: "owner" });
    const user = await createMember(db, company.id);
    const agent = await createAgent(db, company.id);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: user.principalId,
      assignedByUserId: owner.principalId,
    });

    const app = await createApp(db, { type: "agent", agentId: agent.id, companyId: company.id });
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/agents/${agent.id}/stewardship/release`)
        .send({ releaseReason: "not mine to end" }),
    );
    expect(response.status).toBe(403);
    expect(await agentStewardshipService(db).activeByAgent(company.id, agent.id)).not.toBeNull();
  });

  it("assign rejects when target membership is not active at transaction time", async () => {
    const company = await createCompany(db);
    const assigner = await createMember(db, company.id, { role: "owner" });
    const user = await createMember(db, company.id, { status: "suspended" });
    const agent = await createAgent(db, company.id);

    await expect(
      agentStewardshipService(db).assign(company.id, {
        agentId: agent.id,
        userId: user.principalId,
        assignedByUserId: assigner.principalId,
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(await agentStewardshipService(db).activeByAgent(company.id, agent.id)).toBeNull();
  });
});
