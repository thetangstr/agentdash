import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  bridgeEndpoints,
  companies,
  stewardInboxCursors,
  stewardInboxEvents,
  stewardInboxSequences,
} from "@paperclipai/db";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { isUniqueViolation } from "../lib/pg-error.js";
import { logger } from "../middleware/logger.js";
import { agentAccountabilityService } from "./agent-accountability.js";

/**
 * AgentDash-MK: the steward inbox — stage 1 and 2.
 *
 * What this is: AgentDash owns an ordered, per-steward, durable log, and each
 * of a person's enrolled machines owns a position in it. A machine syncs from
 * its position, applies what it gets, and acknowledges. Nothing is delivered
 * by push and nothing is lost when a machine is off.
 *
 * What this is NOT, yet, and deliberately:
 *
 * - **No decision path.** Redeeming an approval from the inbox is stage 3. The
 *   bridge credential still cannot decide approvals, and widening it would
 *   make enrolling a laptop equivalent to issuing a company credential — the
 *   reason the route allowlist exists at all.
 * - **No digest.** Sync returns events in order. Composing "urgent approvals,
 *   then blockers, then completions" is stage 4, and building it now would
 *   mean shipping a ranking nobody can see.
 * - **No doorbell.** `LIVE_EVENT_TYPES` has no approval events and the live
 *   socket refuses bridge credentials, so an online nudge is stage 5. Until
 *   then a client polls, exactly as `bridge_next_task` already does.
 */

/**
 * The capability an endpoint must have declared to read an inbox.
 *
 * Separate from `bridge:read`. A machine that agents may ask questions of is
 * not automatically a machine that should receive its owner's whole inbox, and
 * an endpoint enrolled before this existed has neither.
 */
export const STEWARD_INBOX_CAPABILITY = "bridge:inbox";

/**
 * The kinds a stage-1 event can be.
 *
 * Kept to what is actually emitted. A vocabulary listing kinds nothing writes
 * reads as coverage that does not exist — blockers and completions arrive with
 * the code that emits them.
 */
export const STEWARD_INBOX_KINDS = ["approval.opened", "approval.resolved"] as const;
export type StewardInboxKind = (typeof STEWARD_INBOX_KINDS)[number];

/** Default and ceiling for one sync page. */
const DEFAULT_SYNC_LIMIT = 50;
const MAX_SYNC_LIMIT = 200;

export interface AppendEventInput {
  companyId: string;
  /** Resolved by the caller, normally via `accountability.escalationUserId`. */
  stewardUserId: string;
  kind: StewardInboxKind;
  refType: string;
  refId: string;
  agentId?: string | null;
  /** Idempotency key, company-scoped. e.g. `approval:<id>:rev2:opened`. */
  dedupeKey: string;
  payload?: Record<string, unknown>;
}

function resultRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: unknown[] }).rows;
  }
  return [];
}

