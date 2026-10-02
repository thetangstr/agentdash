/**
 * AgentDash (scan 3, lane H): operator repair for founders the old permission
 * grant demoted from `owner` to `member`.
 *
 * Before PR #975, `setPrincipalPermission` upserted the caller's membership as
 * `member`, so the /cos bootstrap's `agents:create` grant demoted a founder who
 * had created the company at /company-create. The code fix stops new
 * demotions; this command repairs companies that were already hit.
 *
 * It is deliberately an operator action, not something the server does on its
 * own. A runtime rule ("the only human, no admin, self-granted agents:create")
 * was shown in review to promote the wrong person: invite auto-approval and the
 * instance-admin bootstrap path both leave a self-granted agents:create on
 * someone who never founded the company. So this command only lists
 * candidates with their evidence, and promotes nobody unless an operator names
 * both the company and the user and passes --apply.
 *
 * Evidence shown for each human member of a company with no active owner:
 *   - `company.created` in the activity log with that user as the actor;
 *   - being the earliest human membership, created within
 *     FOUNDER_MEMBERSHIP_WINDOW_MS of the company, with no join request from
 *     that user and no `company_member.updated` targeting the membership.
 */
import * as p from "@clack/prompts";
import pc from "picocolors";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentStewardships,
  companies,
  companyMemberships,
  createDb,
  joinRequests,
} from "@paperclipai/db";
import { loadPaperclipEnvFile } from "../config/env.js";
import { resolveConfigPath } from "../config/store.js";
import { resolveDbUrl } from "./auth-bootstrap-ceo.js";

type Db = ReturnType<typeof createDb>;

/** A membership created this close to the company is the creator's own row. */
export const FOUNDER_MEMBERSHIP_WINDOW_MS = 60_000;

export const REPAIR_ACTOR_ID = "cli:doctor repair-founder-owner";

export interface FounderEvidenceMember {
  userId: string;
  membershipId: string;
  role: string | null;
  status: string;
  joinedAt: Date;
  /** `company.created` was logged with this user as the actor. */
  loggedCompanyCreated: boolean;
  /** Earliest human membership, within the window, never joined by request, never edited by an admin. */
  earliestUntouchedMembership: boolean;
  hasJoinRequest: boolean;
  membershipEdited: boolean;
}

export interface FounderOwnerCandidate {
  companyId: string;
  companyName: string;
  companyCreatedAt: Date;
  members: FounderEvidenceMember[];
}

/** Companies (not archived) with no active `owner`, and the evidence for each human member. */
export async function findFounderOwnerCandidates(
  db: Db,
  options: { companyId?: string } = {},
): Promise<FounderOwnerCandidate[]> {
  const companyRows = await db
    .select({ id: companies.id, name: companies.name, createdAt: companies.createdAt })
    .from(companies)
    .where(
      options.companyId
        ? and(eq(companies.id, options.companyId), ne(companies.status, "archived"))
        : ne(companies.status, "archived"),
    )
    .orderBy(asc(companies.createdAt));

  const candidates: FounderOwnerCandidate[] = [];
  for (const company of companyRows) {
    const memberships = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, company.id), eq(companyMemberships.principalType, "user")))
      .orderBy(asc(companyMemberships.createdAt));
    const hasActiveOwner = memberships.some((m) => m.status === "active" && m.membershipRole === "owner");
    if (hasActiveOwner || memberships.length === 0) continue;

    const userIds = memberships.map((m) => m.principalId);
    const created = await db
      .select({ actorId: activityLog.actorId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, company.id),
          eq(activityLog.action, "company.created"),
          eq(activityLog.actorType, "user"),
        ),
      );
    const creators = new Set(created.map((row) => row.actorId));
    const requests = await db
      .select({ userId: joinRequests.requestingUserId })
      .from(joinRequests)
      .where(and(eq(joinRequests.companyId, company.id), inArray(joinRequests.requestingUserId, userIds)));
    const requesters = new Set(requests.map((row) => row.userId));
    const edits = await db
      .select({ entityId: activityLog.entityId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, company.id),
          eq(activityLog.action, "company_member.updated"),
          eq(activityLog.entityType, "company_membership"),
        ),
      );
    const editedMemberships = new Set(edits.map((row) => row.entityId));

    const earliest = memberships[0]!;
    const earliestInWindow =
      Math.abs(earliest.createdAt.getTime() - company.createdAt.getTime()) <= FOUNDER_MEMBERSHIP_WINDOW_MS;

    candidates.push({
      companyId: company.id,
      companyName: company.name,
      companyCreatedAt: company.createdAt,
      members: memberships.map((m) => {
        const hasJoinRequest = requesters.has(m.principalId);
        const membershipEdited = editedMemberships.has(m.id);
        return {
          userId: m.principalId,
          membershipId: m.id,
          role: m.membershipRole,
          status: m.status,
          joinedAt: m.createdAt,
          loggedCompanyCreated: creators.has(m.principalId),
          earliestUntouchedMembership:
            m.id === earliest.id && earliestInWindow && !hasJoinRequest && !membershipEdited,
          hasJoinRequest,
          membershipEdited,
        };
      }),
    });
  }
  return candidates;
}

export type FounderOwnerRepairOutcome =
  | { status: "restored"; membershipId: string; pairedCosAgentId: string | null }
  | { status: "already_owner" }
  | { status: "company_has_owner" }
  | { status: "no_active_membership" };

