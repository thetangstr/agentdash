import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, evaluationIngestState } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { classifyEvent, restrictedProjectIds, type EvaluationClassContext } from "./access-class.js";
import { evaluationLedger, type EvaluationEventInput, type LedgerDb } from "./ledger.js";
import { detectWithdrawnComments, SOURCE_READERS, type Cursor, type SourceName, type Tx } from "./sources.js";

/**
 * AgentDash: Company Evaluator — the ingest loop (spec §11).
 *
 * One tick for one company is one transaction: a per-company advisory lock
 * serialises ticks across service instances (the scheduler and the operator
 * route hold separate instances, possibly separate processes), a local
 * statement timeout bounds every read, and the cursor advance commits together
 * with the events it covers. Never on the request path of anything else,
 * never on the heartbeat scheduler tick. Backfill is the same tick run to
 * exhaustion, bounded.
 *
 * AgentDash (APM gate 3): every event gets its evidence access class here,
 * from its source row (`classifyEvent`), with the company's restricted
 * projects read once per tick inside the same transaction. Already stored
 * rows are never reclassified (the ledger is append-only); readers apply the
 * live restricted-project rule on top of the stored class.
 */

/** The class an ingested event carries, from its source's hints and the tick's restricted projects. */
export function withAccessClass(e: EvaluationEventInput, ctx: EvaluationClassContext): EvaluationEventInput {
  if (e.accessClass) return e;
  const accessClass = classifyEvent(
    {
      sourceTable: e.sourceTable,
      eventType: e.eventType,
      projectId: e.projectId ?? null,
      pairingReceiptId: e.classHints?.pairingReceiptId ?? null,
      privateAgentId: e.classHints?.privateAgentId ?? null,
    },
    ctx,
  );
  return { ...e, accessClass };
}

export interface IngestOptions {
  /** Rows read per source per tick. */
  rowBudget?: number;
  /** Postgres statement_timeout for the tick's transaction. */
  statementTimeoutMs?: number;
  /** Only these sources (tests). */
  sources?: SourceName[];
  now?: () => Date;
  /** Rule 13 withdrawal detection scans every known comment id, so it runs on this cadence, not every tick. */
  withdrawalCheckIntervalMs?: number;
  /**
   * The pause between two ticks of one scheduled pass, taken outside the
   * company lock, so other ledger writers (snapshots, dispositions, contract
   * declarations) get the lock while a long history is read. 0 in tests.
   */
  passYieldMs?: number;
  /** After a failed scheduled pass the company waits this long, doubling per further failure... */
  failureBackoffMs?: number;
  /** ...up to this. */
  failureBackoffMaxMs?: number;
  /** Replace a source's reader (tests: a source that fails or times out partway through a pass). */
  readers?: Partial<Record<SourceName, (typeof SOURCE_READERS)[SourceName]>>;
  /** How the pass waits between ticks (tests). */
  pause?: (ms: number) => Promise<void>;
}

export interface SourceTickStats {
  scanned: number;
  produced: number;
  inserted: number;
  skipped: number;
  durationMs: number;
}

export interface CompanyTickStats {
  companyId: string;
  scanned: number;
  inserted: number;
  skipped: number;
  durationMs: number;
  /** Now minus the oldest event time inserted this tick; null when nothing was inserted. */
  maxLagMs: number | null;
  /** Whether withdrawal detection ran this tick. */
  withdrawalChecked: boolean;
  perSource: Record<string, SourceTickStats>;
}

/** One company's share of a scheduled pass: one or more ticks, summed (`tickAll`). */
export interface ScheduledCompanyStats extends CompanyTickStats {
  /** Ticks this scheduled pass ran for the company (more than one while history is being read). */
  passes: number;
  /** The longest single tick: how long the company lock was held at most, and what the statement timeout bounds. */
  maxTickMs: number;
  /** False when the pass stopped at its bound with rows still waiting; the next scheduled pass goes on from the cursor. */
  caughtUp: boolean;
}

const DEFAULT_ROW_BUDGET = 5000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_WITHDRAWAL_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_PASS_YIELD_MS = 2000;
const DEFAULT_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_FAILURE_BACKOFF_MAX_MS = 60 * 60 * 1000;
/** Operator-triggered backfill is bounded so a request cannot run for minutes. */
export const MAX_BACKFILL_PASSES = 20;
/** Advisory-lock key prefix; the key is the 64-bit `hashtextextended` of prefix + companyId (collisions negligible). */
export const INGEST_LOCK_PREFIX = "evaluation_ingest:";