export function stewardInboxService(db: Db) {
  const accountability = agentAccountabilityService(db);

  async function isProfileCompany(companyId: string) {
    const company = await db
      .select({ productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return company?.productProfile === "agentdash_mk";
  }

  /**
   * Append one event to one steward's stream.
   *
   * Returns the assigned `seq`, or null when nothing was written — an unknown
   * company profile, or a `dedupeKey` already present. Null is an ordinary
   * outcome and callers are expected to ignore it: this is called from the
   * approval lifecycle, where failing to record an inbox item must never fail
   * the decision that produced it.
   */
  async function appendEvent(input: AppendEventInput): Promise<{ seq: number } | null> {
    if (!input.stewardUserId) return null;
    if (!STEWARD_INBOX_KINDS.includes(input.kind)) {
      throw badRequest(`Unknown steward inbox kind: ${input.kind}`);
    }
    if (!(await isProfileCompany(input.companyId))) return null;

    try {
      return await db.transaction(async (tx) => {
        // Already recorded. Checked before the sequence is touched so a retry
        // does not consume a position and leave a hole in the stream.
        const existing = await tx
          .select({ seq: stewardInboxEvents.seq })
          .from(stewardInboxEvents)
          .where(
            and(
              eq(stewardInboxEvents.companyId, input.companyId),
              eq(stewardInboxEvents.dedupeKey, input.dedupeKey),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (existing) return null;

        // Create the allocator row if this is the steward's first event. Done
        // before the lock because you cannot lock a row that does not exist.
        await tx
          .insert(stewardInboxSequences)
          .values({ companyId: input.companyId, stewardUserId: input.stewardUserId })
          .onConflictDoNothing();

        // Claim a position. `for update` is what makes the stream gap-free:
        // concurrent appends for THIS steward serialize here, and appends for
        // everyone else are untouched.
        const locked = await tx.execute(sql`
          select ${stewardInboxSequences.nextSeq} as next_seq
          from ${stewardInboxSequences}
          where ${stewardInboxSequences.companyId} = ${input.companyId}
            and ${stewardInboxSequences.stewardUserId} = ${input.stewardUserId}
          for update
        `);
        const row = resultRows(locked)[0] as { next_seq: number | string } | undefined;
        if (!row) throw conflict("Steward inbox sequence disappeared mid-append");
        const seq = Number(row.next_seq);

        await tx.insert(stewardInboxEvents).values({
          companyId: input.companyId,
          stewardUserId: input.stewardUserId,
          seq,
          kind: input.kind,
          refType: input.refType,
          refId: input.refId,
          agentId: input.agentId ?? null,
          dedupeKey: input.dedupeKey,
          payload: input.payload ?? {},
        });

        await tx
          .update(stewardInboxSequences)
          .set({ nextSeq: seq + 1, updatedAt: new Date() })
          .where(
            and(
              eq(stewardInboxSequences.companyId, input.companyId),
              eq(stewardInboxSequences.stewardUserId, input.stewardUserId),
            ),
          );

        return { seq };
      });
    } catch (error) {
      // Two appends raced on the same key and one lost. The loser's whole
      // transaction rolled back, so its position was never consumed and the
      // stream still has no hole.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /**
   * The endpoint, if it may read an inbox at all.
   *
   * Revoked, unapproved, and inbox-less endpoints are refused here rather than
   * at the route, so every caller inherits the same gate.
   */
  async function requireInboxEndpoint(endpointId: string) {
    const endpoint = await db
      .select()
      .from(bridgeEndpoints)
      .where(and(eq(bridgeEndpoints.id, endpointId), isNull(bridgeEndpoints.revokedAt)))
      .then((rows) => rows[0] ?? null);
    if (!endpoint) throw notFound("Endpoint not found");
    if (!endpoint.enrolledAt) throw conflict("That endpoint has not been approved yet");
    if (!(endpoint.capabilities ?? []).includes(STEWARD_INBOX_CAPABILITY)) {
      throw forbidden(`That endpoint did not declare the ${STEWARD_INBOX_CAPABILITY} capability`);
    }
    return endpoint;
  }

  async function readCursor(endpointId: string) {
    const row = await db
      .select({ lastAckedSeq: stewardInboxCursors.lastAckedSeq })
      .from(stewardInboxCursors)
      .where(eq(stewardInboxCursors.endpointId, endpointId))
      .then((rows) => rows[0] ?? null);
    return row?.lastAckedSeq ?? 0;
  }

  /** Highest position that exists in this steward's stream. 0 when empty. */
  async function headSeq(companyId: string, stewardUserId: string) {
    const row = await db
      .select({ seq: stewardInboxEvents.seq })
      .from(stewardInboxEvents)
      .where(
        and(
          eq(stewardInboxEvents.companyId, companyId),
          eq(stewardInboxEvents.stewardUserId, stewardUserId),
        ),
      )
      .orderBy(desc(stewardInboxEvents.seq))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row?.seq ?? 0;
  }

  /**
   * Everything this machine has not acknowledged, oldest first.
   *
   * Does NOT advance the cursor. Delivery is at-least-once on purpose: a
   * client that crashes between receiving and applying must see the same
   * events again, and the only thing that can say it applied them is the
   * client itself. `acknowledge` is that statement.
   */
  async function syncForEndpoint(
    endpointId: string,
    options: { limit?: number } = {},
  ): Promise<{
    lastAckedSeq: number;
    headSeq: number;
    events: Array<{
      seq: number;
      kind: string;
      refType: string;
      refId: string;
      agentId: string | null;
      payload: Record<string, unknown>;
      createdAt: string;
    }>;
    hasMore: boolean;
  }> {
    const endpoint = await requireInboxEndpoint(endpointId);
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_SYNC_LIMIT, 1), MAX_SYNC_LIMIT);
    const lastAckedSeq = await readCursor(endpointId);

    const rows = await db
      .select({
        seq: stewardInboxEvents.seq,
        kind: stewardInboxEvents.kind,
        refType: stewardInboxEvents.refType,
        refId: stewardInboxEvents.refId,
        agentId: stewardInboxEvents.agentId,
        payload: stewardInboxEvents.payload,
        createdAt: stewardInboxEvents.createdAt,
      })
      .from(stewardInboxEvents)
      .where(
        and(
          eq(stewardInboxEvents.companyId, endpoint.companyId),
          eq(stewardInboxEvents.stewardUserId, endpoint.userId),
          gt(stewardInboxEvents.seq, lastAckedSeq),
        ),
      )
      .orderBy(asc(stewardInboxEvents.seq))
      // One extra row is the cheapest honest way to answer "is there more?"
      // without a second count query.
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      lastAckedSeq,
      headSeq: await headSeq(endpoint.companyId, endpoint.userId),
      events: page.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        refType: row.refType,
        refId: row.refId,
        agentId: row.agentId,
        payload: (row.payload ?? {}) as Record<string, unknown>,
        createdAt: row.createdAt.toISOString(),
      })),
      hasMore,
    };
  }

  /**
   * Move this machine's position forward.
   *
   * Two clamps, and both matter:
   *
   * - **Never backwards.** A client replaying an old sync must not un-see
   *   things, or an inbox oscillates forever.
   * - **Never past the head.** A client acknowledging a position that does not
   *   exist yet would silently skip every event up to it. That is the one way
   *   this design could lose an update, so it is refused at the only place it
   *   could happen.
   */
  async function acknowledge(endpointId: string, seq: number): Promise<{ lastAckedSeq: number }> {
    if (!Number.isInteger(seq) || seq < 0) throw badRequest("seq must be a non-negative integer");
    const endpoint = await requireInboxEndpoint(endpointId);

    const head = await headSeq(endpoint.companyId, endpoint.userId);
    const current = await readCursor(endpointId);
    const next = Math.max(current, Math.min(seq, head));

    if (next === current) {
      // Nothing to do, and saying so is cheaper than an update that changes
      // nothing. Still a success: acking twice is not an error.
      return { lastAckedSeq: current };
    }

    await db
      .insert(stewardInboxCursors)
      .values({ endpointId, lastAckedSeq: next })
      .onConflictDoUpdate({
        target: stewardInboxCursors.endpointId,
        set: { lastAckedSeq: next, updatedAt: new Date() },
      });

    if (seq > head) {
      logger.warn(
        { endpointId, requestedSeq: seq, head },
        "steward inbox ack clamped to stream head",
      );
    }

    return { lastAckedSeq: next };
  }

  /**
   * Record an approval reaching, or leaving, a steward's attention.
   *
   * The addressing lives here rather than at each call site because getting it
   * wrong is silent. Using the stewardship directly would deliver nothing at
   * all for an autonomous agent, which is the bug approval card delivery
   * already hit and fixed by asking `escalationUserId` — the steward when
   * there is one, the accountable human when there is not.
   *
   * Never throws. This is a side effect of a governed decision, and an inbox
   * write must not be able to fail the decision that produced it.
   */
  async function recordApprovalEvent(approvalId: string, kind: StewardInboxKind): Promise<void> {
    try {
      const approval = await db
        .select({
          id: approvals.id,
          companyId: approvals.companyId,
          requestedByAgentId: approvals.requestedByAgentId,
          revision: approvals.revision,
          status: approvals.status,
          type: approvals.type,
        })
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .then((rows) => rows[0] ?? null);
      if (!approval) return;

      // No requesting agent means nobody in particular to route to; those are
      // administrator business and live on the Override screen. Same rule as
      // approval card delivery, deliberately.
      if (!approval.requestedByAgentId) return;

      const stewardUserId = await accountability.escalationUserId(
        approval.companyId,
        approval.requestedByAgentId,
      );
      if (!stewardUserId) return;

      const suffix = kind === "approval.opened" ? "opened" : "resolved";
      await appendEvent({
        companyId: approval.companyId,
        stewardUserId,
        kind,
        refType: "approval",
        refId: approval.id,
        agentId: approval.requestedByAgentId,
        // Revision is in the key so a resubmit is a NEW inbox item rather than
        // a duplicate of the one already acknowledged.
        dedupeKey: `approval:${approval.id}:rev${approval.revision}:${suffix}`,
        // Thin by policy: the type, where it stands, and which revision. The
        // approval's own payload carries adapter configuration and similar
        // material and is deliberately not copied here.
        payload: { approvalType: approval.type, revision: approval.revision, status: approval.status },
      });
    } catch (error) {
      logger.warn({ err: error, approvalId, kind }, "steward inbox approval event not recorded");
    }
  }

  return { appendEvent, recordApprovalEvent, syncForEndpoint, acknowledge };
}
