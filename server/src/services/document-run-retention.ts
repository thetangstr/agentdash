// AgentDash (per-steward document access, slice 6b): retention for the stored
// run output of agents in document-enabled companies.
//
// A document-enabled agent's transcript can quote its steward's files even
// after the read tools' own framing is stripped (the agent may paraphrase).
// So for every company with `document_access_enabled` on, run events and run
// log files older than the window are deleted. The run row itself stays
// (status, timing, cost) but loses every free-text column — error, result,
// excerpts, progress lines, and all of its context snapshot except the
// routing ids. Its log pointer is cleared, so the log route answers an empty
// `missing` log instead of a 404 for a file that is gone.
//
// Modelled on plugin-log-retention.ts: batched deletes, an iteration cap, and
// a start function that sweeps once at startup and then on an interval.
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNotNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { featureFlags, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { runLogBasePath } from "./run-log-store.js";

/** Default retention window, in days. */
export const DEFAULT_DOCUMENT_RUN_RETENTION_DAYS = 30;

/** Env override for the window (whole days, at least 1). */
export const DOCUMENT_RUN_RETENTION_DAYS_ENV = "AGENTDASH_DOCUMENT_RUN_RETENTION_DAYS";

/** Rows (or log files) handled per batch, to keep each statement short. */
const BATCH_SIZE = 1_000;

/** Batches per company per sweep; the next sweep continues where this stopped. */
const MAX_ITERATIONS = 100;

/** Statuses of a run that may still be writing its log. */
const ACTIVE_RUN_STATUSES = ["queued", "running"];

/**
 * The context-snapshot keys a purged run keeps: ids and enums that link it to
 * its issue and wake, never text (a snapshot can carry a session handoff the
 * agent wrote).
 */
const RETAINED_CONTEXT_KEYS = [
  "issueId",
  "taskId",
  "taskKey",
  "commentId",
  "wakeCommentId",
  "wakeReason",
  "wakeSource",
  "wakeTriggerDetail",
  "executionWorkspaceId",
] as const;

function retainedContextSql() {
  const pairs = RETAINED_CONTEXT_KEYS.map((key) => sql`${key}::text, ${heartbeatRuns.contextSnapshot} -> ${key}::text`);
  return sql`case when ${heartbeatRuns.contextSnapshot} is null then null
    else jsonb_strip_nulls(jsonb_build_object(${sql.join(pairs, sql`, `)})) end`;
}

export function documentRunRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DOCUMENT_RUN_RETENTION_DAYS_ENV];
  const parsed = raw !== undefined && /^\d+$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : NaN;
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_DOCUMENT_RUN_RETENTION_DAYS;
}

export type DocumentRunPruneResult = {
  companies: number;
  eventsDeleted: number;
  logFilesDeleted: number;
  /** Runs whose log pointer and free text were cleared. */
  runsCleared: number;
};

function logFilePath(basePath: string, logRef: string): string | null {
  const base = path.resolve(basePath);
  const resolved = path.resolve(base, logRef);
  return resolved.startsWith(base + path.sep) ? resolved : null;
}

/**
 * Delete run events and run-log files older than `retentionDays` for every
 * company with the document-access flag on. Companies without the flag are
 * never touched.
 */
