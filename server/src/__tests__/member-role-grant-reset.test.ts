// AgentDash (security, GH #978): a role-only member PATCH used to leave
// explicit permission grants untouched — a member whose role changed kept
// grants minted for the old role, and hasPermission still honoured them. The
// PATCH (and the service-level updateMember the issue names) now rewrite
// grants to the new role's defaults inside the same transaction, and the
// activity row records the reset.
//
// The route refuses to manage a member at-or-above the actor's own role, so
// the reachable role change is member -> admin; the admin -> member demotion
// the issue describes happens through access.updateMember (service level) and
// is covered directly.
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";
import { accessService } from "../services/access.js";
import { grantsForHumanRole } from "../services/company-member-roles.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

const ADMIN_DEFAULT_GRANTS = grantsForHumanRole("admin").map((grant) => grant.permissionKey).sort();
const MEMBER_DEFAULT_GRANTS = grantsForHumanRole("member").map((grant) => grant.permissionKey).sort();

describeEmbeddedPostgres("PATCH /companies/:companyId/members/:memberId grant reset (GH #978)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-member-grant-reset-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(userId: string, companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).actor = {
        type: "board",
        source: "session",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "admin" }],
      };
      next();
    });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);
    return app;
  }

  async function seedUser(email: string, name: string) {
    const userId = `user-${randomUUID()}`;
    await db.insert(authUsers).values({
      id: userId,
      email,
      name,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return userId;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Grant Reset Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedMembership(
    companyId: string,
    userId: string,
    membershipRole: string,
    opts: { status?: string } = {},
  ) {
    const rows = await db
      .insert(companyMemberships)
      .values({
        companyId,
        principalType: "user",
        principalId: userId,
        status: opts.status ?? "active",
        membershipRole,
      })
      .returning();
    return rows[0]!;
  }

  async function seedGrants(companyId: string, userId: string, keys: string[]) {
    for (const permissionKey of keys) {
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "user",
        principalId: userId,
        permissionKey,
        scope: null,
        grantedByUserId: "seeder",
      });
    }
  }

  async function grantKeysFor(companyId: string, userId: string) {
    const rows = await db
      .select({ permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, userId),
        ),
      );
    return rows.map((row) => row.permissionKey).sort();
  }

  it("resets grants to the new role's defaults when a member is promoted to admin", async () => {
    const companyId = await seedCompany();
    const adminUserId = await seedUser("admin@example.com", "Admin");
    const memberUserId = await seedUser("member@example.com", "Member");
    await seedMembership(companyId, adminUserId, "admin");
    const member = await seedMembership(companyId, memberUserId, "member");
    // Grants from an earlier bespoke grant — a superset that must not carry.
    await seedGrants(companyId, memberUserId, [
      "projects:create",
      "tasks:assign",
      "users:manage_permissions",
      "joins:approve",
    ]);
    const app = createApp(adminUserId, companyId);

    const res = await request(app)
      .patch(`/api/companies/${companyId}/members/${member.id}`)
      .send({ membershipRole: "admin" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.membershipRole).toBe("admin");
    expect(await grantKeysFor(companyId, memberUserId)).toEqual(ADMIN_DEFAULT_GRANTS);

    const activity = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "company_member.updated"),
          eq(activityLog.entityId, member.id),
        ),
      );
    expect(activity).toHaveLength(1);
    expect(activity[0]?.details).toMatchObject({
      membershipRole: "admin",
      grantsReset: { fromRole: "member", toRole: "admin", grantedByUserId: adminUserId },
    });
  });

  it("keeps grants untouched when only the member's status changes", async () => {
    const companyId = await seedCompany();
    const adminUserId = await seedUser("admin@example.com", "Admin");
    const memberUserId = await seedUser("member@example.com", "Member");
    await seedMembership(companyId, adminUserId, "admin");
    const member = await seedMembership(companyId, memberUserId, "member");
    const grantedKeys = ["projects:create", "tasks:assign", "joins:approve"];
    await seedGrants(companyId, memberUserId, grantedKeys);
    const app = createApp(adminUserId, companyId);

    const res = await request(app)
      .patch(`/api/companies/${companyId}/members/${member.id}`)
      .send({ status: "suspended" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("suspended");
    expect(await grantKeysFor(companyId, memberUserId)).toEqual([...grantedKeys].sort());
  });

  it("resets grants to member defaults when an admin is demoted (service path)", async () => {
    const companyId = await seedCompany();
    const adminUserId = await seedUser("admin@example.com", "Admin");
    const otherAdminId = await seedUser("other@example.com", "Other Admin");
    const demoted = await seedMembership(companyId, adminUserId, "admin");
    // A second admin keeps the last-active-admin guard out of the way.
    await seedMembership(companyId, otherAdminId, "admin");
    await seedGrants(companyId, adminUserId, [
      "agents:create",
      "projects:create",
      "users:invite",
      "users:manage_permissions",
      "tasks:assign",
      "joins:approve",
    ]);

    const updated = await accessService(db).updateMember(companyId, demoted.id, {
      membershipRole: "member",
    });

    expect(updated?.membershipRole).toBe("member");
    expect(await grantKeysFor(companyId, adminUserId)).toEqual(MEMBER_DEFAULT_GRANTS);
  });
});
