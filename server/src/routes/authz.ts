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

/**
 * Who may change what the company is trying to do.
 *
 * `assertCompanyAccess` answers "does this caller belong here", which is the
 * right question for ordinary work and the wrong one for direction. Under it,
 * any active non-viewer member could rewrite a company goal, and so could any
 * agent holding a key for the company — verified against a live instance, where
 * an agent PATCHed the goal it had been given and got HTTP 200.
 *
 * Two separate problems, and the agent one is the sharper of them:
 *
 *  - A colleague invited to help should not be able to redefine the objectives
 *    they were invited to work toward.
 *  - An agent must never edit its own objectives. Everything downstream —
 *    whether work is on-track, whether a mandate was honoured, what the board
 *    pack reports — is measured against the goal. An agent that can move the
 *    goal can report success by moving it, and the audit trail will faithfully
 *    record that the goal simply changed.
 *
 * So: agents are refused outright, and humans need owner, admin or operator.
 * Operator is included deliberately — it sits between admin and member and
 * names someone who runs the company day to day, which is exactly who adjusts a
 * goal. Instance admins pass, as they do everywhere. Read paths are untouched —
 * everyone who can see the company can still see its goals.
 */
export function assertCanSetCompanyDirection(req: Request, companyId: string) {
  assertCompanyAccess(req, companyId);

  if (req.actor.type === "agent") {
    throw forbidden(
      "Agents cannot change company direction. Ask an owner or admin to change the goal.",
    );
  }
  if (canSetCompanyDirection(req, companyId)) return;

  throw forbidden("Only an owner, admin or operator can change company direction.");
}

/**
 * The same question as `assertCanSetCompanyDirection`, answered instead of
 * thrown — so the UI can ask before it offers a control.
 *
 * One predicate, two callers, deliberately. The client must never re-derive
 * this rule: a UI that decides for itself who may edit a goal will disagree
 * with the server eventually, and the disagreement shows up as either a control
 * that 403s or a control that should have been there and wasn't. Both read as a
 * broken product.
 *
 * Note this does NOT include the company-access check — callers that enforce
 * use the assert above, which runs it first. This form is for a caller that has
 * already established access and only wants the answer.
 */
export function canSetCompanyDirection(req: Request, companyId: string): boolean {
  if (req.actor.type === "agent") return false;
  // A local_trusted board with no real user is the operator at their own
  // machine; there is no one else to defer to.
  if (req.actor.type === "board" && req.actor.source === "local_implicit") return true;
  if (req.actor.isInstanceAdmin) return true;

  const membership = Array.isArray(req.actor.memberships)
    ? req.actor.memberships.find((item) => item.companyId === companyId)
    : undefined;
  const role = membership?.membershipRole;
  return role === "owner" || role === "admin" || role === "operator";
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
