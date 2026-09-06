import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { evaluationEvents } from "@paperclipai/db";
import { isUuidLike,
  EVALUATION_SCHEMA_VERSION,
  EVALUATION_SKEW_TOLERANCE_MS,
  type EvaluationActorType,
  type EvaluationEventType,
} from "@paperclipai/shared";

/**
 * AgentDash: Company Evaluator — the append-only ledger (spec §8 rules 4–6, §11).
 *
 * Pure helpers (canonical JSON, hashing, dedupe key, event-time clamping,
 * total ordering) live here beside the insert path so tests can pin them
 * without a database, and so replay and ingest share one definition.
 *
 * Two orders matter and must not be confused:
 * - `seq` is insertion order. Replay windows are cut on it, so a stored card
 *   is reproducible no matter what is ingested later.
 * - the event-time order (`compareEvents`) is how events inside a window are
 *   arranged for projection.
 */

export interface EvaluationEventInput {
  companyId: string;
  projectId?: string | null;
  goalId?: string | null;
  actorType: EvaluationActorType;
  actorId?: string | null;
  sourceTable: string;
  sourceId: string;
  sourceVersion: string;
  sourceRowHash?: string | null;
  eventType: EvaluationEventType;
  eventTime: Date;
  payload?: Record<string, unknown>;
  correlationId?: string | null;
}

export type EvaluationEventRow = typeof evaluationEvents.$inferSelect;

/** Deterministic JSON: keys sorted at every depth, no whitespace. Dates become ISO strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Rule 6: the key embeds the company so tenants can never collide. Parts are escaped so `|` in a version cannot alias another key. */
export function dedupeKeyFor(input: Pick<EvaluationEventInput, "companyId" | "sourceTable" | "sourceId" | "eventType" | "sourceVersion">): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  return [input.companyId, input.sourceTable, input.sourceId, input.eventType, input.sourceVersion].map(esc).join("|");
}

export interface ClampResult {
  eventTime: Date;
  /** True when the claimed time was later than arrival (impossible) or absent. */
  clamped: boolean;
  /** How much earlier than arrival the claim was, when it was earlier; 0 otherwise. */
  claimedEarlierByMs: number;
  /** Rule 4: a claim earlier than arrival by more than the tolerance is itself a checkable claim. */
  suspicious: boolean;
}

/**
 * Rule 4: a self-report's own timestamp is never trusted past its arrival.
 * `eventTime = min(claimed, arrival)`; a claim earlier than arrival by more than
 * the skew tolerance is flagged for the contradiction rules.
 */
export function clampEventTime(claimed: Date | string | null | undefined, arrival: Date): ClampResult {
  const claimedDate = claimed == null ? null : claimed instanceof Date ? claimed : new Date(claimed);
  if (!claimedDate || Number.isNaN(claimedDate.getTime())) {
    return { eventTime: arrival, clamped: true, claimedEarlierByMs: 0, suspicious: false };
  }
  if (claimedDate.getTime() > arrival.getTime()) {
    return { eventTime: arrival, clamped: true, claimedEarlierByMs: 0, suspicious: false };
  }
  const earlierBy = arrival.getTime() - claimedDate.getTime();
  return {
    eventTime: claimedDate,
    clamped: false,
    claimedEarlierByMs: earlierBy,
    suspicious: earlierBy > EVALUATION_SKEW_TOLERANCE_MS,
  };
}

/**
 * Rule 5: the total order used inside a replay window. Event time bucketed to
 * the skew tolerance, then ingest time (millisecond), then dedupe key. The
 * dedupe key is unique, so this is a strict total order: the result depends
 * neither on the order rows were read in nor on sort stability. Part of every
 * formulaVersion.
 */
export function compareEvents(
  a: Pick<EvaluationEventRow, "eventTime" | "ingestTime" | "dedupeKey">,
  b: Pick<EvaluationEventRow, "eventTime" | "ingestTime" | "dedupeKey">,
): number {
  const ba = Math.floor(a.eventTime.getTime() / EVALUATION_SKEW_TOLERANCE_MS);
  const bb = Math.floor(b.eventTime.getTime() / EVALUATION_SKEW_TOLERANCE_MS);
  if (ba !== bb) return ba - bb;
  const ia = a.ingestTime.getTime();
  const ib = b.ingestTime.getTime();
  if (ia !== ib) return ia - ib;
  return a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0;
}

export function orderEvents<T extends Pick<EvaluationEventRow, "eventTime" | "ingestTime" | "dedupeKey">>(rows: T[]): T[] {
  return [...rows].sort(compareEvents);
}

export interface AppendResult {
  inserted: number;
  skipped: number;
  insertedIds: string[];
  /** Earliest event time among the rows actually inserted; the ingest-lag gauge. Null when nothing was inserted. */
  oldestInsertedEventTime: Date | null;
}

/** Page size for seq-keyed reads; the window itself is unbounded. */
const PAGE = 5000;

/** Anything that can run the ledger's queries: the pool, or the transaction an ingest tick runs in. */
export type LedgerDb = Pick<Db, "select" | "selectDistinctOn" | "insert" | "execute">;

