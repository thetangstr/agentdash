import type { Request } from "express";
import { forbidden, unauthorized } from "../errors.js";

export function assertAuthenticated(req: Request) {
  if (req.actor.type === "none") {
    throw unauthorized();
  }
}

export function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function hasBoardOrgAccess(req: Request) {
  if (req.actor.type !== "board") {
    return false;
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return true;
  }
  return Array.isArray(req.actor.companyIds) && req.actor.companyIds.length > 0;
}

export function assertBoardOrgAccess(req: Request) {
  assertBoard(req);
  if (hasBoardOrgAccess(req)) {
    return;
  }
  throw forbidden("Company membership or instance admin access required");
}

/** Just enough of the access service to resolve one membership. */
export interface MembershipReader {
  getMembership: (
    companyId: string,
    principalType: "user",
    principalId: string,
  ) => Promise<{ status?: string | null; membershipRole?: string | null } | null>;
}

/**
 * Is this caller an owner or admin of the company?
 *
 * Membership and administration are different questions, and conflating them is
 * how a viewer ends up able to cancel the subscription. `assertCompanyAccess`
 * answers "may this person see this company at all"; this answers "may they make
 * a decision on its behalf".
 *
 * One implementation on purpose. This predicate was previously inlined at each
 * call site, and a security check with two copies is a security check that will
 * eventually disagree with itself.
 */
export async function isCompanyAdministrator(
  access: MembershipReader,
  req: Request,
  companyId: string,
): Promise<boolean> {
  if (req.actor.type !== "board") return false;
  // The founder's own machine, and instance admins, are administrators
  // everywhere — the same exemption every other guard here makes.
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  if (!req.actor.userId) return false;
  const membership = await access.getMembership(companyId, "user", req.actor.userId);
  return (
    membership?.status === "active" &&
    (membership.membershipRole === "owner" || membership.membershipRole === "admin")
  );
}

export async function assertCompanyAdministrator(
  access: MembershipReader,
  req: Request,
  companyId: string,
  message = "Company owner or admin access required",
): Promise<void> {
  if (await isCompanyAdministrator(access, req, companyId)) return;
  throw forbidden(message);
}

export function assertInstanceAdmin(req: Request) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function assertCompanyAccess(req: Request, companyId: string) {
  assertAuthenticated(req);
  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }
  if (req.actor.type === "board" && req.actor.source !== "local_implicit") {
    const allowedCompanies = req.actor.companyIds ?? [];
    if (!allowedCompanies.includes(companyId)) {
      throw forbidden("User does not have access to this company");
    }
    const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
    const isSafeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
    if (!isSafeMethod && !req.actor.isInstanceAdmin && Array.isArray(req.actor.memberships)) {
      const membership = req.actor.memberships.find((item) => item.companyId === companyId);
      if (!membership || membership.status !== "active") {
        throw forbidden("User does not have active company access");
      }
      if (membership.membershipRole === "viewer") {
        throw forbidden("Viewer access is read-only");
      }
    }
  }
}

export function getActorInfo(req: Request) {
  assertAuthenticated(req);
  if (req.actor.type === "agent") {
    return {
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? "unknown-agent",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
    };
  }

  return {
    actorType: "user" as const,
    actorId: req.actor.userId ?? "board",
    agentId: null,
    runId: req.actor.runId ?? null,
  };
}