export async function pruneDocumentRunData(
  db: Db,
  opts: { retentionDays?: number; now?: Date; basePath?: string } = {},
): Promise<DocumentRunPruneResult> {
  const retentionDays = opts.retentionDays ?? documentRunRetentionDays();
  const cutoff = new Date((opts.now ?? new Date()).getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const basePath = opts.basePath ?? runLogBasePath();

  const flagged = await db
    .select({ companyId: featureFlags.companyId })
    .from(featureFlags)
    .where(and(eq(featureFlags.flagKey, FEATURE_FLAG_KEYS.DOCUMENT_ACCESS), eq(featureFlags.enabled, true)));

  const result: DocumentRunPruneResult = { companies: flagged.length, eventsDeleted: 0, logFilesDeleted: 0, runsCleared: 0 };

  for (const { companyId } of flagged) {
    // Run events: batched by id so no single delete holds locks for long.
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const ids = await db
        .select({ id: heartbeatRunEvents.id })
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, companyId), lt(heartbeatRunEvents.createdAt, cutoff)))
        .limit(BATCH_SIZE)
        .then((rows) => rows.map((row) => row.id));
      if (ids.length === 0) break;
      const deleted = await db
        .delete(heartbeatRunEvents)
        .where(inArray(heartbeatRunEvents.id, ids))
        .returning({ id: heartbeatRunEvents.id });
      result.eventsDeleted += deleted.length;
      if (ids.length < BATCH_SIZE) break;
    }

    // Run-log files and free text of finished runs that ended before the
    // cutoff. A run is selected while anything is left to purge, so the
    // update below takes it out of the next batch.
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const runs = await db
        .select({ id: heartbeatRuns.id, logStore: heartbeatRuns.logStore, logRef: heartbeatRuns.logRef })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            or(
              isNotNull(heartbeatRuns.logRef),
              isNotNull(heartbeatRuns.error),
              isNotNull(heartbeatRuns.resultJson),
              isNotNull(heartbeatRuns.stdoutExcerpt),
              isNotNull(heartbeatRuns.stderrExcerpt),
              isNotNull(heartbeatRuns.nextAction),
              isNotNull(heartbeatRuns.livenessReason),
              sql`${heartbeatRuns.contextSnapshot} is distinct from ${retainedContextSql()}`,
            ),
            notInArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
            sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) < ${cutoff.toISOString()}::timestamptz`,
          ),
        )
        .limit(BATCH_SIZE);
      if (runs.length === 0) break;
      const cleared: string[] = [];
      for (const run of runs) {
        if (run.logStore === "local_file" && run.logRef) {
          const file = logFilePath(basePath, run.logRef);
          if (!file) {
            // A ref that escapes the log directory is never followed; clear it.
            logger.warn({ runId: run.id }, "document run retention: log ref outside the run-log directory");
          } else {
            try {
              await fs.rm(file, { force: true });
              result.logFilesDeleted += 1;
            } catch (err) {
              // Keep the pointer so the next sweep retries this file.
              logger.warn({ err, runId: run.id }, "document run retention: could not delete run log");
              continue;
            }
          }
        }
        cleared.push(run.id);
      }
      if (cleared.length > 0) {
        await db
          .update(heartbeatRuns)
          .set({
            logStore: null,
            logRef: null,
            error: null,
            resultJson: null,
            stdoutExcerpt: null,
            stderrExcerpt: null,
            nextAction: null,
            livenessReason: null,
            contextSnapshot: retainedContextSql(),
            updatedAt: new Date(),
          })
          .where(inArray(heartbeatRuns.id, cleared));
        result.runsCleared += cleared.length;
      }
      if (runs.length < BATCH_SIZE || cleared.length === 0) break;
    }
  }

  if (result.eventsDeleted > 0 || result.logFilesDeleted > 0 || result.runsCleared > 0) {
    logger.info({ ...result, retentionDays }, "Pruned expired run output for document-enabled companies");
  }
  return result;
}

/**
 * Sweep once now, then every `intervalMs` (default: hourly). Returns a stop
 * function. The timer is unref'd so it never holds the process open.
 */
export function startDocumentRunRetention(
  db: Db,
  intervalMs: number = 60 * 60 * 1_000,
  retentionDays: number = documentRunRetentionDays(),
): () => void {
  const sweep = (label: string) => {
    pruneDocumentRunData(db, { retentionDays }).catch((err) => {
      logger.warn({ err }, `${label} document run retention sweep failed`);
    });
  };
  const timer = setInterval(() => sweep("Scheduled"), intervalMs);
  timer.unref?.();
  sweep("Initial");
  return () => clearInterval(timer);
}
