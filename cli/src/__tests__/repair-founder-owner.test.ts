// AgentDash (scan 3, lane H): the operator repair for founders the old
// permission grant demoted. It lists evidence and promotes only a user an
// operator names; it never picks someone on its own.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentStewardships,
  companies,
  companyMemberships,
  createDb,
  invites,
  joinRequests,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  REPAIR_ACTOR_ID,
  applyFounderOwnerRepair,
  findFounderOwnerCandidates,
} from "../commands/repair-founder-owner.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("doctor repair-founder-owner", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-repair-founder-owner-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function company(name: string, createdAt = new Date(Date.now() - 3_600_000)) {
    const [row] = await db
      .insert(companies)
      .values({ name, issuePrefix: randomUUID().slice(0, 6).toUpperCase(), createdAt })
      .returning();
    return row!;
  }

  async function member(companyId: string, userId: string, role: string, createdAt: Date, status = "active") {
    const [row] = await db
      .insert(companyMemberships)
      .values({ companyId, principalType: "user", principalId: userId, membershipRole: role, status, createdAt })
      .returning();
    return row!;
  }

  async function joinedByInvite(companyId: string, userId: string) {
    const [invite] = await db
      .insert(invites)
      .values({ companyId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000) })
      .returning();
    await db.insert(joinRequests).values({
      inviteId: invite!.id,
      companyId,
      requestType: "human",
      status: "approved",
      requestIp: "127.0.0.1",
      requestingUserId: userId,
    });
  }

  async function role(companyId: string, userId: string) {
    const [row] = await db
      .select({ role: companyMemberships.membershipRole })
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));
    return row?.role ?? null;
  }

  it("dry run lists a demoted founder with evidence and changes nothing; --apply restores only the named user", async () => {
    const acme = await company("Acme");
    const founder = `founder-${randomUUID()}`;
    const teammate = `teammate-${randomUUID()}`;
    await member(acme.id, founder, "member", new Date(acme.createdAt.getTime() + 500));
    await member(acme.id, teammate, "member", new Date(acme.createdAt.getTime() + 600_000));
    await joinedByInvite(acme.id, teammate);
    await db.insert(activityLog).values({
      companyId: acme.id, actorType: "user", actorId: founder, action: "company.created",
      entityType: "company", entityId: acme.id,
    });
    const [cos] = await db
      .insert(agents)
      .values({ companyId: acme.id, name: "Chief of Staff", role: "chief_of_staff", adapterType: "process" })
      .returning();

    const candidates = await findFounderOwnerCandidates(db);
    expect(candidates.map((c) => c.companyId)).toEqual([acme.id]);
    const byUser = new Map(candidates[0]!.members.map((m) => [m.userId, m]));
    expect(byUser.get(founder)).toMatchObject({ loggedCompanyCreated: true, earliestUntouchedMembership: true });
    expect(byUser.get(teammate)).toMatchObject({
      loggedCompanyCreated: false, earliestUntouchedMembership: false, hasJoinRequest: true,
    });
    // Listing is read-only.
    expect(await role(acme.id, founder)).toBe("member");

    const operator = { osUser: "ops-alice", host: "box-1" };
    const outcome = await applyFounderOwnerRepair(db, { companyId: acme.id, userId: founder, operator });
    expect(outcome).toMatchObject({ status: "restored", pairedCosAgentId: cos!.id });
    expect(await role(acme.id, founder)).toBe("owner");
    expect(await role(acme.id, teammate)).toBe("member");
    const audit = await db.select().from(activityLog).where(eq(activityLog.action, "company.owner_restored"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: "system",
      actorId: REPAIR_ACTOR_ID,
      details: {
        userId: founder,
        forced: false,
        operator,
        creatorEvidence: { loggedCompanyCreated: true, earliestUntouchedMembership: true },
      },
    });
    const pairing = await db.select().from(activityLog).where(eq(activityLog.action, "agent.stewardship_assigned"));
    expect(pairing).toHaveLength(1);
    expect(pairing[0]).toMatchObject({ actorType: "system", agentId: cos!.id, details: { userId: founder } });
    const [steward] = await db.select().from(agentStewardships).where(eq(agentStewardships.agentId, cos!.id));
    expect(steward?.userId).toBe(founder);

    // Idempotent, and the company drops off the list.
    expect(await applyFounderOwnerRepair(db, { companyId: acme.id, userId: founder })).toEqual({ status: "already_owner" });
    expect(await findFounderOwnerCandidates(db)).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "company.owner_restored"))).toHaveLength(1);
  });

  it("an invited admin later demoted (founder archived) carries no founder evidence and is never promoted on its own", async () => {
    const co = await company("Invited Co");
    const founder = `founder-${randomUUID()}`;
    const invited = `invited-${randomUUID()}`;
    await member(co.id, founder, "owner", new Date(co.createdAt.getTime() + 100), "archived");
    const invitedRow = await member(co.id, invited, "member", new Date(co.createdAt.getTime() + 3_600_000));
    await joinedByInvite(co.id, invited);
    await db.insert(activityLog).values([
      { companyId: co.id, actorType: "user", actorId: founder, action: "company.created", entityType: "company", entityId: co.id },
      {
        companyId: co.id, actorType: "user", actorId: founder, action: "company_member.updated",
        entityType: "company_membership", entityId: invitedRow.id,
      },
    ]);

    const [candidate] = await findFounderOwnerCandidates(db, { companyId: co.id });
    const invitedEvidence = candidate!.members.find((m) => m.userId === invited);
    expect(invitedEvidence).toMatchObject({
      loggedCompanyCreated: false,
      earliestUntouchedMembership: false,
      hasJoinRequest: true,
      membershipEdited: true,
    });
    // Nothing promotes anyone unless an operator names them, and naming the
    // wrong person is refused without --force.
    expect(await role(co.id, invited)).toBe("member");
    expect(await applyFounderOwnerRepair(db, { companyId: co.id, userId: invited })).toEqual({ status: "no_creator_evidence" });
    expect(await role(co.id, invited)).toBe("member");

    // --force is the explicit operator override, and the audit row says so.
    const forced = await applyFounderOwnerRepair(db, { companyId: co.id, userId: invited, force: true });
    expect(forced.status).toBe("restored");
    const [audit] = await db.select().from(activityLog).where(eq(activityLog.action, "company.owner_restored"));
    expect(audit?.details).toMatchObject({ forced: true, creatorEvidence: { loggedCompanyCreated: false } });
  });

  it("refuses when the company has an active owner or admin, is archived, or the user is not an active member", async () => {
    const owned = await company("Owned Co");
    const owner = `owner-${randomUUID()}`;
    const other = `other-${randomUUID()}`;
    await member(owned.id, owner, "owner", owned.createdAt);
    await member(owned.id, other, "member", new Date(owned.createdAt.getTime() + 5_000));
    expect(await findFounderOwnerCandidates(db, { companyId: owned.id })).toEqual([]);
    expect(await applyFounderOwnerRepair(db, { companyId: owned.id, userId: other, force: true }))
      .toEqual({ status: "company_has_owner_or_admin" });
    expect(await applyFounderOwnerRepair(db, { companyId: owned.id, userId: "nobody", force: true }))
      .toEqual({ status: "no_active_membership" });
    expect(await role(owned.id, other)).toBe("member");

    // An admin but no owner: still administered, so the operator stays out of it.
    const adminRun = await company("Admin Co");
    const founder = `founder-${randomUUID()}`;
    const admin = `admin-${randomUUID()}`;
    await member(adminRun.id, founder, "member", new Date(adminRun.createdAt.getTime() + 100));
    await member(adminRun.id, admin, "admin", new Date(adminRun.createdAt.getTime() + 600_000));
    expect(await applyFounderOwnerRepair(db, { companyId: adminRun.id, userId: founder }))
      .toEqual({ status: "company_has_owner_or_admin" });
    expect(await role(adminRun.id, founder)).toBe("member");

    // Archived companies are neither listed nor repaired.
    const archived = await company("Archived Co");
    const archivedFounder = `founder-${randomUUID()}`;
    await member(archived.id, archivedFounder, "member", new Date(archived.createdAt.getTime() + 100));
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, archived.id));
    expect(await findFounderOwnerCandidates(db, { companyId: archived.id })).toEqual([]);
    expect(await applyFounderOwnerRepair(db, { companyId: archived.id, userId: archivedFounder, force: true }))
      .toEqual({ status: "company_archived" });
    expect(await role(archived.id, archivedFounder)).toBe("member");

    expect(await applyFounderOwnerRepair(db, { companyId: randomUUID(), userId: founder }))
      .toEqual({ status: "company_not_found" });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "company.owner_restored"))).toEqual([]);
  });
});