/**
 * Run `fn` in a transaction holding the company's evaluator lock, or refuse
 * with 409. Everything that appends to the ledger — ingest ticks, snapshots
 * (findings) and contract declarations — takes this lock, so `seq` keeps a
 * single writer per company and a stored card's window never gains a row
 * that committed later with a lower seq.
 */
export async function withCompanyLock<T>(db: Db, companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const lock = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${INGEST_LOCK_PREFIX + companyId}, 0)) as locked`);
    // The driver returns the rows as an array-like list (node-postgres would wrap them in `rows`).
    const lockRows = (Array.isArray(lock) ? lock : ((lock as { rows?: unknown[] }).rows ?? [])) as Array<{ locked?: boolean }>;
    if (lockRows[0]?.locked !== true) throw conflict("evaluation_ingest: a pass is already running for this company");
    return fn(tx);
  });
}

export function evaluationIngest(db: Db, opts: IngestOptions = {}) {
  const rowBudget = opts.rowBudget ?? DEFAULT_ROW_BUDGET;
  const statementTimeoutMs = Math.max(1000, Math.floor(opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS));
  const sources = opts.sources ?? (Object.keys(SOURCE_READERS) as SourceName[]);
  const now = opts.now ?? (() => new Date());
  const withdrawalCheckIntervalMs = Math.max(0, opts.withdrawalCheckIntervalMs ?? DEFAULT_WITHDRAWAL_CHECK_INTERVAL_MS);
  const passYieldMs = Math.max(0, opts.passYieldMs ?? DEFAULT_PASS_YIELD_MS);
  const failureBackoffMs = Math.max(0, opts.failureBackoffMs ?? DEFAULT_FAILURE_BACKOFF_MS);
  const failureBackoffMaxMs = Math.max(failureBackoffMs, opts.failureBackoffMaxMs ?? DEFAULT_FAILURE_BACKOFF_MAX_MS);
  const pause = opts.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const readerOf = (source: SourceName) => opts.readers?.[source] ?? SOURCE_READERS[source];
  let inFlight = false;
  /**
   * Companies whose last scheduled pass failed (a statement timeout or any
   * other error), with the time before which the schedule leaves them alone.
   * In memory: a restart tries again at once.
   */
  const backoff = new Map<string, { failures: number; until: number; error: string }>();

  async function loadCursors(q: LedgerDb, companyId: string): Promise<Record<string, Cursor>> {
    const rows = await q.select().from(evaluationIngestState).where(eq(evaluationIngestState.companyId, companyId));
    return Object.fromEntries(rows.map((r) => [r.source, (r.cursor ?? {}) as Cursor]));
  }

  async function saveCursor(q: LedgerDb, companyId: string, source: string, cursor: Cursor): Promise<void> {
    await q
      .insert(evaluationIngestState)
      .values({ companyId, source, cursor: cursor as Record<string, unknown>, updatedAt: now() })
      .onConflictDoUpdate({
        target: [evaluationIngestState.companyId, evaluationIngestState.source],
        set: { cursor: cursor as Record<string, unknown>, updatedAt: now() },
      });
  }

  function withdrawalDue(cursor: Cursor | undefined): boolean {
    const last = cursor?.withdrawalCheckedAt ? Date.parse(cursor.withdrawalCheckedAt) : NaN;
    return !Number.isFinite(last) || now().getTime() - last >= withdrawalCheckIntervalMs;
  }

  async function tickOnce(companyId: string): Promise<CompanyTickStats> {
    const started = Date.now();
    return withCompanyLock(db, companyId, async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`);

      const ledger = evaluationLedger(tx);
      const cursors = await loadCursors(tx, companyId);
      const classCtx: EvaluationClassContext = { restrictedProjectIds: await restrictedProjectIds(tx, companyId) };
      const perSource: Record<string, SourceTickStats> = {};
      let scanned = 0;
      let inserted = 0;
      let skipped = 0;
      let maxLagMs: number | null = null;
      let withdrawalChecked = false;
      for (const source of sources) {
        const t0 = Date.now();
        const result = await readerOf(source)(tx, companyId, cursors[source] ?? {}, rowBudget);
        let events = result.events;
        let nextCursor: Cursor = result.nextCursor;
        let checkedNow = false;
        if (source === "issue_comments") {
          // Rule 13: withdrawal detection rides on the comments pass on its own cadence;
          // ids already recorded as withdrawn are excluded so the scan does not grow with history.
          if (withdrawalDue(cursors[source])) {
            const known = await ledger.knownSources(companyId, "issue_comments", "evidence.withdrawn");
            const at = now();
            events = events.concat(await detectWithdrawnComments(tx, companyId, known, at));
            nextCursor = { ...nextCursor, withdrawalCheckedAt: at.toISOString() };
            checkedNow = true;
            withdrawalChecked = true;
          } else if (cursors[source]?.withdrawalCheckedAt) {
            nextCursor = { ...nextCursor, withdrawalCheckedAt: cursors[source]!.withdrawalCheckedAt };
          }
        }
        const appended = await ledger.append(events.map((e) => withAccessClass(e, classCtx)));
        if (result.scanned > 0 || checkedNow) await saveCursor(tx, companyId, source, nextCursor);
        if (appended.oldestInsertedEventTime) {
          maxLagMs = Math.max(maxLagMs ?? 0, now().getTime() - appended.oldestInsertedEventTime.getTime());
        }
        perSource[source] = {
          scanned: result.scanned,
          produced: events.length,
          inserted: appended.inserted,
          skipped: appended.skipped,
          durationMs: Date.now() - t0,
        };
        scanned += result.scanned;
        inserted += appended.inserted;
        skipped += appended.skipped;
      }
      return { companyId, scanned, inserted, skipped, durationMs: Date.now() - started, maxLagMs, withdrawalChecked, perSource };
    });
  }

  /** A tick that read a full budget from any source may have left rows behind it. */
  function moreWaiting(stats: CompanyTickStats): boolean {
    return Object.values(stats.perSource).some((s) => s.scanned >= rowBudget);
  }

  function addTick(total: ScheduledCompanyStats, stats: CompanyTickStats): void {
    total.passes++;
    total.maxTickMs = Math.max(total.maxTickMs, stats.durationMs);
    total.scanned += stats.scanned;
    total.inserted += stats.inserted;
    total.skipped += stats.skipped;
    total.durationMs += stats.durationMs;
    if (stats.maxLagMs != null) total.maxLagMs = Math.max(total.maxLagMs ?? 0, stats.maxLagMs);
    total.withdrawalChecked ||= stats.withdrawalChecked;
    for (const [source, s] of Object.entries(stats.perSource)) {
      const t = (total.perSource[source] ??= { scanned: 0, produced: 0, inserted: 0, skipped: 0, durationMs: 0 });
      t.scanned += s.scanned;
      t.produced += s.produced;
      t.inserted += s.inserted;
      t.skipped += s.skipped;
      t.durationMs += s.durationMs;
    }
  }

  /**
   * The scheduled pass for one company. A tick reads at most `rowBudget` rows
   * per source, so a company whose ledger was never filled (an install that
   * ran before ingest was on by default) would take one interval per budget
   * to reach today. Instead the pass keeps ticking while a source returned a
   * full budget, up to MAX_BACKFILL_PASSES ticks: the first scheduled pass
   * reads the history, and a history larger than the bound goes on at the
   * next interval from the cursor. Each tick is its own transaction under the
   * company lock, and the pass pauses `passYieldMs` between ticks outside it,
   * so other ledger writers, which try the lock once or retry briefly, get it
   * while a long history is read. A tick that fails ends the pass (the ticks
   * before it stay committed) and the caller backs the company off.
   */
  async function scheduledPass(companyId: string): Promise<ScheduledCompanyStats> {
    const total: ScheduledCompanyStats = {
      companyId,
      scanned: 0,
      inserted: 0,
      skipped: 0,
      durationMs: 0,
      maxLagMs: null,
      withdrawalChecked: false,
      perSource: {},
      passes: 0,
      maxTickMs: 0,
      caughtUp: false,
    };
    for (;;) {
      const stats = await tickOnce(companyId);
      addTick(total, stats);
      if (!moreWaiting(stats)) {
        total.caughtUp = true;
        break;
      }
      if (total.passes >= MAX_BACKFILL_PASSES) break;
      if (passYieldMs > 0) await pause(passYieldMs);
    }
    return total;
  }

  /** The wait after the n-th failure in a row: doubling from `failureBackoffMs`, capped at `failureBackoffMaxMs`. */
  function backoffDelayMs(failures: number): number {
    return Math.min(failureBackoffMaxMs, failureBackoffMs * 2 ** Math.min(Math.max(0, failures - 1), 30));
  }

  function recordFailure(companyId: string, err: unknown): void {
    const failures = (backoff.get(companyId)?.failures ?? 0) + 1;
    const delayMs = backoffDelayMs(failures);
    const until = now().getTime() + delayMs;
    // A query error wraps the database's own message (e.g. "canceling statement due to statement timeout") in `cause`.
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null;
    const error = (cause ?? (err instanceof Error ? err.message : String(err))).slice(0, 300);
    backoff.set(companyId, { failures, until, error });
    logger.warn(
      { err, companyId, failures, retryInMs: delayMs, retryAt: new Date(until).toISOString() },
      "evaluation_ingest: company pass failed; backing off",
    );
  }

  return {
    /** One ingest pass for one company. Serialised with every other pass on this company, on any instance. */
    async tick(companyId: string): Promise<CompanyTickStats> {
      if (inFlight) throw conflict("evaluation_ingest: a pass is already running");
      inFlight = true;
      try {
        return await tickOnce(companyId);
      } finally {
        inFlight = false;
      }
    },

    /**
     * The scheduled pass over every company (`scheduledPass`: catches up on
     * history, bounded). Errors are logged per company and never stop the
     * loop; a lock collision ends that company's pass, and its committed ticks
     * stay. A company whose pass failed is left alone until its backoff ends
     * (doubling, capped). Skips when a pass is in flight.
     */
    async tickAll(): Promise<ScheduledCompanyStats[]> {
      if (inFlight) {
        logger.warn({}, "evaluation_ingest: previous pass still running; skipping this tick");
        return [];
      }
      inFlight = true;
      try {
        const rows = await db.select({ id: companies.id }).from(companies);
        const out: ScheduledCompanyStats[] = [];
        for (const { id } of rows) {
          const waiting = backoff.get(id);
          if (waiting && now().getTime() < waiting.until) continue;
          try {
            out.push(await scheduledPass(id));
            backoff.delete(id);
          } catch (err) {
            if (err instanceof Error && /already running/.test(err.message)) {
              // Another writer holds the lock: not a failure, the next interval tries again.
              logger.warn({ companyId: id }, "evaluation_ingest: company locked by another pass; skipped");
            } else {
              recordFailure(id, err);
            }
          }
        }
        return out;
      } finally {
        inFlight = false;
      }
    },

    /** Backfill: tick until a pass scans nothing new, bounded, then report. A lock collision ends the loop and is reported, not thrown: committed passes stay counted. */
    async backfill(
      companyId: string,
      maxPasses = MAX_BACKFILL_PASSES,
    ): Promise<{ passes: number; inserted: number; scanned: number; exhausted: boolean; lockedOut: boolean }> {
      const bound = Math.max(1, Math.min(maxPasses, MAX_BACKFILL_PASSES));
      let passes = 0;
      let inserted = 0;
      let scanned = 0;
      let exhausted = false;
      let lockedOut = false;
      for (; passes < bound; ) {
        let stats: CompanyTickStats;
        try {
          stats = await this.tick(companyId);
        } catch (err) {
          if (err instanceof Error && /already running/.test(err.message)) {
            lockedOut = true;
            break;
          }
          throw err;
        }
        passes++;
        inserted += stats.inserted;
        scanned += stats.scanned;
        if (stats.scanned === 0) {
          exhausted = true;
          break;
        }
      }
      return { passes, inserted, scanned, exhausted, lockedOut };
    },

    async cursors(companyId: string) {
      return loadCursors(db, companyId);
    },

    /** A company the schedule is backing off after failed passes, or null. */
    backoffOf(companyId: string): { failures: number; until: Date; error: string } | null {
      const entry = backoff.get(companyId);
      return entry ? { failures: entry.failures, until: new Date(entry.until), error: entry.error } : null;
    },

    get running() {
      return inFlight;
    },
  };
}
