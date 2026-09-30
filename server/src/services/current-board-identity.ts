// AgentDash: native board identity facts, bound once to the actual Request.
// Callers own company/action policy and lock execution; this reader grants neither.
import type { Request } from "express";
import { and, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { type Db, authSessions, authUsers, boardApiKeys, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { unauthorized } from "../errors.js";
import { verifiedBoardCredential } from "../middleware/auth.js";

export type BoardIdentityWitness = Readonly<{ key: string; lock: SQL }>;
export type CurrentBoardPrincipal = Readonly<{
  source: "board_key" | "session" | "local_implicit";
  userId: string | null;
  credentialDeadline: number | null;
  witnesses: readonly BoardIdentityWitness[];
  user: Readonly<{ id: string; name: string; email: string }> | null;
  adminRoleIds: readonly string[];
}>;
export type CurrentBoardIdentity = CurrentBoardPrincipal & Readonly<{
  membership: Readonly<{ id: string; role: string | null; status: string }> | null;
  actorRefresh: Readonly<{
    userId: string;
    memberships: readonly Readonly<{ companyId: string; membershipRole: string | null; status: string }>[];
    companyIds: readonly string[];
    isInstanceAdmin: boolean;
  }> | null;
}>;

function originalBoardKey(req: Request) {
  const credential = verifiedBoardCredential(req);
  if (!credential) throw unauthorized();
  // Do not retain the bearer-bearing WeakMap value in the identity closure.
  return { userId: credential.userId, keyId: credential.keyId, expiresAt: credential.expiresAt };
}
const minimumDeadline = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.min(a, b);
const byId = (table: SQLWrapper, id: string) => sql`select id from ${table} where id = ${id} for share`;

export function currentBoardIdentity(req: Request) {
  const { type, source, userId, keyId } = req.actor;
  if (type !== "board" || (source !== "board_key" && source !== "session" && source !== "local_implicit")) throw unauthorized();
  const key = source === "board_key" ? originalBoardKey(req) : null;
  const session = source === "session" && req.verifiedCredential?.kind === "session"
    ? { sessionId: req.verifiedCredential.sessionId, userId: req.verifiedCredential.userId } : null;
  if (source !== "local_implicit" && (!userId || (source === "session" && (!session || session.userId !== userId)))) throw unauthorized();
  let credentialDeadline = key?.expiresAt ?? null;

  function checkTime() {
    if (req.actor.type !== type || req.actor.source !== source || req.actor.userId !== userId || req.actor.keyId !== keyId) throw unauthorized();
    if (key) {
      const current = verifiedBoardCredential(req);
      if (!current || current.userId !== key.userId || current.keyId !== key.keyId) throw unauthorized();
    }
    if (session && (req.verifiedCredential?.kind !== "session" || req.verifiedCredential.sessionId !== session.sessionId || req.verifiedCredential.userId !== session.userId)) throw unauthorized();
    if (credentialDeadline !== null && credentialDeadline <= Date.now()) throw unauthorized();
  }
  checkTime();

  const readPrincipal = async (reader: Pick<Db, "select">): Promise<CurrentBoardPrincipal> => {
    checkTime();
    if (source === "local_implicit") return {
      source, userId: userId ?? null, user: null, credentialDeadline: null, witnesses: [], adminRoleIds: [],
    };
    const witnesses: BoardIdentityWitness[] = [];
    let liveDeadline: number | null = null;
    if (session) {
      const [row] = await reader.select({ id: authSessions.id, userId: authSessions.userId, expiresAt: authSessions.expiresAt })
        .from(authSessions).where(eq(authSessions.id, session.sessionId));
      if (!row || row.userId !== userId || row.expiresAt.getTime() <= Date.now()) throw unauthorized();
      liveDeadline = row.expiresAt.getTime();
      witnesses.push({ key: `08:session:${row.id}`, lock: byId(authSessions, row.id) });
    } else if (key) {
      const [row] = await reader.select({ id: boardApiKeys.id, userId: boardApiKeys.userId, revokedAt: boardApiKeys.revokedAt, expiresAt: boardApiKeys.expiresAt })
        .from(boardApiKeys).where(eq(boardApiKeys.id, key.keyId));
      if (!row || row.userId !== key.userId || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) throw unauthorized();
      liveDeadline = row.expiresAt?.getTime() ?? null;
      witnesses.push({ key: `08:board_key:${row.id}`, lock: byId(boardApiKeys, row.id) });
    }
    const [user] = await reader.select({ id: authUsers.id, name: authUsers.name, email: authUsers.email }).from(authUsers).where(eq(authUsers.id, userId!));
    if (!user) throw unauthorized();
    witnesses.push({ key: `00:user:${user.id}`, lock: byId(authUsers, user.id) });
    const admins = await reader.select().from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, user.id), eq(instanceUserRoles.role, "instance_admin")));
    for (const admin of admins) witnesses.push({ key: `11:admin:${admin.id}`, lock: byId(instanceUserRoles, admin.id) });
    // A reread or editable returned profile cannot lengthen a validated deadline.
    credentialDeadline = minimumDeadline(credentialDeadline, liveDeadline);
    checkTime();
    return { source, userId: user.id, user, credentialDeadline, witnesses, adminRoleIds: admins.map(admin => admin.id) };
  };

  return {
    checkTime,
    readPrincipal,
    async read(reader: Pick<Db, "select">, companyId: string): Promise<CurrentBoardIdentity> {
      const principal = await readPrincipal(reader);
      checkTime();
      if (principal.source === "local_implicit") return { ...principal, membership: null, actorRefresh: null };
      const [member] = await reader.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, principal.userId!), eq(companyMemberships.status, "active")));
      const witnesses = [...principal.witnesses];
      if (member) witnesses.push({ key: `09:membership:${member.id}`, lock: byId(companyMemberships, member.id) });
      checkTime();
      return {
        ...principal, credentialDeadline, witnesses,
        membership: member ? { id: member.id, role: member.membershipRole, status: member.status } : null,
        actorRefresh: { userId: principal.userId!,
          memberships: member ? [{ companyId, membershipRole: member.membershipRole, status: member.status }] : [],
          companyIds: member ? [companyId] : [], isInstanceAdmin: principal.adminRoleIds.length > 0 },
      };
    },
  };
}
