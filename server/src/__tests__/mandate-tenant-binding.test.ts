import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  getEmbeddedPostgresTestSupport,
  mandateAttestations,
  mandates,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { mandatedActionRoutes } from "../routes/mandated-actions.js";
import { mandateAttestationRoutes } from "../routes/mandate-attestations.js";
import { mandateRoutes } from "../routes/mandates.js";

// AgentDash (security): mandates and the agents they name must be bound to the
// route's company before any evaluation or side effect. These cover the
// cross-tenant pause (mandated-actions), the grantee-impersonating demo
// attestation, and mandate creation naming a foreign agent.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("mandate tenant binding (integration)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mandate-tenancy-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(mandateAttestations);
    await db.delete(approvals);
    await db.delete(mandates);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function appFor(actor: unknown) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use(mandatedActionRoutes(db));
    app.use(mandateAttestationRoutes(db));
    app.use(mandateRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany(name: string) {
    const issuePrefix = `T${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const [company] = await db.insert(companies).values({ name, issuePrefix }).returning();
    const [grantor] = await db.insert(agents).values({ companyId: company.id, name: `${name} Grantor` }).returning();
    const [grantee] = await db.insert(agents).values({ companyId: company.id, name: `${name} Grantee` }).returning();
    return { companyId: company.id, grantorId: grantor.id, granteeId: grantee.id };
  }

  async function insertMandate(input: {
    companyId: string;
    grantorAgentId: string;
    granteeAgentId: string;
    expired?: boolean;
  }) {
    const [row] = await db
      .insert(mandates)
      .values({
        companyId: input.companyId,
        grantorAgentId: input.grantorAgentId,
        granteeAgentId: input.granteeAgentId,
        scope: ["verify"],
        permissionKey: "clockchain:attest",
        spendCapCents: 1000,
        expiresAt: input.expired ? new Date(Date.now() - 60_000) : new Date(Date.now() + 86_400_000),
      })
      .returning();
    return row;
  }

  async function boardUser(companyId: string, role: "admin" | "member") {
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: role,
    });
    return {
      type: "board",
      source: "session",
      userId,
      isInstanceAdmin: false,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: role }],
    };
  }

  async function agentStatus(agentId: string) {
    const [row] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, agentId));
    return row?.status;
  }

  async function approvalsFor(companyId: string) {
    return db.select().from(approvals).where(eq(approvals.companyId, companyId));
  }

  describe("POST /companies/:companyId/mandated-actions", () => {
    it("rejects company B's mandate id with 404 and pauses no agent", async () => {
      const a = await seedCompany("A");
      const b = await seedCompany("B");
      const bMandate = await insertMandate({ companyId: b.companyId, grantorAgentId: b.grantorId, granteeAgentId: b.granteeId, expired: true });
      const admin = await boardUser(a.companyId, "admin");

      const res = await request(appFor(admin))
        .post(`/companies/${a.companyId}/mandated-actions`)
        .send({ mandateId: bMandate.id, granteeAgentId: b.granteeId, counterpartyDid: "did:x", action: "verify" });

      expect(res.status).toBe(404);
      expect(await agentStatus(b.granteeId)).not.toBe("paused");
      expect(await approvalsFor(a.companyId)).toHaveLength(0);
      expect(await approvalsFor(b.companyId)).toHaveLength(0);
    });

    it("rejects an expired A mandate combined with company B's granteeAgentId; B agent untouched", async () => {
      const a = await seedCompany("A");
      const b = await seedCompany("B");
      const aMandate = await insertMandate({ companyId: a.companyId, grantorAgentId: a.grantorId, granteeAgentId: a.granteeId, expired: true });
      const admin = await boardUser(a.companyId, "admin");

      const res = await request(appFor(admin))
        .post(`/companies/${a.companyId}/mandated-actions`)
        .send({ mandateId: aMandate.id, granteeAgentId: b.granteeId, counterpartyDid: "did:x", action: "verify" });

      expect(res.status).toBe(404);
      expect(await agentStatus(b.granteeId)).not.toBe("paused");
      expect(await approvalsFor(a.companyId)).toHaveLength(0);
    });

    it("rejects a mandate stored in A whose grantee is company B's agent; B agent untouched", async () => {
      const a = await seedCompany("A");
      const b = await seedCompany("B");
      const mixed = await insertMandate({ companyId: a.companyId, grantorAgentId: a.grantorId, granteeAgentId: b.granteeId, expired: true });
      const admin = await boardUser(a.companyId, "admin");

      const res = await request(appFor(admin))
        .post(`/companies/${a.companyId}/mandated-actions`)
        .send({ mandateId: mixed.id, granteeAgentId: b.granteeId, counterpartyDid: "did:x", action: "verify" });

      expect(res.status).toBe(404);
      expect(await agentStatus(b.granteeId)).not.toBe("paused");
      expect(await approvalsFor(a.companyId)).toHaveLength(0);
    });

    it("does not pause an in-company agent that is not the mandate's grantee (identity before expiry)", async () => {
      const a = await seedCompany("A");
      const aMandate = await insertMandate({ companyId: a.companyId, grantorAgentId: a.grantorId, granteeAgentId: a.granteeId, expired: true });
      const admin = await boardUser(a.companyId, "admin");

      const res = await request(appFor(admin))
        .post(`/companies/${a.companyId}/mandated-actions`)
        .send({ mandateId: aMandate.id, granteeAgentId: a.grantorId, counterpartyDid: "did:x", action: "verify" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ authorized: false, reason: "not_grantee", escalated: false });
      expect(await agentStatus(a.grantorId)).not.toBe("paused");
    });

    it("admin happy path: an expired in-company mandate still escalates and pauses its own grantee", async () => {
      const a = await seedCompany("A");
      const aMandate = await insertMandate({ companyId: a.companyId, grantorAgentId: a.grantorId, granteeAgentId: a.granteeId, expired: true });
      const admin = await boardUser(a.companyId, "admin");

      const res = await request(appFor(admin))
        .post(`/companies/${a.companyId}/mandated-actions`)
        .send({ mandateId: aMandate.id, granteeAgentId: a.granteeId, counterpartyDid: "did:x", action: "verify" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ authorized: false, reason: "expired", escalated: true });
      expect(await agentStatus(a.granteeId)).toBe("paused");
      expect(await approvalsFor(a.companyId)).toHaveLength(1);
    });
  });

  describe("POST /companies/:companyId/mandate-attestations", () => {
    it("forbids a plain member (403) and records nothing", async () => {
      const a = await seedCompany("A");
      const aMandate = await insertMandate({ companyId: a.companyId, grantorAgentId: a.grantorId, granteeAgentId: a.granteeId });
      const member = await boardUser(a.companyId, "member");

      const res = await request(appFor(member))
        .post(`/companies/${a.companyId}/mandate-attestations`)
        .send({ mandateId: aMandate.id, action: "verify" });

      expect(res.status).toBe(403);
      expect(await db.select().from(mandateAttestations)).toHaveLength(0);
    });

    it("rejects company B's mandate for an A admin (404); B grantee untouched, nothing recorded", async () => {
      const a = await seedCompany("A");
      const b = await seedCompany("B");
      const bMandate = await insertMandate({ companyId: b.companyId, grantorAgentId: b.grantorId, granteeAgentId: b.granteeId, expired: true });
      const admin = await boardUser(a.companyId, "admin");

      const res = await request(appFor(admin))
        .post(`/companies/${a.companyId}/mandate-attestations`)
        .send({ mandateId: bMandate.id, action: "verify" });

      expect(res.status).toBe(404);
      expect(await agentStatus(b.granteeId)).not.toBe("paused");
      expect(await db.select().from(mandateAttestations)).toHaveLength(0);
    });

    it("admin happy path: an in-company mandate records an attestation (201)", async () => {
      const a = await seedCompany("A");
      const aMandate = await insertMandate({ companyId: a.companyId, grantorAgentId: a.grantorId, granteeAgentId: a.granteeId });
      const admin = await boardUser(a.companyId, "admin");

      const res = await request(appFor(admin))
        .post(`/companies/${a.companyId}/mandate-attestations`)
        .send({ mandateId: aMandate.id, action: "verify" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ companyId: a.companyId, mandateId: aMandate.id, granteeAgentId: a.granteeId });
    });
  });

  describe("POST /companies/:companyId/mandates", () => {
    it("rejects a mandate whose grantee belongs to another company (404) and inserts nothing", async () => {
      const a = await seedCompany("A");
      const b = await seedCompany("B");
      const admin = await boardUser(a.companyId, "admin");

      const res = await request(appFor(admin))
        .post(`/companies/${a.companyId}/mandates`)
        .send({
          grantorAgentId: a.grantorId,
          granteeAgentId: b.granteeId,
          scope: ["verify"],
          permissionKey: "clockchain:attest",
          spendCapCents: 1000,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });

      expect(res.status).toBe(404);
      expect(await db.select().from(mandates)).toHaveLength(0);
    });
  });
});
