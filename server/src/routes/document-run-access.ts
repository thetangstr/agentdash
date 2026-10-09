// AgentDash (per-steward document access, slice 6b): who may read a run's
// content in a company with `document_access_enabled` on.
//
// A document-enabled agent reads its steward's files, and its transcript can
// quote them. So while the flag is on, a run's content — the run row's free
// text, its events and its log — is readable only by the run agent's CURRENT
// steward (the live `agent_stewardships` row) or an instance admin. Everyone
// else gets 404, as for an agent hidden by agent visibility: the run is
// nonexistent to them. With the flag off nothing changes.
//
// Listings keep the row (status, timing, cost) so counts and dashboards stay
// right, but drop its free text (`withoutRunContent`).
import type { Request } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentStewardships } from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { featureFlagsService } from "../services/feature-flags.js";

type Actor = Request["actor"];

/** The local board and instance admins read every run. */
export function actorBypassesDocumentRunRule(actor: Actor): boolean {
  return actor.type === "board" && (actor.source === "local_implicit" || actor.isInstanceAdmin === true);
}

export function documentRunAccess(db: Db) {
  const flags = featureFlagsService(db);

  function documentAccessEnabled(companyId: string): Promise<boolean> {
    return flags.isEnabled(companyId, FEATURE_FLAG_KEYS.DOCUMENT_ACCESS);
  }

  async function currentStewardUserId(companyId: string, agentId: string): Promise<string | null> {
    const row = await db
      .select({ userId: agentStewardships.userId })
      .from(agentStewardships)
      .where(
        and(
          eq(agentStewardships.companyId, companyId),
          eq(agentStewardships.agentId, agentId),
          isNull(agentStewardships.endedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return row?.userId ?? null;
  }

  /** May this actor read this run's content? */
  async function canReadRunContent(actor: Actor, run: { companyId: string; agentId: string }): Promise<boolean> {
    if (!(await documentAccessEnabled(run.companyId))) return true;
    if (actorBypassesDocumentRunRule(actor)) return true;
    if (actor.type !== "board" || !actor.userId) return false;
    return (await currentStewardUserId(run.companyId, run.agentId)) === actor.userId;
  }

  /** 404 unless `canReadRunContent`; same message as a missing run. */
  async function assertRunContentReadable(req: Request, run: { companyId: string; agentId: string }): Promise<void> {
    if (!(await canReadRunContent(req.actor, run))) throw notFound("Heartbeat run not found");
  }

  /**
   * For listings: null when the actor may read every run of the company, else
   * the agents whose runs it may read (those it currently stewards).
   */
  async function readableAgentIds(actor: Actor, companyId: string): Promise<ReadonlySet<string> | null> {
    if (!(await documentAccessEnabled(companyId))) return null;
    if (actorBypassesDocumentRunRule(actor)) return null;
    if (actor.type !== "board" || !actor.userId) return new Set();
    const rows = await db
      .select({ agentId: agentStewardships.agentId })
      .from(agentStewardships)
      .where(
        and(
          eq(agentStewardships.companyId, companyId),
          eq(agentStewardships.userId, actor.userId),
          isNull(agentStewardships.endedAt),
        ),
      );
    return new Set(rows.map((row) => row.agentId));
  }

  return {
    documentAccessEnabled,
    currentStewardUserId,
    canReadRunContent,
    assertRunContentReadable,
    readableAgentIds,
  };
}

/** Free-text fields a run row (or a listing projection of one) may carry. */
const RUN_CONTENT_FIELDS = [
  "error",
  "resultJson",
  "stdoutExcerpt",
  "stderrExcerpt",
  "contextSnapshot",
  "resultSummary",
  "resultResult",
  "resultMessage",
  "resultError",
] as const;

/** The row with its free text nulled; fields it does not have stay absent. */
export function withoutRunContent<T extends object>(row: T): T {
  const next: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const field of RUN_CONTENT_FIELDS) {
    if (field in next) next[field] = null;
  }
  return next as T;
}

/** Apply `withoutRunContent` to rows whose agent is not in `readable` (null = all readable). */
export function withholdUnreadableRunContent<T extends { agentId: string }>(
  rows: T[],
  readable: ReadonlySet<string> | null,
): T[] {
  if (readable === null) return rows;
  return rows.map((row) => (readable.has(row.agentId) ? row : withoutRunContent(row)));
}
