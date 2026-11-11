// Who may change a company secret, against a real database.
//
// Real routes, real authz, real secrets service (local_encrypted). Any member
// may list and create secrets. Rotating, renaming and deleting one needs a
// company owner or admin, the local implicit board, an instance admin, or the
// person who created that secret (`created_by_user_id`). Agents never reach
// these routes (board only), which is unchanged.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  companySecrets,
  companySecretVersions,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { secretRoutes } from "../routes/secrets.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const MEMBER_REFUSAL = "Only owners and admins, or the person who created this secret, can change it.";

describeEmbeddedPostgres("company secret writes need an owner or admin", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const savedKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;

  beforeAll(async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "b".repeat(64);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-secrets-admin-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY = savedKey;
    await tempDb?.cleanup();
  });

  async function seed() {
    const company = await db
      .insert(companies)
      .values({ name: `Sec ${randomUUID()}`, issuePrefix: `S${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    const ownerId = `owner-${randomUUID()}`;
    const adminId = `admin-${randomUUID()}`;
    const memberId = `member-${randomUUID()}`;
    const instanceAdminId = `instance-admin-${randomUUID()}`;
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" },
      { companyId: company.id, principalType: "user", principalId: adminId, status: "active", membershipRole: "admin" },
      { companyId: company.id, principalType: "user", principalId: memberId, status: "active", membershipRole: "member" },
      // A plain member here: the pass must come from the instance role.
      { companyId: company.id, principalType: "user", principalId: instanceAdminId, status: "active", membershipRole: "member" },
    ]);
    const board = (userId: string, role: string, isInstanceAdmin = false) => ({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin,
      companyIds: [company.id],
      memberships: [{ companyId: company.id, status: "active", membershipRole: role }],
    });
    const existing = await secretService(db).create(
      company.id,
      { name: `existing-${randomUUID().slice(0, 8)}`, provider: "local_encrypted", value: "v1" },
      { userId: ownerId },
    );
    return {
      company,
      existing,
      owner: board(ownerId, "owner"),
      admin: board(adminId, "admin"),
      member: board(memberId, "member"),
      instanceAdmin: board(instanceAdminId, "member", true),
      localBoard: { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true },
    };
  }

  function app(actor: Record<string, unknown>) {
    const a = express();
    a.use(express.json());
    a.use((req: any, _res, next) => {
      req.actor = actor;
      next();
    });
    a.use("/api", secretRoutes(db));
    a.use(errorHandler);
    return a;
  }

  it("refuses a member rotating, renaming or deleting someone else's secret, and changes nothing", async () => {
    const { company, existing, member } = await seed();
    const rotate = await request(app(member)).post(`/api/secrets/${existing.id}/rotate`).send({ value: "v2" });
    const rename = await request(app(member)).patch(`/api/secrets/${existing.id}`).send({ name: "renamed" });
    const remove = await request(app(member)).delete(`/api/secrets/${existing.id}`);

    for (const res of [rotate, rename, remove]) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe(MEMBER_REFUSAL);
    }
    const rows = await db.select().from(companySecrets);
    expect(rows.map((row) => row.name)).toEqual([existing.name]);
    expect(rows[0]!.latestVersion).toBe(1);
    expect(await secretService(db).resolveSecretValue(company.id, existing.id, "latest")).toBe("v1");
  });

  it("lets a member create a secret, then rotate, rename and delete their own", async () => {
    const { company, member } = await seed();
    const create = await request(app(member))
      .post(`/api/companies/${company.id}/secrets`)
      .send({ name: "member-made", value: "x" });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    expect(create.body.createdByUserId).toBe(member.userId);

    const rotate = await request(app(member)).post(`/api/secrets/${create.body.id}/rotate`).send({ value: "y" });
    expect(rotate.status, JSON.stringify(rotate.body)).toBe(200);
    expect(rotate.body.latestVersion).toBe(2);
    const rename = await request(app(member)).patch(`/api/secrets/${create.body.id}`).send({ name: "member-renamed" });
    expect(rename.status, JSON.stringify(rename.body)).toBe(200);
    const remove = await request(app(member)).delete(`/api/secrets/${create.body.id}`);
    expect(remove.status, JSON.stringify(remove.body)).toBe(200);
  });

  it("does not let another member change a member's secret", async () => {
    const { company, member, instanceAdmin } = await seed();
    const create = await request(app(member))
      .post(`/api/companies/${company.id}/secrets`)
      .send({ name: "member-made", value: "x" });
    // A second plain member (no instance role).
    const otherId = `member-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId: company.id, principalType: "user", principalId: otherId, status: "active", membershipRole: "member",
    });
    const other = { ...instanceAdmin, userId: otherId, isInstanceAdmin: false };
    const res = await request(app(other)).post(`/api/secrets/${create.body.id}/rotate`).send({ value: "z" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(MEMBER_REFUSAL);
  });

  it("still lets a member list the secrets", async () => {
    const { company, existing, member } = await seed();
    const res = await request(app(member)).get(`/api/companies/${company.id}/secrets`);
    expect(res.status).toBe(200);
    expect(res.body.map((row: { id: string }) => row.id)).toEqual([existing.id]);
  });

  it.each(["owner", "admin", "instanceAdmin", "localBoard"] as const)(
    "lets the %s create, rotate, rename and delete",
    async (who) => {
      const seeded = await seed();
      const actor = seeded[who];
      const create = await request(app(actor))
        .post(`/api/companies/${seeded.company.id}/secrets`)
        .send({ name: `made-${randomUUID().slice(0, 8)}`, value: "x" });
      expect(create.status, JSON.stringify(create.body)).toBe(201);

      const rotate = await request(app(actor)).post(`/api/secrets/${seeded.existing.id}/rotate`).send({ value: "v2" });
      expect(rotate.status, JSON.stringify(rotate.body)).toBe(200);
      expect(rotate.body.latestVersion).toBe(2);

      const rename = await request(app(actor)).patch(`/api/secrets/${seeded.existing.id}`).send({ name: "renamed" });
      expect(rename.status, JSON.stringify(rename.body)).toBe(200);
      expect(rename.body.name).toBe("renamed");

      const remove = await request(app(actor)).delete(`/api/secrets/${create.body.id}`);
      expect(remove.status, JSON.stringify(remove.body)).toBe(200);
    },
  );

  it("keeps the reserved-name refusal for everyone, members included", async () => {
    const { company, member, owner } = await seed();
    for (const actor of [member, owner]) {
      const res = await request(app(actor))
        .post(`/api/companies/${company.id}/secrets`)
        .send({ name: `github-token-${randomUUID()}`, value: "x" });
      expect(res.status).toBe(422);
    }
  });
});
