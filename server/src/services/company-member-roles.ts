import { PERMISSION_KEYS } from "@paperclipai/shared";
import type { HumanCompanyMembershipRole } from "@paperclipai/shared";

/**
 * The one place legacy role strings die.
 *
 * Stored rows, invite payloads and older clients may still say `owner`,
 * `operator` or `viewer`. Every read of a human role passes through here and
 * comes out as one of exactly two values — no predicate downstream ever
 * compares against a legacy string again. `owner` was always the stronger
 * word for admin; `operator` and `viewer` fold into `member`.
 *
 * The viewer→member mapping is a deliberate power upgrade (viewer was refused
 * every non-GET request). Measured before the collapse shipped: the only
 * viewer rows in existence were uat test users.
 */
export function normalizeHumanRole(
  value: unknown,
  fallback: HumanCompanyMembershipRole = "member"
): HumanCompanyMembershipRole {
  if (value === "owner" || value === "admin") return "admin";
  if (value === "operator" || value === "viewer" || value === "member") return "member";
  return fallback;
}

/**
 * What a role can do without an explicit permission row.
 *
 * Members create their own projects and agents — that was the requirement
 * that started the collapse ("they can create their own projects, of course").
 * What members do NOT get: inviting people, managing permissions, approving
 * joins. Those stay admin-only; the grantable-permission machinery remains
 * the extension point for exceptions.
 *
 * `agents:create` is deliberately ABSENT from member, even though members may
 * create agents. Twenty-one call sites use that grant as the de-facto "is an
 * agent administrator" predicate — governance ceilings, connector setup,
 * stewardship mutations, the inbox override view, billing. Handing it to
 * every member was measured to open all of them (eleven governance tests
 * flipped from 403 to 200). Member agent-CREATION is granted by role at the
 * creation route itself; the permission key keeps meaning administration.
 */
export function grantsForHumanRole(
  role: HumanCompanyMembershipRole
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  switch (role) {
    case "admin":
      return [
        { permissionKey: "agents:create", scope: null },
        { permissionKey: "projects:create", scope: null },
        { permissionKey: "users:invite", scope: null },
        { permissionKey: "users:manage_permissions", scope: null },
        { permissionKey: "tasks:assign", scope: null },
        { permissionKey: "joins:approve", scope: null },
      ];
    case "member":
      return [
        { permissionKey: "projects:create", scope: null },
        { permissionKey: "tasks:assign", scope: null },
      ];
  }
}

export function resolveHumanInviteRole(
  defaultsPayload: Record<string, unknown> | null | undefined
): HumanCompanyMembershipRole {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return "member";
  const scoped = defaultsPayload.human;
  if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) {
    return "member";
  }
  return normalizeHumanRole((scoped as Record<string, unknown>).role, "member");
}