/**
 * Promote exactly the named user to `owner`. Refuses when the company already
 * has an active owner or the user has no active membership; a second run is a
 * no-op. Also pairs them with the company's Chief of Staff when neither side
 * is paired yet (the pairing the demotion prevented). Audited as
 * `company.owner_restored` with a system actor.
 */
export async function applyFounderOwnerRepair(
  db: Db,
  input: { companyId: string; userId: string },
): Promise<FounderOwnerRepairOutcome> {
  return db.transaction(async (tx) => {
    await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, input.companyId)).for("update");
    const [membership] = await tx
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, input.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, input.userId),
        ),
      );
    if (!membership || membership.status !== "active") return { status: "no_active_membership" } as const;
    if (membership.membershipRole === "owner") return { status: "already_owner" } as const;
    const [owner] = await tx
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, input.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
          eq(companyMemberships.membershipRole, "owner"),
        ),
      );
    if (owner) return { status: "company_has_owner" } as const;

    await tx
      .update(companyMemberships)
      .set({ membershipRole: "owner", updatedAt: new Date() })
      .where(eq(companyMemberships.id, membership.id));

    let pairedCosAgentId: string | null = null;
    const [cos] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, input.companyId),
          eq(agents.role, "chief_of_staff"),
          ne(agents.status, "terminated"),
          eq(agents.autonomy, "stewarded"),
        ),
      );
    if (cos) {
      const active = await tx
        .select({ agentId: agentStewardships.agentId, userId: agentStewardships.userId, endedAt: agentStewardships.endedAt })
        .from(agentStewardships)
        .where(eq(agentStewardships.companyId, input.companyId));
      const live = active.filter((row) => row.endedAt === null);
      if (!live.some((row) => row.agentId === cos.id) && !live.some((row) => row.userId === input.userId)) {
        await tx.insert(agentStewardships).values({
          companyId: input.companyId,
          agentId: cos.id,
          userId: input.userId,
          assignedByUserId: null,
          transferReason: "founder owner repair",
        });
        pairedCosAgentId = cos.id;
      }
    }

    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: REPAIR_ACTOR_ID,
      action: "company.owner_restored",
      entityType: "company_membership",
      entityId: membership.id,
      details: {
        userId: input.userId,
        from: membership.membershipRole,
        to: "owner",
        reason: "founder demoted by a permission grant (operator repair)",
        pairedCosAgentId,
      },
    });
    return { status: "restored", membershipId: membership.id, pairedCosAgentId } as const;
  });
}

function describeMember(member: FounderEvidenceMember): string {
  const evidence: string[] = [];
  if (member.loggedCompanyCreated) evidence.push(pc.green("logged company.created"));
  if (member.earliestUntouchedMembership) evidence.push(pc.green("earliest membership, at company creation"));
  if (member.hasJoinRequest) evidence.push(pc.yellow("joined by request"));
  if (member.membershipEdited) evidence.push(pc.yellow("membership edited by an admin"));
  return `${member.userId}  role=${member.role ?? "none"} status=${member.status} joined=${member.joinedAt.toISOString()}`
    + (evidence.length > 0 ? `  [${evidence.join(", ")}]` : "");
}

export async function repairFounderOwner(opts: {
  config?: string;
  dbUrl?: string;
  company?: string;
  user?: string;
  apply?: boolean;
}): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  loadPaperclipEnvFile(configPath);
  const dbUrl = resolveDbUrl(configPath, opts.dbUrl);
  if (!dbUrl) {
    p.log.error("Could not resolve the database connection. Set DATABASE_URL or pass --db-url.");
    process.exitCode = 1;
    return;
  }
  if (opts.apply && (!opts.company || !opts.user)) {
    p.log.error("--apply needs both --company <id> and --user <id>. Run without --apply first to see the evidence.");
    process.exitCode = 1;
    return;
  }
  const db = createDb(dbUrl);
  const closable = db as typeof db & { $client?: { end?: (o?: { timeout?: number }) => Promise<void> } };
  try {
    const candidates = await findFounderOwnerCandidates(db, { companyId: opts.company });
    if (candidates.length === 0) {
      p.log.info(opts.company ? "That company has an active owner; nothing to repair." : "Every company has an active owner.");
    }
    for (const candidate of candidates) {
      p.log.info(
        `${pc.bold(candidate.companyName)} (${candidate.companyId}), created ${candidate.companyCreatedAt.toISOString()}: no active owner`,
      );
      for (const member of candidate.members) p.log.message(`  ${describeMember(member)}`);
    }
    if (!opts.apply) {
      p.log.info(`Dry run. To promote one person: ${pc.cyan("--company <id> --user <id> --apply")}`);
      return;
    }
    const outcome = await applyFounderOwnerRepair(db, { companyId: opts.company!, userId: opts.user! });
    if (outcome.status === "restored") {
      p.log.success(
        `Restored ${opts.user} as owner of ${opts.company}`
          + (outcome.pairedCosAgentId ? ` and paired them with the Chief of Staff (${outcome.pairedCosAgentId}).` : "."),
      );
    } else if (outcome.status === "already_owner") {
      p.log.info(`${opts.user} is already the owner. Nothing changed.`);
    } else if (outcome.status === "company_has_owner") {
      p.log.warn("The company already has an active owner. Nothing changed.");
    } else {
      p.log.error(`${opts.user} has no active membership in ${opts.company}. Nothing changed.`);
      process.exitCode = 1;
    }
  } finally {
    await closable.$client?.end?.({ timeout: 5 });
  }
}
