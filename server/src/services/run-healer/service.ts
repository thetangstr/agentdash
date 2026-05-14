/**
 * Run Healer Service — self-healing for agent runs.
 *
 * Proactively scans for adapter-related failures, diagnoses root causes using
 * an LLM, and applies bounded automatic fixes.
 *
 * Design: docs/superpowers/specs/2026-05-11-self-healing-run-fixer-design.md
 */

import { and, desc, eq, gte, inArray, isNull, isNotNull, lt, sql, count } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  heartbeatRuns,
  healAttempts,
  healEvents,
} from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { redactSensitiveText } from "../../redaction.js";
import { buildHealDiagnosisPrompt, parseHealDiagnosis, type HealDiagnosis, type DiagnosisCategory } from "./diagnosis.js";
import { executeHealFix, type HealFixResult } from "./fixer.js";
import { dispatchLLM } from "../dispatch-llm.js";

// ---------- config ----------

// Closes #237: previously these were module-level constants snapshotted
// from process.env at first import — meaning tests that set
// `process.env.RUN_HEALER_*` AFTER importing the module saw the old
// frozen value, and the exported `RunHealerConfig` type was dead code
// (never accepted as a parameter). Now we read env via a fresh function
// each time the service is constructed, and runHealerService accepts an
// optional config override for callers (tests, scheduled tasks) that
// want to inject directly.
function readEnvConfig(): Required<RunHealerConfig> {
  return {
    enabled: process.env.RUN_HEALER_ENABLED !== "false",
    scanIntervalMs: Number(process.env.RUN_HEALER_SCAN_INTERVAL_MS ?? 5 * 60 * 1000),
    maxHealsPerRun: Number(process.env.RUN_HEALER_MAX_HEALS_PER_RUN ?? 3),
    maxHealsPerDay: Number(process.env.RUN_HEALER_MAX_HEALS_PER_DAY ?? 100),
    maxCostPerDay: Number(process.env.RUN_HEALER_MAX_COST_PER_DAY ?? 5.0),
    minAgeMs: Number(process.env.RUN_HEALER_MIN_AGE_MS ?? 5 * 60 * 1000),
    lookbackMs: Number(process.env.RUN_HEALER_LOOKBACK_MS ?? 60 * 60 * 1000),
  };
}

// Runs in these statuses are eligible for healing
const HEAL_ELIGIBLE_STATUSES = ["failed", "running"] as const;
// Error codes that indicate adapter/auth issues
const AUTH_ERROR_PATTERNS = [
  /auth/i,
  /token/i,
  /key/i,
  /unauthorized/i,
  /forbidden/i,
  /invalid.*credential/i,
  /expired/i,
  /api.?key/i,
];
const RATE_LIMIT_ERROR_PATTERNS = [/rate.?limit/i, /too.?many.?request/i, /429/i, /throttle/i];
const TRANSIENT_PATTERNS = [
  /transient/i,
  /timeout/i,
  /connection/i,
  /network/i,
  /unreachable/i,
  /temporarily/i,
  /503/i,
  /502/i,
  /504/i,
];

// ---------- types ----------

export type RunHealerConfig = {
  enabled?: boolean;
  scanIntervalMs?: number;
  maxHealsPerRun?: number;
  maxHealsPerDay?: number;
  maxCostPerDay?: number;
  minAgeMs?: number;
  lookbackMs?: number;
};

type ScannedRun = {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  errorCode: string | null;
  error: string | null;
  createdAt: Date;
  adapterType: string;
  agentName: string;
  outputTail: string;
  healAttemptCount: number;
};

// ---------- service factory ----------

