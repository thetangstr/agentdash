import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import {
  companyMemberships,
  instanceUserRoles,
  principalPermissionGrants,
} from "@agentdash/db";
import type { PermissionKey, PrincipalType } from "@agentdash/shared";
import { conflict } from "../errors.js";

type MembershipRow = typeof companyMemberships.$inferSelect;
type GrantInput = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

// AgentDash (AGE-55): Roles that count as a "board" / admin seat for the
// at-least-one-admin invariant. We treat both "owner" (legacy) and "board"
// as board-equivalent — the LAST one of these on a company can never be
// removed or demoted.
const BOARD_MEMBERSHIP_ROLES = new Set(["owner", "board"]);

export function accessService(db: Db) {
  async function isInstanceAdmin(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    const row = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function getMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ): Promise<MembershipRow | null> {
    return db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, principalType),
          eq(companyMemberships.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function hasPermission(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    const membership = await getMembership(companyId, principalType, principalId);
    if (!membership || membership.status !== "active") return false;
    const grant = await db
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Boolean(grant);
  }

  async function canUser(
    companyId: string,
    userId: string | null | undefined,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    if (!userId) return false;
    if (await isInstanceAdmin(userId)) return true;
    return hasPermission(companyId, "user", userId, permissionKey);
  }

  async function listMembers(companyId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, companyId))
      .orderBy(sql`${companyMemberships.createdAt} desc`);
  }

  async function listActiveUserMemberships(companyId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      )
      .orderBy(sql`${companyMemberships.createdAt} asc`);
  }

  async function setMemberPermissions(
    companyId: string,
    memberId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ) {
    const member = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
      .then((rows) => rows[0] ?? null);
    if (!member) return null;

    await db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, member.principalType),
            eq(principalPermissionGrants.principalId, member.principalId),
          ),
        );
      if (grants.length > 0) {
        await tx.insert(principalPermissionGrants).values(
          grants.map((grant) => ({
            companyId,
            principalType: member.principalType,
            principalId: member.principalId,
            permissionKey: grant.permissionKey,
            scope: grant.scope ?? null,
            grantedByUserId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        );
      }
    });

    return member;
  }

  async function promoteInstanceAdmin(userId: string) {
    const existing = await db
      .select()
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;
    return db
      .insert(instanceUserRoles)
      .values({
        userId,
        role: "instance_admin",
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function demoteInstanceAdmin(userId: string) {
    return db
      .delete(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function listUserCompanyAccess(userId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId)))
      .orderBy(sql`${companyMemberships.createdAt} desc`);
  }

  async function setUserCompanyAccess(userId: string, companyIds: string[]) {
    const existing = await listUserCompanyAccess(userId);
    const existingByCompany = new Map(existing.map((row) => [row.companyId, row]));
    const target = new Set(companyIds);
    const removed = existing.filter((row) => !target.has(row.companyId));

    // AgentDash (AGE-55): centralized last-board guard. Reject the entire
    // mutation if dropping any of the user's memberships would leave a
    // company with no remaining board admin.
    for (const row of removed) {
      await assertNotLastBoardOnRemoval(row);
    }

    await db.transaction(async (tx) => {
      const toDelete = removed.map((row) => row.id);
      if (toDelete.length > 0) {
        await tx.delete(companyMemberships).where(inArray(companyMemberships.id, toDelete));
      }

      for (const companyId of target) {
        if (existingByCompany.has(companyId)) continue;
        await tx.insert(companyMemberships).values({
          companyId,
          principalType: "user",
          principalId: userId,
          status: "active",
          membershipRole: "member",
        });
      }
    });

    return listUserCompanyAccess(userId);
  }

  // AgentDash (AGE-55): centralized last-board guards. Every membership
  // mutation that could remove or demote a board user MUST funnel through
  // these helpers so the at-least-one-admin invariant cannot be violated.
  async function countActiveBoardUserMemberships(
    companyId: string,
    excludeMembershipId?: string,
  ): Promise<number> {
    const baseFilters = [
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active"),
      inArray(companyMemberships.membershipRole, Array.from(BOARD_MEMBERSHIP_ROLES)),
    ];
    const whereExpr = excludeMembershipId
      ? and(...baseFilters, ne(companyMemberships.id, excludeMembershipId))
      : and(...baseFilters);
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(companyMemberships)
      .where(whereExpr);
    return Number(rows[0]?.count ?? 0);
  }

  function isBoardRole(role: string | null | undefined): boolean {
    return role !== null && role !== undefined && BOARD_MEMBERSHIP_ROLES.has(role);
  }

  async function assertNotLastBoardOnRemoval(membership: MembershipRow): Promise<void> {
    if (membership.principalType !== "user") return;
    if (membership.status !== "active") return;
    if (!isBoardRole(membership.membershipRole)) return;
    const remaining = await countActiveBoardUserMemberships(membership.companyId, membership.id);
    if (remaining === 0) {
      throw conflict("Cannot remove the last board admin", {
        code: "last_admin",
        companyId: membership.companyId,
      });
    }
  }

  async function assertNotLastBoardOnRoleChange(
    membership: MembershipRow,
    nextRole: string | null,
    nextStatus: "pending" | "active" | "suspended",
  ): Promise<void> {
    if (membership.principalType !== "user") return;
    const wasBoardActive = membership.status === "active" && isBoardRole(membership.membershipRole);
    const willBeBoardActive = nextStatus === "active" && isBoardRole(nextRole);
    // Only reject when this membership is currently a board admin and the
    // change would strip board-admin status (role demotion or suspension).
    if (!wasBoardActive || willBeBoardActive) return;
    const remaining = await countActiveBoardUserMemberships(membership.companyId, membership.id);
    if (remaining === 0) {
      throw conflict("Cannot demote the last board admin", {
        code: "last_admin",
        companyId: membership.companyId,
      });
    }
  }

  async function removeMembership(membershipId: string): Promise<MembershipRow | null> {
    const existing = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, membershipId))
      .then((rows) => rows[0] ?? null);
    if (!existing) return null;
    await assertNotLastBoardOnRemoval(existing);
    await db.delete(companyMemberships).where(eq(companyMemberships.id, membershipId));
    return existing;
  }

  async function setMembershipRole(
    membershipId: string,
    nextRole: string | null,
    nextStatus: "pending" | "active" | "suspended" = "active",
  ): Promise<MembershipRow | null> {
    const existing = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, membershipId))
      .then((rows) => rows[0] ?? null);
    if (!existing) return null;
    await assertNotLastBoardOnRoleChange(existing, nextRole, nextStatus);
    return db
      .update(companyMemberships)
      .set({ membershipRole: nextRole, status: nextStatus, updatedAt: new Date() })
      .where(eq(companyMemberships.id, membershipId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function ensureMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    membershipRole: string | null = "member",
    status: "pending" | "active" | "suspended" = "active",
  ) {
    const existing = await getMembership(companyId, principalType, principalId);
    if (existing) {
      if (existing.status !== status || existing.membershipRole !== membershipRole) {
        const updated = await db
          .update(companyMemberships)
          .set({ status, membershipRole, updatedAt: new Date() })
          .where(eq(companyMemberships.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return updated ?? existing;
      }
      return existing;
    }

    return db
      .insert(companyMemberships)
      .values({
        companyId,
        principalType,
        principalId,
        status,
        membershipRole,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function setPrincipalGrants(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ) {
    await db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, principalType),
            eq(principalPermissionGrants.principalId, principalId),
          ),
        );
      if (grants.length === 0) return;
      await tx.insert(principalPermissionGrants).values(
        grants.map((grant) => ({
          companyId,
          principalType,
          principalId,
          permissionKey: grant.permissionKey,
          scope: grant.scope ?? null,
          grantedByUserId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
    });
  }

  async function copyActiveUserMemberships(sourceCompanyId: string, targetCompanyId: string) {
    const sourceMemberships = await listActiveUserMemberships(sourceCompanyId);
    for (const membership of sourceMemberships) {
      await ensureMembership(
        targetCompanyId,
        "user",
        membership.principalId,
        membership.membershipRole,
        "active",
      );
    }
    return sourceMemberships;
  }

  async function listPrincipalGrants(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ) {
    return db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
        ),
      )
      .orderBy(principalPermissionGrants.permissionKey);
  }

  async function setPrincipalPermission(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
    enabled: boolean,
    grantedByUserId: string | null,
    scope: Record<string, unknown> | null = null,
  ) {
    if (!enabled) {
      await db
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, principalType),
            eq(principalPermissionGrants.principalId, principalId),
            eq(principalPermissionGrants.permissionKey, permissionKey),
          ),
        );
      return;
    }

    await ensureMembership(companyId, principalType, principalId, "member", "active");

    const existing = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      await db
        .update(principalPermissionGrants)
        .set({
          scope,
          grantedByUserId,
          updatedAt: new Date(),
        })
        .where(eq(principalPermissionGrants.id, existing.id));
      return;
    }

    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType,
      principalId,
      permissionKey,
      scope,
      grantedByUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  return {
    isInstanceAdmin,
    canUser,
    hasPermission,
    getMembership,
    ensureMembership,
    listMembers,
    listActiveUserMemberships,
    copyActiveUserMemberships,
    setMemberPermissions,
    promoteInstanceAdmin,
    demoteInstanceAdmin,
    listUserCompanyAccess,
    setUserCompanyAccess,
    setPrincipalGrants,
    listPrincipalGrants,
    setPrincipalPermission,
    // AgentDash (AGE-55): centralized last-board-admin guards. New
    // membership-mutation endpoints MUST go through these helpers so the
    // at-least-one-admin invariant is enforced everywhere.
    countActiveBoardUserMemberships,
    removeMembership,
    setMembershipRole,
  };
}
