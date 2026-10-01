// AgentDash (GH #505): who may read company members' email addresses.
//
// The decision, recorded where every roster read can see it:
//
//   - Agents never receive member email addresses. They get ids and display
//     names, which is everything escalation, assignment and @-mentions need. An
//     agent's context is assembled from untrusted material, and an address is
//     the first thing a prompt injection would exfiltrate -- so the contact
//     detail does not travel to agents at all, rather than being one prompt
//     away from leaving. (Option 2 on #505: narrow the shape for agent callers.)
//   - Humans see other members' addresses only where the product needs them:
//     people who manage members (`users:manage_permissions`, which is also the
//     gate on `/companies/:companyId/members`), instance admins, and the
//     single-user local_trusted board. Everyone else gets names and ids, the
//     same as an agent, plus their own address.
//
// Reading a roster confers no authority, but a list of addresses is still a
// list of addresses. This predicate is the one place that answers the
// question, so the routes that return people cannot drift apart.
import type { Request } from "express";
import type { PermissionKey } from "@paperclipai/shared";

/** Just enough of the access service to answer one permission question. */
export interface MemberEmailPermissionReader {
  canUser: (
    companyId: string,
    userId: string | null | undefined,
    permissionKey: PermissionKey,
  ) => Promise<boolean>;
}

export async function canViewMemberEmails(
  access: MemberEmailPermissionReader,
  req: Request,
  companyId: string,
): Promise<boolean> {
  if (req.actor.type !== "board") return false;
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  if (!req.actor.userId) return false;
  return access.canUser(companyId, req.actor.userId, "users:manage_permissions");
}

/**
 * The email this caller may see for `subjectUserId`: the stored address when
 * they may view member emails or it is their own, otherwise null. An agent
 * never matches "own" -- its actor carries no user id.
 */
export function visibleMemberEmail(
  req: Request,
  canView: boolean,
  subjectUserId: string | null | undefined,
  email: string | null | undefined,
): string | null {
  if (email == null) return null;
  if (canView) return email;
  if (
    req.actor.type === "board" &&
    req.actor.userId &&
    subjectUserId &&
    req.actor.userId === subjectUserId
  ) {
    return email;
  }
  return null;
}
