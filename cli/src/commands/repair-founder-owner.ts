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
 * --apply refuses a user with neither unless --force is passed.
 *
 * Live sessions: the server's live-event bus is in-process (see
 * server/src/realtime/live-events-access.ts), so this separate process cannot
 * publish to it. The change only adds access (member -> owner), so no socket
 * has to be closed; the server's periodic websocket re-authorization and the
 * next page load pick the new role up.
 */
import os from "node:os";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
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
type Reader = Pick<Db, "select">;
type MembershipRow = typeof companyMemberships.$inferSelect;

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

/** Whether the evidence says this member created the company. */
export function hasCreatorEvidence(member: FounderEvidenceMember): boolean {
  return member.loggedCompanyCreated || member.earliestUntouchedMembership;
}

/** The evidence for each human membership of one company, earliest first. */
async function memberEvidence(
  db: Reader,
  company: { id: string; createdAt: Date },
  memberships: MembershipRow[],
): Promise<FounderEvidenceMember[]> {
  if (memberships.length === 0) return [];
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

  const ordered = [...memberships].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
  const earliest = ordered[0]!;
  const earliestInWindow =
    Math.abs(earliest.createdAt.getTime() - company.createdAt.getTime()) <= FOUNDER_MEMBERSHIP_WINDOW_MS;

  return ordered.map((m) => {
    const hasJoinRequest = requesters.has(m.principalId);
    const membershipEdited = editedMemberships.has(m.id);
    return {
      userId: m.principalId,
      membershipId: m.id,
      role: m.membershipRole,
      status: m.status,
      joinedAt: m.createdAt,
      loggedCompanyCreated: creators.has(m.principalId),
      earliestUntouchedMembership: m.id === earliest.id && earliestInWindow && !hasJoinRequest && !membershipEdited,
      hasJoinRequest,
      membershipEdited,
    };
  });
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
      .where(and(eq(companyMemberships.companyId, company.id), eq(companyMemberships.principalType, "user")));
    const hasActiveOwner = memberships.some((m) => m.status === "active" && m.membershipRole === "owner");
    if (hasActiveOwner || memberships.length === 0) continue;
    candidates.push({
      companyId: company.id,
      companyName: company.name,
      companyCreatedAt: company.createdAt,
      members: await memberEvidence(db, company, memberships),
    });
  }
  return candidates;
}

export type FounderOwnerRepairOutcome =
  | { status: "restored"; membershipId: string; pairedCosAgentId: string | null; backfill: AgentAccountabilityBackfill | null }
  | { status: "already_owner" }
  | { status: "company_not_found" }
  | { status: "company_archived" }
  | { status: "company_has_owner_or_admin" }
  | { status: "no_active_membership" }
  | { status: "no_creator_evidence" };

/**
 * What migration 0144's backfill did for the company (see
 * agentdash_backfill_agent_accountability). Null when the database predates
 * that migration and the function does not exist.
 */
export interface AgentAccountabilityBackfill {
  paired: number;
  retitled: number;
  madeAutonomous: number;
  skippedHeldCredential: string[];
  /** Set when the company is not eligible: another active human, or the user is not its owner/admin. */
  skipped?: string;
}

/**
 * AgentDash (canary1): migration 0144 repairs pre-#975 agents only where the
 * sole human is an owner or admin, so a company whose founder was demoted
 * could never be backfilled. Once this command restores the owner, run the
 * same SQL function for that company, inside the repair's transaction. The
 * function is idempotent, so a second run changes nothing.
 */
async function runAgentAccountabilityBackfill(
  tx: Pick<Db, "execute">,
  companyId: string,
  userId: string,
): Promise<AgentAccountabilityBackfill | null> {
  const present = (await tx.execute(
    sql`select to_regprocedure('agentdash_backfill_agent_accountability(uuid,text,text)') is not null as present`,
  )) as unknown as Array<{ present: boolean }>;
  if (!present[0]?.present) return null;
  const rows = (await tx.execute(
    sql`select agentdash_backfill_agent_accountability(${companyId}::uuid, ${userId}, ${REPAIR_ACTOR_ID}) as result`,
  )) as unknown as Array<{ result: AgentAccountabilityBackfill }>;
  return rows[0]?.result ?? null;
}

