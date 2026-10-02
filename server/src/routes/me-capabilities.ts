// What the signed-in person may do here — asked once, answered by the server.
//
// The UI had no notion of permissions at all: no hook, no context, one component
// hand-checking `membershipRole !== "viewer"`. That was survivable while every
// mutation was membership-gated. It stopped being survivable the moment the
// direction guard landed, because now a member opens a goal, sees Edit, clicks,
// and gets a bare 403 — which reads as a broken product rather than a boundary.
//
// The rule this endpoint exists to enforce on ourselves: **the client never
// re-derives an authorization rule.** It asks. Every boolean below is computed
// by the same predicate the enforcing route uses, so the two cannot drift into
// disagreement. A UI that decides for itself who may edit a goal will be wrong
// eventually, and the wrongness shows up as either a control that 403s or a
// missing control that should have been there.

import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { accessService } from "../services/index.js";
import { requireProductProfile } from "../services/companies.js";
import { assertAuthenticated, assertCompanyAccess, canSetCompanyDirection } from "./authz.js";

/**
 * Capability keys the UI may ask about.
 *
 * Deliberately coarse. These name what a person is trying to do — "can I change
 * what this company is aiming at" — rather than mirroring route names, because
 * a UI keyed to routes has to change every time a route does.
 */
export type CapabilityKey =
  | "direction:set"
  | "agents:create"
  | "users:invite"
  | "users:manage_permissions"
  | "tasks:assign";

/**
 * Workspace features the UI would otherwise discover by probing a gated route
 * and reading its 404.
 *
 * AgentDash (scan 3 lane L): Decisions, the sidebar badge, My Agent and the
 * ceiling editor each probed `/me/inbox`, `/me/fact-requests`,
 * `/inbox/override`, `connector-send-executions` and `/agents/:id/governance`
 * to learn whether stewardship was on, and a workspace without it paid about
 * 77 console 404s per route per session. This answers the same question once,
 * with a 200.
 *
 * `stewardship` is decided by `requireProductProfile(company, "agentdash_mk")`,
 * the very predicate those routes gate on, so the two cannot disagree. It is a
 * fact about the workspace, not a permission: each gated route still runs its
 * own authority check (a 403 there stays a 403). `null` means "could not tell";
 * the UI then falls back to probing, as before.
 */
export interface WorkspaceFeatures {
  stewardship: boolean | null;
}

async function workspaceFeatures(db: Db, companyId: string): Promise<WorkspaceFeatures> {
  try {
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    try {
      requireProductProfile(company, "agentdash_mk");
      return { stewardship: true };
    } catch {
      return { stewardship: false };
    }
  } catch {
    // The lookup itself failed: unknown, not "off".
    return { stewardship: null };
  }
}

export function meCapabilityRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);

  router.get("/me/capabilities", async (req, res) => {
    assertAuthenticated(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : "";
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }
    // Reuses the same access check every other route runs, so asking about a
    // company you cannot see fails identically to touching it.
    assertCompanyAccess(req, companyId);

    const isInstanceAdmin = Boolean(req.actor.isInstanceAdmin) || req.actor.source === "local_implicit";
    const membership = Array.isArray(req.actor.memberships)
      ? req.actor.memberships.find((item) => item.companyId === companyId)
      : undefined;

    // Permission-key capabilities go through the access service rather than
    // being inferred from the role, because an owner can delegate them
    // individually and the UI must reflect the delegation, not the title.
    const permissionKeys = [
      "agents:create",
      "users:invite",
      "users:manage_permissions",
      "tasks:assign",
    ] as const;
    const granted = await Promise.all(
      permissionKeys.map(async (key) => {
        if (isInstanceAdmin) return true;
        if (req.actor.type !== "board" || !req.actor.userId) return false;
        // Fail closed: an access-service error must not read as permission.
        return access.canUser(companyId, req.actor.userId, key).catch(() => false);
      }),
    );

    const capabilities: Record<CapabilityKey, boolean> = {
      "direction:set": canSetCompanyDirection(req, companyId),
      "agents:create": granted[0],
      "users:invite": granted[1],
      "users:manage_permissions": granted[2],
      "tasks:assign": granted[3],
    };

    res.json({
      companyId,
      actorType: req.actor.type,
      membershipRole: membership?.membershipRole ?? null,
      isInstanceAdmin,
      capabilities,
      features: await workspaceFeatures(db, companyId),
    });
  });

  return router;
}