export function evaluationLedger(db: LedgerDb) {
  return {
    /**
     * Insert events; duplicates by dedupe key are skipped, never overwritten.
     * Chunked so a large backfill does not exceed parameter limits.
     */
    async append(events: EvaluationEventInput[]): Promise<AppendResult> {
      if (events.length === 0) return { inserted: 0, skipped: 0, insertedIds: [], oldestInsertedEventTime: null };
      const rows = events.map((e) => ({
        companyId: e.companyId,
        projectId: e.projectId ?? null,
        goalId: e.goalId ?? null,
        actorType: e.actorType,
        actorId: e.actorId ?? null,
        sourceTable: e.sourceTable,
        sourceId: e.sourceId,
        sourceVersion: e.sourceVersion,
        sourceRowHash: e.sourceRowHash ?? null,
        eventType: e.eventType,
        schemaVersion: EVALUATION_SCHEMA_VERSION,
        eventTime: e.eventTime,
        dedupeKey: dedupeKeyFor(e),
        payload: e.payload ?? {},
        correlationId: e.correlationId ?? null,
      }));
      // Dedupe inside the batch too, so one tick never races itself.
      const seen = new Set<string>();
      const unique = rows.filter((r) => (seen.has(r.dedupeKey) ? false : (seen.add(r.dedupeKey), true)));
      const insertedIds: string[] = [];
      let oldest: Date | null = null;
      const CHUNK = 500;
      for (let i = 0; i < unique.length; i += CHUNK) {
        const chunk = unique.slice(i, i + CHUNK);
        const returned = await db
          .insert(evaluationEvents)
          .values(chunk)
          .onConflictDoNothing({ target: evaluationEvents.dedupeKey })
          .returning({ id: evaluationEvents.id, eventTime: evaluationEvents.eventTime });
        for (const r of returned) {
          insertedIds.push(r.id);
          if (!oldest || r.eventTime < oldest) oldest = r.eventTime;
        }
      }
      return { inserted: insertedIds.length, skipped: events.length - insertedIds.length, insertedIds, oldestInsertedEventTime: oldest };
    },

    /** Highest seq for a company, 0 when the ledger is empty. The snapshot cut point. */
    async maxSeq(companyId: string): Promise<number> {
      const [row] = await db
        .select({ m: sql<number>`coalesce(max(${evaluationEvents.seq}), 0)::bigint` })
        .from(evaluationEvents)
        .where(eq(evaluationEvents.companyId, companyId));
      return Number(row?.m ?? 0);
    },

    /**
     * Every event of a company with seq <= throughSeq, paged on seq so nothing
     * is silently truncated, returned in the rule-5 order. This is the replay
     * window; rows ingested after the cut can never enter it.
     */
    async windowUpTo(companyId: string, throughSeq: number): Promise<EvaluationEventRow[]> {
      const out: EvaluationEventRow[] = [];
      let after = 0;
      for (;;) {
        const page = await db
          .select()
          .from(evaluationEvents)
          .where(and(eq(evaluationEvents.companyId, companyId), gt(evaluationEvents.seq, after), lte(evaluationEvents.seq, throughSeq)))
          .orderBy(asc(evaluationEvents.seq))
          .limit(PAGE);
        out.push(...page);
        if (page.length < PAGE) break;
        after = Number(page[page.length - 1]!.seq);
      }
      return orderEvents(out);
    },

    /** Bounded read for drill-down and the events route (not for replay). */
    /**
     * Events of the company, oldest first by default. `projectId`/`goalId` narrow to the rows tagged with that
     * scope (a drill-down list, not the membership rule the card uses); `throughSeq` cuts at a stored card's
     * sequence; `order: "desc"` returns the newest rows first (still ordered newest first in the result). The
     * descending LIMIT is chosen by raw (eventTime, ingestTime, dedupeKey), so at a five-minute tolerance
     * boundary the set can differ from a strict rule-5 top-N; fine for a bounded drill-down list, and the replay
     * path (`windowUpTo`) does not use it.
     */
    async list(
      companyId: string,
      opts: { types?: EvaluationEventType[]; sinceEventTime?: Date; limit?: number; projectId?: string; goalId?: string; throughSeq?: number; order?: "asc" | "desc" } = {},
    ): Promise<EvaluationEventRow[]> {
      const conds = [eq(evaluationEvents.companyId, companyId)];
      if (opts.types && opts.types.length > 0) conds.push(inArray(evaluationEvents.eventType, opts.types));
      if (opts.sinceEventTime) conds.push(gte(evaluationEvents.eventTime, opts.sinceEventTime));
      if (opts.projectId) conds.push(eq(evaluationEvents.projectId, opts.projectId));
      if (opts.goalId) conds.push(eq(evaluationEvents.goalId, opts.goalId));
      if (opts.throughSeq !== undefined) conds.push(lte(evaluationEvents.seq, Math.max(0, Math.floor(opts.throughSeq))));
      const desc_ = opts.order === "desc";
      const rows = await db
        .select()
        .from(evaluationEvents)
        .where(and(...conds))
        .orderBy(
          desc_ ? desc(evaluationEvents.eventTime) : asc(evaluationEvents.eventTime),
          desc_ ? desc(evaluationEvents.ingestTime) : asc(evaluationEvents.ingestTime),
          desc_ ? desc(evaluationEvents.dedupeKey) : asc(evaluationEvents.dedupeKey),
        )
        .limit(Math.min(opts.limit ?? 1000, 5000));
      const ordered = orderEvents(rows);
      return desc_ ? ordered.reverse() : ordered;
    },

    async countByType(companyId: string): Promise<Record<string, number>> {
      const rows = await db
        .select({ eventType: evaluationEvents.eventType, n: sql<number>`count(*)::int` })
        .from(evaluationEvents)
        .where(eq(evaluationEvents.companyId, companyId))
        .groupBy(evaluationEvents.eventType);
      return Object.fromEntries(rows.map((r) => [r.eventType, r.n]));
    },

    /** The event an append with this source identity deduplicated against (rule 6), or null. */
    async findBySource(companyId: string, sourceTable: string, sourceId: string, sourceVersion: string): Promise<EvaluationEventRow | null> {
      const rows = await db
        .select()
        .from(evaluationEvents)
        .where(and(eq(evaluationEvents.companyId, companyId), eq(evaluationEvents.sourceTable, sourceTable), eq(evaluationEvents.sourceId, sourceId), eq(evaluationEvents.sourceVersion, sourceVersion)))
        .limit(1);
      return (rows[0] as EvaluationEventRow | undefined) ?? null;
    },

    /** One event by id within the company, or null; a non-uuid id is simply absent. */
    async get(companyId: string, id: string): Promise<EvaluationEventRow | null> {
      if (!isUuidLike(id)) return null; // a uuid column: a malformed id is absent, never a cast error
      const rows = await db
        .select()
        .from(evaluationEvents)
        .where(and(eq(evaluationEvents.companyId, companyId), eq(evaluationEvents.id, id)))
        .limit(1);
      return (rows[0] as EvaluationEventRow | undefined) ?? null;
    },

    /** Which of these event ids exist in this company's ledger (citations must point at real facts, §9.3); non-uuid ids are reported missing. */
    async existing(companyId: string, ids: string[]): Promise<Set<string>> {
      const wanted = [...new Set(ids)].filter((x) => isUuidLike(x)); // malformed ids are reported missing, never a cast error
      if (wanted.length === 0) return new Set();
      const rows = await db
        .select({ id: evaluationEvents.id })
        .from(evaluationEvents)
        .where(and(eq(evaluationEvents.companyId, companyId), inArray(evaluationEvents.id, wanted.slice(0, 500))));
      return new Set(rows.map((r) => r.id));
    },

    /** Whether a contract has been declared for a milestone (a `contract.declared` event in scope). */
    async hasContract(companyId: string, ref: { kind: "project" | "goal"; id: string }): Promise<boolean> {
      // Goal-as-milestone membership requires no project (same rule as selectMilestoneEvents).
      const scopeCond =
        ref.kind === "project" ? eq(evaluationEvents.projectId, ref.id) : and(eq(evaluationEvents.goalId, ref.id), isNull(evaluationEvents.projectId));
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(evaluationEvents)
        .where(and(eq(evaluationEvents.companyId, companyId), eq(evaluationEvents.eventType, "contract.declared"), scopeCond));
      return (row?.n ?? 0) > 0;
    },

    /**
     * Source ids already ingested for a table with their scope, excluding ids
     * that already have a terminal `excludeType` event (used by withdrawal
     * detection so the scan does not grow with history).
     */
    async knownSources(
      companyId: string,
      sourceTable: string,
      excludeType?: EvaluationEventType,
    ): Promise<Map<string, { projectId: string | null; goalId: string | null }>> {
      // The exclusion happens in SQL (one row per live source id), not in Node.
      const withdrawn = alias(evaluationEvents, "withdrawn");
      const conds = [eq(evaluationEvents.companyId, companyId), eq(evaluationEvents.sourceTable, sourceTable)];
      if (excludeType) {
        conds.push(ne(evaluationEvents.eventType, excludeType));
        conds.push(
          notExists(
            db
              .select({ one: sql`1` })
              .from(withdrawn)
              .where(
                and(
                  eq(withdrawn.companyId, evaluationEvents.companyId),
                  eq(withdrawn.sourceTable, evaluationEvents.sourceTable),
                  eq(withdrawn.sourceId, evaluationEvents.sourceId),
                  eq(withdrawn.eventType, excludeType),
                ),
              ),
          ),
        );
      }
      const rows = await db
        .selectDistinctOn([evaluationEvents.sourceId], {
          sourceId: evaluationEvents.sourceId,
          projectId: evaluationEvents.projectId,
          goalId: evaluationEvents.goalId,
        })
        .from(evaluationEvents)
        .where(and(...conds))
        .orderBy(evaluationEvents.sourceId, asc(evaluationEvents.seq));
      const out = new Map<string, { projectId: string | null; goalId: string | null }>();
      for (const r of rows) out.set(r.sourceId, { projectId: r.projectId, goalId: r.goalId });
      return out;
    },
  };
}