export interface RepairOperator {
  osUser: string;
  host: string;
}

/** Who ran the repair, for the audit row. */
export function currentOperator(): RepairOperator {
  let osUser = process.env.USER ?? process.env.USERNAME ?? "unknown";
  try {
    osUser = os.userInfo().username || osUser;
  } catch {
    // userInfo throws when the uid has no passwd entry (some containers).
  }
  return { osUser, host: os.hostname() };
}

/**
 * Promote exactly the named user to `owner`, in one transaction under the
 * company row lock. Refuses on an archived company, when the company has any
 * active owner or admin, when the user has no active membership, and when the
 * dry-run checks found no creator evidence for them (unless `force`). A
 * second run is a no-op. Pairs them with the company's Chief of Staff when
 * neither side is paired yet. Audited as `company.owner_restored` with a
 * system actor, the evidence, the OS user and the host.
 */
export async function applyFounderOwnerRepair(
  db: Db,
  input: { companyId: string; userId: string; force?: boolean; operator?: RepairOperator },
): Promise<FounderOwnerRepairOutcome> {
  const operator = input.operator ?? currentOperator();
  return db.transaction(async (tx) => {
    const [company] = await tx
      .select({ id: companies.id, status: companies.status, createdAt: companies.createdAt })
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .for("update");
    if (!company) return { status: "company_not_found" } as const;
    if (company.status === "archived") return { status: "company_archived" } as const;

    const memberships = await tx
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, input.companyId), eq(companyMemberships.principalType, "user")));
    const membership = memberships.find((m) => m.principalId === input.userId);
    if (!membership || membership.status !== "active") return { status: "no_active_membership" } as const;
    if (membership.membershipRole === "owner") return { status: "already_owner" } as const;
    const administered = memberships.some(
      (m) => m.status === "active" && (m.membershipRole === "owner" || m.membershipRole === "admin"),
    );
    if (administered) return { status: "company_has_owner_or_admin" } as const;

    const evidence = (await memberEvidence(tx, company, memberships)).find((m) => m.userId === input.userId) ?? null;
    const evidenced = evidence ? hasCreatorEvidence(evidence) : false;
    if (!evidenced && !input.force) return { status: "no_creator_evidence" } as const;

    await tx
      .update(companyMemberships)
      .set({ membershipRole: "owner", updatedAt: new Date() })
      .where(eq(companyMemberships.id, membership.id));

    const pairedCosAgentId = await pairWithChiefOfStaff(tx, input.companyId, input.userId);
    const backfill = await runAgentAccountabilityBackfill(tx, input.companyId, input.userId);

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
        creatorEvidence: evidence
          ? {
              loggedCompanyCreated: evidence.loggedCompanyCreated,
              earliestUntouchedMembership: evidence.earliestUntouchedMembership,
            }
          : null,
        forced: !evidenced,
        pairedCosAgentId,
        agentBackfill: backfill,
        operator: { osUser: operator.osUser, host: operator.host },
      },
    });
    return { status: "restored", membershipId: membership.id, pairedCosAgentId, backfill } as const;
  });
}

/**
 * The pairing the demotion prevented, written the way
 * agentStewardshipService.assign writes it: the agent row locked, a terminated
 * or autonomous agent refused, nothing done when either side is already
 * paired, and an `agent.stewardship_assigned` audit row.
 */
