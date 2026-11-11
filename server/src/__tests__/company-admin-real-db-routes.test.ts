// Company owner/admin protections against a real database, with no mocks.
//
// A founder creates the company through the real route (and becomes its
// owner there), then the founder, an active member and a pending membership
// go through archive, settings PATCH and export. Every actor is resolved with
// `boardAuthService.resolveBoardAccess`, the board-key path's own membership
// resolution, and the administrator check reads the membership from the
// database, so nothing about who is an admin is stubbed.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authUsers, companies, companyMemberships, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { boardAuthService } from "../services/board-auth.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("company owner/admin protections, real database", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";

  beforeAll(async () => {
    home = await mkdtemp(join(process.env.TMPDIR ?? process.cwd(), "company-admin-real-db-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("AGENTDASH_BILLING_DISABLED", "true");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-admin-real-db-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function user(label: string) {
    const id = `${label}-${randomUUID()}`;
    await db.insert(authUsers).values({
      id,
      name: label,
      email: `${id}@acme-${randomUUID().slice(0, 8)}.example`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return id;
  }

  /** The actor the board-key middleware would build for this user, from the database. */
  async function actorFor(userId: string) {
    const access = await boardAuthService(db).resolveBoardAccess(userId);
    return {
      type: "board",
      userId,
      source: "board_key",
      companyIds: access.companyIds,
      memberships: access.memberships,
      isInstanceAdmin: access.isInstanceAdmin,
    };
  }

  function app(actor: Record<string, unknown>) {
    const a = express();
    a.use(express.json());
    a.use((req: any, _res, next) => {
      req.actor = actor;
      next();
    });
    a.use("/api/companies", companyRoutes(db, undefined, { allowMultiCompany: true, allowMultiTenantPerDomain: true }));
    a.use(errorHandler);
    return a;
  }

  async function seed() {
    const founderId = await user("founder");
    const created = await request(app(await actorFor(founderId)))
      .post("/api/companies")
      .send({ name: `Real ${randomUUID().slice(0, 8)}` });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const companyId = created.body.id as string;

    const memberId = await user("member");
    const pendingId = await user("pending");
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: memberId, status: "active", membershipRole: "member" },
      // A pending admin: the role alone must not pass.
      { companyId, principalType: "user", principalId: pendingId, status: "pending", membershipRole: "admin" },
    ]);
    return { companyId, founderId, memberId, pendingId };
  }

  it("makes the creator an active administrator through the real create route", async () => {
    const { companyId, founderId } = await seed();
    const [row] = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.principalId, founderId));
    expect(row).toMatchObject({ companyId, status: "active" });
    expect(["owner", "admin"]).toContain(row!.membershipRole);
  });

  it("refuses an active member settings, export and archive, and changes nothing", async () => {
    const { companyId, memberId } = await seed();
    const member = app(await actorFor(memberId));

    const patch = await request(member).patch(`/api/companies/${companyId}`).send({ name: "Renamed by member" });
    expect(patch.status).toBe(403);
    expect(patch.body.error).toBe("Only owners and admins can change company settings.");

    const exported = await request(member).post(`/api/companies/${companyId}/exports`).send({ include: { company: true } });
    expect(exported.status).toBe(403);
    expect(exported.body.error).toBe("Only owners and admins can export this company.");

    const archived = await request(member).post(`/api/companies/${companyId}/archive`);
    expect(archived.status).toBe(403);
    expect(archived.body.error).toBe("Only owners and admins can archive this company.");

    const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(row!.status).toBe("active");
    expect(row!.name).not.toBe("Renamed by member");
  });

  it("refuses a pending membership, even one carrying the admin role", async () => {
    const { companyId, pendingId } = await seed();
    const pending = app(await actorFor(pendingId));

    for (const res of [
      await request(pending).patch(`/api/companies/${companyId}`).send({ name: "Renamed by pending" }),
      await request(pending).post(`/api/companies/${companyId}/exports`).send({ include: { company: true } }),
      await request(pending).post(`/api/companies/${companyId}/archive`),
    ]) {
      expect(res.status).toBe(403);
    }
    const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(row!.status).toBe("active");
  });

  it("lets the just-created owner change settings, export and archive", async () => {
    const { companyId, founderId } = await seed();
    const owner = app(await actorFor(founderId));

    const patch = await request(owner).patch(`/api/companies/${companyId}`).send({ name: "Renamed by owner" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.name).toBe("Renamed by owner");

    const exported = await request(owner).post(`/api/companies/${companyId}/exports`).send({ include: { company: true } });
    expect(exported.status, JSON.stringify(exported.body)).toBe(200);

    const archived = await request(owner).post(`/api/companies/${companyId}/archive`);
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(row!.status).toBe("archived");
  });
});