export function runHealerService(db: Db, configOverride: RunHealerConfig = {}) {
  // Closes #237: config now resolves at service-construction time (not
  // module-load), and partial overrides win over env defaults. Tests can
  // call `runHealerService(db, { scanIntervalMs: 100, maxCostPerDay: 0.01 })`
  // and get the values they asked for.
  const config: Required<RunHealerConfig> = { ...readEnvConfig(), ...configOverride };
  // In-flight healing promises — prevents concurrent scans from healing the same run.
  const inFlightHeals = new Map<string, Promise<{ fixed: boolean; action: string }>>();
  // ---------- helpers ----------

  async function getDailyHealCount(): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [{ count: c }] = await db
      .select({ count: count() })
      .from(healAttempts)
      .where(gte(healAttempts.createdAt, since));
    return c;
  }

  async function getDailyHealCost(): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // Closes #236: SUM over a numeric column returns a STRING from
    // node-postgres (pg's defensive default — numeric overflows JS
    // number). The `sql<number>` cast was a lie; downstream
    // `dailyCost >= config.maxCostPerDay` was string-vs-number that
    // worked by coincidence. Cast to float8 in SQL so pg returns a real
    // number, and Number() it on the JS side as belt-and-suspenders in
    // case a future Drizzle release ships nuance here.
    const [{ total }] = await db
      .select({ total: sql<number>`COALESCE(SUM(${healAttempts.costUsd}), 0)::float8` })
      .from(healAttempts)
      .where(and(gte(healAttempts.createdAt, since), isNotNull(healAttempts.costUsd)));
    return Number(total) || 0;
  }

  async function getRecentHealAttempts(runId: string) {
    return db
      .select()
      .from(healAttempts)
      .where(eq(healAttempts.runId, runId))
      .orderBy(desc(healAttempts.createdAt));
  }

  function matchesPattern(text: string | null, patterns: RegExp[]): boolean {
    if (!text) return false;
    return patterns.some((p) => p.test(text));
  }

  function isAuthFailure(errorCode: string | null, errorMessage: string | null): boolean {
    return (
      matchesPattern(errorCode, AUTH_ERROR_PATTERNS) ||
      matchesPattern(errorMessage, AUTH_ERROR_PATTERNS)
    );
  }

  function isRateLimitFailure(errorCode: string | null, errorMessage: string | null): boolean {
    return (
      matchesPattern(errorCode, RATE_LIMIT_ERROR_PATTERNS) ||
      matchesPattern(errorMessage, RATE_LIMIT_ERROR_PATTERNS)
    );
  }

  function isTransientFailure(errorCode: string | null, errorMessage: string | null): boolean {
    return (
      matchesPattern(errorCode, TRANSIENT_PATTERNS) ||
      matchesPattern(errorMessage, TRANSIENT_PATTERNS)
    );
  }

  // ---------- core logic ----------

  /**
   * Scan for runs that need healing. Returns runs eligible for diagnosis/fix.
   */
  async function scanEligibleRuns(): Promise<ScannedRun[]> {
    const cutoff = new Date(Date.now() - config.lookbackMs);
    const minAge = new Date(Date.now() - config.minAgeMs);

    // Find runs that:
    // 1. Are in failed or running status
    // 2. Created before minAge (give runs time to stabilize)
    // 3. Created within lookback window
    // 4. Haven't exceeded max heals per run
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        error: heartbeatRuns.error,
        createdAt: heartbeatRuns.createdAt,
        adapterType: agents.adapterType,
        agentName: agents.name,
        outputTail: heartbeatRuns.stderrExcerpt,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          // Closes #232: drizzle's typed `inArray` serializes to
          // `status IN ($1, $2, ...)` with positional bindings. The
          // previous `sql\`= ANY(\${tuple})\`` template-literal binding
          // silently matched zero rows when the tuple wasn't coerced to a
          // pg array correctly — turning the whole healer into a no-op
          // while the scan log still read "scan_complete count=0" as if
          // everything were fine.
          inArray(heartbeatRuns.status, [...HEAL_ELIGIBLE_STATUSES]),
          gte(heartbeatRuns.createdAt, cutoff),
          lt(heartbeatRuns.createdAt, minAge),
        ),
      );

    // Closes #235: previously this loop ran one `SELECT count(*) FROM
    // heal_attempts WHERE runId = ?` per candidate row — a textbook N+1.
    // With even modest failure rates each scan spent most of its budget
    // waiting on round-trips. Fold the per-run counts into ONE grouped
    // query keyed on the rows we already pulled.
    const candidateIds = rows.map((r) => r.id);
    const countRows = candidateIds.length === 0
      ? []
      : await db
          .select({
            runId: healAttempts.runId,
            count: sql<number>`count(*)::int`,
          })
          .from(healAttempts)
          .where(inArray(healAttempts.runId, candidateIds))
          .groupBy(healAttempts.runId);
    const healCountByRunId = new Map<string, number>(
      countRows.map((r) => [r.runId, Number(r.count) || 0]),
    );

    // Filter to runs with adapter-related failures and under heal limit
    const eligible: ScannedRun[] = [];
    for (const row of rows) {
      const errorCode = row.errorCode;
      const errorMessage = row.error;

      // Skip if no error at all (running but not failed = maybe stuck)
      if (!errorCode && !errorMessage && row.status !== "running") continue;

      // Classify the failure type
      const isAdapterRelated =
        isAuthFailure(errorCode, errorMessage) ||
        isRateLimitFailure(errorCode, errorMessage) ||
        isTransientFailure(errorCode, errorMessage) ||
        matchesPattern(errorCode, [/adapter_failed/i, /process/i]);

      if (!isAdapterRelated && row.status !== "running") continue;

      const healCount = healCountByRunId.get(row.id) ?? 0;

      if (healCount >= config.maxHealsPerRun) continue;

      eligible.push({
        id: row.id,
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        errorCode: row.errorCode,
        error: row.error,
        createdAt: row.createdAt,
        adapterType: row.adapterType ?? "unknown",
        agentName: row.agentName ?? "Unknown Agent",
        outputTail: (row.outputTail ?? "").slice(-4096), // Last 4KB
        healAttemptCount: healCount,
      });
    }

    return eligible;
  }

  /**
   * Log a heal event to the audit log.
   */
  async function logEvent(
    eventType: string,
    runId: string | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      await db.insert(healEvents).values({
        eventType,
        runId,
        details,
      });
    } catch (err) {
      logger.error({ eventType, runId, error: err }, "run_healer: failed to log event");
    }
  }

  /**
   * Diagnose a single run using the LLM.
   */
  async function diagnose(run: ScannedRun): Promise<HealDiagnosis | null> {
    const recentAttempts = await getRecentHealAttempts(run.id);
    const prompt = buildHealDiagnosisPrompt({
      runId: run.id,
      agentId: run.agentId,
      agentName: run.agentName,
      adapterType: run.adapterType,
      errorCode: run.errorCode,
      errorMessage: run.error ? redactSensitiveText(run.error) : null,
      status: run.status,
      outputTail: run.outputTail ? redactSensitiveText(run.outputTail) : "",
      recentHealAttempts: recentAttempts.map((a) => ({
        category: (a.diagnosis as HealDiagnosis).category as DiagnosisCategory,
        fixType: a.fixType,
        succeeded: a.succeeded,
      })),
    });

    try {
      // Closes #217: route diagnosis through dispatchLLM so the run healer
      // uses the user's configured adapter (AGENTDASH_DEFAULT_ADAPTER) rather
      // than hard-coding Anthropic. dispatchLLM falls back to the API stub
      // when no provider is configured, and the parser drops malformed JSON
      // to UNKNOWN below — both safe for the healer's bounded surface.
      const response = await dispatchLLM({
        system: "You are a run-healing assistant. Analyze the run context and respond with JSON only.",
        messages: [{ role: "user" as const, content: prompt }],
      });

      const diagnosis = parseHealDiagnosis(response);
      if (!diagnosis) {
        logger.warn(
          { runId: run.id, rawHead: response.slice(0, 200) },
          "run_healer: failed to parse LLM diagnosis response — skipping (no fix applied)",
        );
        return null;
      }
      return diagnosis;
    } catch (err) {
      logger.error({ runId: run.id, error: err }, "run_healer: diagnosis failed");
      return null;
    }
  }

  /**
   * Attempt to heal a single run.
   */
  async function healRun(run: ScannedRun): Promise<{ fixed: boolean; action: string }> {
    // Check daily limits
    const [dailyCount, dailyCost] = await Promise.all([getDailyHealCount(), getDailyHealCost()]);
    if (dailyCount >= config.maxHealsPerDay) {
      await logEvent("skipped", run.id, { reason: "daily_heal_limit_reached", count: dailyCount });
      return { fixed: false, action: "skipped_daily_limit" };
    }
    if (dailyCost >= config.maxCostPerDay) {
      await logEvent("skipped", run.id, { reason: "daily_cost_limit_reached", cost: dailyCost });
      return { fixed: false, action: "skipped_cost_limit" };
    }

    // Diagnose
    const diagnosis = await diagnose(run);
    if (!diagnosis) {
      await logEvent("skipped", run.id, { reason: "diagnosis_failed_or_low_confidence" });
      return { fixed: false, action: "skipped_no_diagnosis" };
    }

    if (diagnosis.confidence === "low") {
      await logEvent("skipped", run.id, {
        reason: "low_confidence",
        category: diagnosis.category,
        diagnosis: diagnosis.diagnosis,
      });
      return { fixed: false, action: "skipped_low_confidence" };
    }

    await logEvent("diagnose", run.id, {
      category: diagnosis.category,
      confidence: diagnosis.confidence,
      diagnosis: diagnosis.diagnosis,
      fixType: diagnosis.fixType,
      suggestedFix: diagnosis.suggestedFix,
    });

    // Apply fix
    let fixResult: HealFixResult;
    try {
      fixResult = await executeHealFix(db, run, diagnosis);
    } catch (err) {
      logger.error({ runId: run.id, error: err }, "run_healer: fix execution failed");
      fixResult = { succeeded: false, actionTaken: "exception", costUsd: 0 };
    }

    // Record heal attempt
    try {
      await db.insert(healAttempts).values({
        runId: run.id,
        diagnosis,
        fixType: diagnosis.fixType,
        actionTaken: fixResult.actionTaken,
        succeeded: fixResult.succeeded,
        costUsd: fixResult.costUsd,
      });
    } catch (err) {
      logger.error({ runId: run.id, error: err }, "run_healer: failed to record heal attempt");
    }

    await logEvent(fixResult.succeeded ? "fix_applied" : "fix_failed", run.id, {
      fixType: diagnosis.fixType,
      actionTaken: fixResult.actionTaken,
      succeeded: fixResult.succeeded,
    });

    return { fixed: fixResult.succeeded, action: fixResult.actionTaken };
  }

  // ---------- public API ----------

  /**
   * Run a full scan cycle — finds eligible runs, diagnoses them, applies fixes.
   * Called by the routine scheduler on the configured interval.
   */
  async function scan(): Promise<{ scanned: number; fixed: number; skipped: number }> {
    if (!config.enabled) {
      return { scanned: 0, fixed: 0, skipped: 0 };
    }

    logger.info({}, "run_healer: starting scan");
    await logEvent("scan_start", null, { timestamp: new Date().toISOString() });

    const eligible = await scanEligibleRuns();
    let fixed = 0;
    let skipped = 0;

    for (const run of eligible) {
      // Skip if already healing this run in a concurrent scan cycle
      if (inFlightHeals.has(run.id)) {
        await logEvent("skipped", run.id, { reason: "concurrent_heal_in_progress" });
        skipped++;
        continue;
      }

      const healPromise = healRun(run);
      inFlightHeals.set(run.id, healPromise);
      const result = await healPromise;
      inFlightHeals.delete(run.id);
      if (result.fixed) fixed++;
      else skipped++;
    }

    await logEvent("scan_complete", null, {
      timestamp: new Date().toISOString(),
      eligibleCount: eligible.length,
      fixed,
      skipped,
    });

    logger.info({ scanned: eligible.length, fixed, skipped }, "run_healer: scan complete");
    return { scanned: eligible.length, fixed, skipped };
  }

  return { scan };
}