async function pairWithChiefOfStaff(tx: Pick<Db, "select" | "insert">, companyId: string, userId: string): Promise<string | null> {
  const [cos] = await tx
    .select({ id: agents.id, autonomy: agents.autonomy })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, "chief_of_staff"), ne(agents.status, "terminated")))
    .orderBy(asc(agents.createdAt))
    .limit(1)
    .for("update");
  if (!cos || cos.autonomy === "autonomous") return null;
  const live = await tx
    .select({ agentId: agentStewardships.agentId, userId: agentStewardships.userId })
    .from(agentStewardships)
    .where(and(eq(agentStewardships.companyId, companyId), isNull(agentStewardships.endedAt)));
  if (live.some((row) => row.agentId === cos.id || row.userId === userId)) return null;
  const now = new Date();
  const [row] = await tx
    .insert(agentStewardships)
    .values({ companyId, agentId: cos.id, userId, assignedByUserId: null, startedAt: now, createdAt: now, updatedAt: now })
    .returning();
  await tx.insert(activityLog).values({
    companyId,
    actorType: "system",
    actorId: REPAIR_ACTOR_ID,
    action: "agent.stewardship_assigned",
    entityType: "agent_stewardship",
    entityId: row!.id,
    agentId: cos.id,
    details: { userId, agentId: cos.id },
  });
  return cos.id;
}

function describeMember(member: FounderEvidenceMember): string {
  const evidence: string[] = [];
  if (member.loggedCompanyCreated) evidence.push(pc.green("logged company.created"));
  if (member.earliestUntouchedMembership) evidence.push(pc.green("earliest membership, at company creation"));
  if (member.hasJoinRequest) evidence.push(pc.yellow("joined by request"));
  if (member.membershipEdited) evidence.push(pc.yellow("membership edited by an admin"));
  return `${member.userId}  role=${member.role ?? "none"} status=${member.status} joined=${member.joinedAt.toISOString()}`
    + (evidence.length > 0 ? `  (${evidence.join(", ")})` : "  (no creator evidence)");
}

const REFUSALS: Record<Exclude<FounderOwnerRepairOutcome["status"], "restored" | "already_owner">, string> = {
  company_not_found: "No company with that id.",
  company_archived: "The company is archived.",
  company_has_owner_or_admin: "The company already has an active owner or admin; they can change roles in the app.",
  no_active_membership: "That user has no active membership in the company.",
  no_creator_evidence: "No creator evidence for that user. Check the dry run; pass --force only if you are sure.",
};

export async function repairFounderOwner(opts: {
  config?: string;
  dbUrl?: string;
  company?: string;
  user?: string;
  apply?: boolean;
  force?: boolean;
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
    p.log.error("--apply needs both --company and --user. Run without --apply first to see the evidence.");
    process.exitCode = 1;
    return;
  }
  const db = createDb(dbUrl);
  const closable = db as typeof db & { $client?: { end?: (o?: { timeout?: number }) => Promise<void> } };
  try {
    const candidates = await findFounderOwnerCandidates(db, { companyId: opts.company });
    if (candidates.length === 0) {
      p.log.info(opts.company ? "That company has an active owner, or is archived; nothing to list." : "Every company has an active owner.");
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
    const outcome = await applyFounderOwnerRepair(db, {
      companyId: opts.company!,
      userId: opts.user!,
      force: opts.force === true,
    });
    if (outcome.status === "restored") {
      p.log.success(
        `Restored ${opts.user} as owner of ${opts.company}`
          + (outcome.pairedCosAgentId ? ` and paired them with the Chief of Staff (${outcome.pairedCosAgentId}).` : ".")
          + " Open sessions pick up the new role on their next re-authorization or page load.",
      );
      if (outcome.backfill?.skipped) {
        p.log.info("Agent backfill skipped: the company has other active members, so who answers for each agent is theirs to decide.");
      } else if (outcome.backfill) {
        const b = outcome.backfill;
        p.log.info(
          `Agent backfill: ${b.madeAutonomous} made autonomous with them accountable, ${b.retitled} retitled, `
            + `${b.paired} Chief of Staff paired.`
            + (b.skippedHeldCredential.length > 0
              ? ` Left stewarded because a person holds a key or connect code: ${b.skippedHeldCredential.join(", ")}.`
              : ""),
        );
      } else {
        p.log.warn("The agent backfill (migration 0144) is not installed in this database; agents were not repaired.");
      }
    } else if (outcome.status === "already_owner") {
      p.log.info(`${opts.user} is already the owner. Nothing changed.`);
    } else {
      p.log.error(`${REFUSALS[outcome.status]} Nothing changed.`);
      process.exitCode = 1;
    }
  } finally {
    await closable.$client?.end?.({ timeout: 5 });
  }
}
