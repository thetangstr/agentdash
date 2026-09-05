import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, evaluationIngestState } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { evaluationLedger, type EvaluationEventInput } from "./ledger.js";
import { detectWithdrawnComments, SOURCE_READERS, type Cursor, type SourceName } from "./sources.js";

/**
 * AgentDash: Company Evaluator — the ingest loop (spec §11).
 *
 * Reads each source after its cursor, under its own transaction with a
 * statement timeout, appends the resulting events (idempotent by dedupe key)
 * and advances the cursor. Runs on its own interval, never on the request path
 * and never on the heartbeat scheduler tick. Backfill is the same tick run to
 * exhaustion once.
 */

export interface IngestOptions {
  /** Rows read per source per tick. */
  rowBudget?: number;
  /** Postgres statement_timeout for source reads. */
  statementTimeoutMs?: number;
  /** Only these sources (tests). */
  sources?: SourceName[];
  now?: () => Date;
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
  perSource: Record<string, SourceTickStats>;
}

const DEFAULT_ROW_BUDGET = 5000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

export function evaluationIngest(db: Db, opts: IngestOptions = {}) {
  const ledger = evaluationLedger(db);
  const rowBudget = opts.rowBudget ?? DEFAULT_ROW_BUDGET;
  const statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const sources = opts.sources ?? (Object.keys(SOURCE_READERS) as SourceName[]);
  const now = opts.now ?? (() => new Date());

  async function loadCursors(companyId: string): Promise<Record<string, Cursor>> {
    const rows = await db.select().from(evaluationIngestState).where(eq(evaluationIngestState.companyId, companyId));
    return Object.fromEntries(rows.map((r) => [r.source, (r.cursor ?? {}) as Cursor]));
  }

  async function saveCursor(companyId: string, source: string, cursor: Cursor): Promise<void> {
    await db
      .insert(evaluationIngestState)
      .values({ companyId, source, cursor: cursor as Record<string, unknown>, updatedAt: now() })
      .onConflictDoUpdate({
        target: [evaluationIngestState.companyId, evaluationIngestState.source],
        set: { cursor: cursor as Record<string, unknown>, updatedAt: now() },
      });
  }

  async function readSource(companyId: string, source: SourceName, cursor: Cursor) {
    return db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${Math.floor(statementTimeoutMs)}ms'`));
      return SOURCE_READERS[source](tx, companyId, cursor, rowBudget);
    });
  }

  return {
    /** One ingest pass for one company. */
    async tick(companyId: string): Promise<CompanyTickStats> {
      const started = Date.now();
      const cursors = await loadCursors(companyId);
      const perSource: Record<string, SourceTickStats> = {};
      let scanned = 0;
      let inserted = 0;
      let skipped = 0;
      for (const source of sources) {
        const t0 = Date.now();
        const result = await readSource(companyId, source, cursors[source] ?? {});
        let events: EvaluationEventInput[] = result.events;
        if (source === "issue_comments") {
          // Rule 13: withdrawal detection rides on the comments pass.
          const known = await ledger.knownSourceIds(companyId, "issue_comments");
          const withdrawn = await db.transaction(async (tx) => {
            await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${Math.floor(statementTimeoutMs)}ms'`));
            return detectWithdrawnComments(tx, companyId, known, now());
          });
          events = events.concat(withdrawn);
        }
        const appended = await ledger.append(events);
        if (result.scanned > 0) await saveCursor(companyId, source, result.nextCursor);
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
      return { companyId, scanned, inserted, skipped, durationMs: Date.now() - started, perSource };
    },

    /** One pass over every company; errors are logged per company and never stop the loop. */
    async tickAll(): Promise<CompanyTickStats[]> {
      const rows = await db.select({ id: companies.id }).from(companies);
      const out: CompanyTickStats[] = [];
      for (const { id } of rows) {
        try {
          out.push(await this.tick(id));
        } catch (err) {
          logger.error({ err, companyId: id }, "evaluation_ingest: company tick failed");
        }
      }
      return out;
    },

    /** Backfill: tick until a pass scans nothing new (bounded), then report. */
    async backfill(companyId: string, maxPasses = 200): Promise<{ passes: number; inserted: number; scanned: number }> {
      let passes = 0;
      let inserted = 0;
      let scanned = 0;
      for (; passes < maxPasses; passes++) {
        const stats = await this.tick(companyId);
        inserted += stats.inserted;
        scanned += stats.scanned;
        if (stats.scanned === 0) break;
      }
      return { passes, inserted, scanned };
    },

    async cursors(companyId: string) {
      return loadCursors(companyId);
    },
  };
}
