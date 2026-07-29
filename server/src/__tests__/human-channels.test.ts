import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentStewardships,
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
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { humanChannelService } from "../services/human-channels.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

describeEmbeddedPostgres("human channel bindings", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-human-channels-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(externalChannelEvents);
    await db.delete(humanChannelBindings);
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
        name: `Channels ${randomUUID()}`,
        issuePrefix: `CH${randomUUID().slice(0, 6).toUpperCase()}`,
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
    return { company, owner, steward, agent };
  }

  it("binds a verified provider identity to the caller's stewarded agent", async () => {
    const { company, steward, agent } = await seed();
    const svc = humanChannelService(db);

    const binding = await svc.verifyBinding(company.id, {
      provider: "telegram",
      userId: steward.principalId,
      externalUserId: "tg-100",
      externalConversationId: "chat-1",
      metadata: { username: "ada" },
    });

    expect(binding.agentId).toBe(agent.id);
    expect(binding.verifiedAt).toBeInstanceOf(Date);
    expect(binding.revokedAt).toBeNull();
  });

  it("does not bind one provider identity to two active users in a company", async () => {
    const { company, owner, steward } = await seed();
    const svc = humanChannelService(db);

    await svc.verifyBinding(company.id, {
      provider: "telegram",
      userId: steward.principalId,
      externalUserId: "tg-100",
      externalConversationId: "chat-1",
    });

    await expect(
      svc.verifyBinding(company.id, {
        provider: "telegram",
        userId: owner.principalId,
        externalUserId: "tg-100",
        externalConversationId: "chat-2",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("requires explicit revocation before the same human can rebind", async () => {
    const { company, steward } = await seed();
    const svc = humanChannelService(db);

    const first = await svc.verifyBinding(company.id, {
      provider: "telegram",
      userId: steward.principalId,
      externalUserId: "tg-100",
      externalConversationId: "chat-1",
    });

    await expect(
      svc.verifyBinding(company.id, {
        provider: "telegram",
        userId: steward.principalId,
        externalUserId: "tg-200",
        externalConversationId: "chat-9",
      }),
    ).rejects.toMatchObject({ status: 409 });

    await svc.revokeBinding(company.id, first.id, { actorUserId: steward.principalId });

    const rebound = await svc.verifyBinding(company.id, {
      provider: "telegram",
      userId: steward.principalId,
      externalUserId: "tg-200",
      externalConversationId: "chat-9",
    });
    expect(rebound.id).not.toBe(first.id);
  });

  it("resolves only active bindings and blocks a revoked one immediately", async () => {
    const { company, steward } = await seed();
    const svc = humanChannelService(db);

    const binding = await svc.verifyBinding(company.id, {
      provider: "telegram",
      userId: steward.principalId,
      externalUserId: "tg-100",
      externalConversationId: "chat-1",
    });

    expect(await svc.resolveActiveBinding("telegram", "tg-100")).toMatchObject({ id: binding.id });

    await svc.revokeBinding(company.id, binding.id, { actorUserId: steward.principalId });

    // Revocation must block inbound dispatch and outbound sends at once.
    expect(await svc.resolveActiveBinding("telegram", "tg-100")).toBeNull();
  });

  it("claims one external event exactly once", async () => {
    const { company } = await seed();
    const svc = humanChannelService(db);

    expect(await svc.claimEvent("telegram", company.id, "update-42", "digest-a")).toMatchObject({
      claimed: true,
    });
    expect(await svc.claimEvent("telegram", company.id, "update-42", "digest-a")).toMatchObject({
      claimed: false,
    });
  });

  it("survives concurrent delivery of the same event without double-claiming", async () => {
    const { company } = await seed();
    const svc = humanChannelService(db);

    const results = await Promise.all([
      svc.claimEvent("telegram", company.id, "update-99", "digest-b"),
      svc.claimEvent("telegram", company.id, "update-99", "digest-b"),
      svc.claimEvent("telegram", company.id, "update-99", "digest-b"),
    ]);

    expect(results.filter((result) => result.claimed)).toHaveLength(1);
  });

  it("scopes event identity by company so two companies can see the same provider id", async () => {
    const first = await seed();
    const second = await seed();
    const svc = humanChannelService(db);

    expect(await svc.claimEvent("telegram", first.company.id, "update-7", "d")).toMatchObject({
      claimed: true,
    });
    expect(await svc.claimEvent("telegram", second.company.id, "update-7", "d")).toMatchObject({
      claimed: true,
    });
  });

  it("stores a payload digest rather than raw message content", async () => {
    const { company } = await seed();
    const svc = humanChannelService(db);
    await svc.claimEvent("telegram", company.id, "update-1", "sha256:abc");

    const stored = await db
      .select()
      .from(externalChannelEvents)
      .where(eq(externalChannelEvents.externalEventId, "update-1"))
      .then((rows) => rows[0]!);

    expect(stored.payloadDigest).toBe("sha256:abc");
    expect(Object.keys(stored)).not.toContain("payload");
  });

  it("ends a binding when the human stops stewarding the agent", async () => {
    const { company, owner, steward, agent } = await seed();
    const svc = humanChannelService(db);
    const binding = await svc.verifyBinding(company.id, {
      provider: "telegram",
      userId: steward.principalId,
      externalUserId: "tg-100",
      externalConversationId: "chat-1",
    });

    // Transferring the agent away must not leave the old steward's channel live.
    const other = await db
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
    await agentStewardshipService(db).transfer(company.id, agent.id, {
      userId: other.principalId,
      transferredByUserId: owner.principalId,
      transferReason: "Role change",
    });

    // Revocation must be automatic on transfer, not an extra call a caller
    // could forget — the binding is authority, and it moved.
    const stored = await db
      .select()
      .from(humanChannelBindings)
      .where(eq(humanChannelBindings.id, binding.id))
      .then((rows) => rows[0]!);
    expect(stored.revokedAt).toBeInstanceOf(Date);
    expect(await svc.resolveActiveBinding("telegram", "tg-100")).toBeNull();
  });

  it("refuses to bind a human who stewards no agent", async () => {
    const { company, owner } = await seed();
    const svc = humanChannelService(db);

    await expect(
      svc.verifyBinding(company.id, {
        provider: "telegram",
        userId: owner.principalId,
        externalUserId: "tg-500",
        externalConversationId: "chat-5",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
