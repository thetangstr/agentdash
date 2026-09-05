import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, evaluationIngestState } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { evaluationLedger, type LedgerDb } from "./ledger.js";
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
 */

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

const DEFAULT_ROW_BUDGET = 5000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_WITHDRAWAL_CHECK_INTERVAL_MS = 60 * 60 * 1000;
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
  let inFlight = false;

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
      const perSource: Record<string, SourceTickStats> = {};
      let scanned = 0;
      let inserted = 0;
      let skipped = 0;
      let maxLagMs: number | null = null;
      let withdrawalChecked = false;
      for (const source of sources) {
        const t0 = Date.now();
        const result = await SOURCE_READERS[source](tx, companyId, cursors[source] ?? {}, rowBudget);
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
        const appended = await ledger.append(events);
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

    /** One pass over every company; errors are logged per company and never stop the loop. Skips when a pass is in flight. */
    async tickAll(): Promise<CompanyTickStats[]> {
      if (inFlight) {
        logger.warn({}, "evaluation_ingest: previous pass still running; skipping this tick");
        return [];
      }
      inFlight = true;
      try {
        const rows = await db.select({ id: companies.id }).from(companies);
        const out: CompanyTickStats[] = [];
        for (const { id } of rows) {
          try {
            out.push(await tickOnce(id));
          } catch (err) {
            if (err instanceof Error && /already running/.test(err.message)) {
              logger.warn({ companyId: id }, "evaluation_ingest: company locked by another pass; skipped");
            } else {
              logger.error({ err, companyId: id }, "evaluation_ingest: company tick failed");
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

    get running() {
      return inFlight;
    },
  };
}
