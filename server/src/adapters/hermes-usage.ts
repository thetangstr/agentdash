import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AdapterExecutionResult, UsageSummary } from "@paperclipai/adapter-utils";

/**
 * Token metering for `hermes_local`.
 *
 * Everything downstream already meters: an adapter returns `usage`, the
 * heartbeat writes `heartbeat_runs.usage_json`, and /costs/by-agent aggregates
 * input, cached and output tokens by agent, model, provider and biller.
 * codex_local fills that in. hermes_local did not, so the one agent MKThink
 * runs reported nothing while its costs page read zero against real spend.
 *
 * Two earlier readings of this were wrong, and both are worth recording so
 * nobody spends the evening rediscovering them:
 *
 *   1. The adapter package scrapes totals out of stdout with a regex. Hermes
 *      0.20 prints no such line — a whole successful run whose log never says
 *      the word "token".
 *   2. Hermes has `--usage-file PATH`, which looks like the answer and is not:
 *      it is documented "One-shot mode only … No effect outside -z/--oneshot",
 *      and this adapter runs the `chat` subcommand. Passed there, Hermes exits
 *      with `unrecognized arguments: --usage-file`. Measured in production.
 *
 * What Hermes does keep, for every run and without being asked, is its own
 * ledger: `session_model_usage` in `~/.hermes/state.db`, one row per model per
 * task, carrying api_call_count, input/output/cache/reasoning tokens and both
 * estimated and actual cost. That is the number, from the process that spent
 * it, recorded whether or not anyone thought to ask for it.
 */

/** The subset of Hermes' ledger this adapter trusts. */
export interface HermesSessionUsage {
  /** Cumulative session totals — see `applyHermesSessionUsage`. */
  usage: UsageSummary;
  model: string | null;
  provider: string | null;
  /** Only set when Hermes itself recorded a non-zero cost. */
  costUsd: number | null;
  apiCalls: number;
  /** Cumulative `sessions.tool_call_count`, when the ledger recorded it. */
  toolCalls: number | null;
}

export type HermesMeteringStatus =
  | "metered"
  | "unmetered_no_ledger"
  | "unmetered_no_session";

/**
 * The result of trying to read the ledger, with the failure mode kept. A run
 * whose metering failed must be able to say *why* — "unmetered" is a fact about
 * the record, not a zero.
 */
export interface HermesSessionUsageRead {
  usage: HermesSessionUsage | null;
  status: HermesMeteringStatus;
  /** Which candidate file answered (or was tried last), for diagnostics. */
  dbPath: string | null;
}

/** One `session_model_usage` row, as far as this module cares. */
export interface HermesUsageRow {
  model?: unknown;
  billing_provider?: unknown;
  api_call_count?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
  estimated_cost_usd?: unknown;
  actual_cost_usd?: unknown;
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Where Hermes keeps its state, oldest assumption first.
 *
 * Managed profiles (`hermes -p <name>`) write to their own database at
 * `<profilesDir>/<name>/state.db` — `HERMES_PROFILES_DIR` resolved exactly like
 * `hermes-profile.ts` does — while unmanaged runs write to the Hermes home.
 * The earlier version of this function only ever returned the home path, so
 * profiled agents metered against a stale database and every run read as zero.
 * The override exists for an operator who has moved the unmanaged database.
 */
export function resolveHermesStateDbCandidates(
  env: NodeJS.ProcessEnv = process.env,
  opts: { profile?: string | null } = {},
): string[] {
  const candidates: string[] = [];
  const profile = readString(opts.profile);
  const defaultHermesHome = path.join(os.homedir(), ".hermes");
  const profilesDir =
    readString(env.HERMES_PROFILES_DIR) ?? path.join(defaultHermesHome, "profiles");
  if (profile) {
    candidates.push(path.join(profilesDir, profile, "state.db"));
  }
  const explicit = readString(env.AGENTDASH_HERMES_STATE_DB);
  if (explicit) candidates.push(path.resolve(explicit));
  const hermesHome = readString(env.HERMES_HOME);
  if (hermesHome) candidates.push(path.resolve(hermesHome, "state.db"));
  candidates.push(path.join(defaultHermesHome, "state.db"));
  return [...new Set(candidates)];
}

export function resolveHermesStateDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveHermesStateDbCandidates(env)[0]!;
}

/**
 * Sum a session's rows into one usage summary.
 *
 * Hermes writes a row per model per task, so a session that summarised itself
 * with a second model has several. Summing is what a bill does; the model and
 * provider reported are the ones that did the most work, because a single
 * label has to stand for the run and the summariser is not the story.
 *
 * A cost of zero is dropped rather than reported. On the MKThink Mini every
 * MiniMax row carries `estimated_cost_usd 0.0` and `actual_cost_usd 0.0` —
 * Hermes has the token counts and not the price list. Writing that zero into a
 * cost event would put "$0.00 spent" on a board that is spending money, which
 * is a false statement rather than a gap. Tokens land either way.
 */
export function summarizeHermesUsageRows(rows: readonly HermesUsageRow[]): HermesSessionUsage | null {
  if (rows.length === 0) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let apiCalls = 0;
  let costUsd = 0;
  let dominant: { model: string | null; provider: string | null; tokens: number } | null = null;

  for (const row of rows) {
    const rowInput = readNumber(row.input_tokens);
    const rowOutput = readNumber(row.output_tokens);
    inputTokens += rowInput;
    outputTokens += rowOutput;
    cachedInputTokens += readNumber(row.cache_read_tokens);
    apiCalls += readNumber(row.api_call_count);
    costUsd += readNumber(row.actual_cost_usd) || readNumber(row.estimated_cost_usd);

    const rowTokens = rowInput + rowOutput;
    if (!dominant || rowTokens > dominant.tokens) {
      dominant = {
        model: readString(row.model),
        provider: readString(row.billing_provider),
        tokens: rowTokens,
      };
    }
  }

  if (inputTokens === 0 && outputTokens === 0) return null;

  return {
    usage: {
      inputTokens,
      outputTokens,
      ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    },
    model: dominant?.model ?? null,
    provider: dominant?.provider ?? null,
    costUsd: costUsd > 0 ? costUsd : null,
    apiCalls,
    toolCalls: null,
  };
}

/**
 * Read one session's usage out of Hermes' state database, trying each
 * candidate file in order (managed profile first, then the home database).
 *
 * Read-only, and every failure is recorded rather than thrown: metering is a
 * by-product of the run, and a database that is missing, locked, or newer than
 * this query must never turn a completed run into a failed one — but the run
 * record must say `unmetered_*` instead of silently reading as zero.
 */
export function readHermesSessionUsageDetailed(
  sessionId: string | null | undefined,
  opts: { dbPath?: string; profile?: string | null; env?: NodeJS.ProcessEnv } = {},
): HermesSessionUsageRead {
  const session = readString(sessionId);
  if (!session) {
    return { usage: null, status: "unmetered_no_session", dbPath: null };
  }
  const candidates = opts.dbPath
    ? [opts.dbPath]
    : resolveHermesStateDbCandidates(opts.env, { profile: opts.profile });

  let sawReadableDb = false;
  let lastTried: string | null = null;
  for (const dbPath of candidates) {
    lastTried = dbPath;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      sawReadableDb = true;
      const rows = db
        .prepare(
          `SELECT model, billing_provider, api_call_count, input_tokens, output_tokens,
                  cache_read_tokens, estimated_cost_usd, actual_cost_usd
             FROM session_model_usage
            WHERE session_id = ?`,
        )
        .all(session) as HermesUsageRow[];
      const usage = summarizeHermesUsageRows(rows);
      if (usage) {
        usage.toolCalls = readHermesSessionToolCalls(db, session);
        return { usage, status: "metered", dbPath };
      }
      // A readable database without this session keeps looking — a run can be
      // misattributed to a profile it never used, and the home database may
      // still hold it.
    } catch {
      // Unreadable candidate — try the next one.
    } finally {
      try {
        db?.close();
      } catch {
        // Nothing useful to do with a close failure on a read-only handle.
      }
    }
  }
  return {
    usage: null,
    status: sawReadableDb ? "unmetered_no_session" : "unmetered_no_ledger",
    dbPath: lastTried,
  };
}

/** `sessions.tool_call_count` — cumulative for the session, null when absent. */
function readHermesSessionToolCalls(db: DatabaseSync, sessionId: string): number | null {
  try {
    const row = db
      .prepare(`SELECT tool_call_count FROM sessions WHERE id = ?`)
      .get(sessionId) as { tool_call_count?: unknown } | undefined;
    const count = row?.tool_call_count;
    return typeof count === "number" && Number.isFinite(count) && count >= 0
      ? Math.floor(count)
      : null;
  } catch {
    // Older ledgers may lack the table or column — tools stay unrecorded.
    return null;
  }
}

export function readHermesSessionUsage(
  sessionId: string | null | undefined,
  opts: { dbPath?: string; profile?: string | null; env?: NodeJS.ProcessEnv } = {},
): HermesSessionUsage | null {
  return readHermesSessionUsageDetailed(sessionId, opts).usage;
}

/** Find the Hermes session a result belongs to, wherever the adapter put it. */
export function readHermesSessionId(result: AdapterExecutionResult): string | null {
  const sessionParams =
    result.sessionParams && typeof result.sessionParams === "object" && !Array.isArray(result.sessionParams)
      ? (result.sessionParams as Record<string, unknown>)
      : null;
  const resultJson =
    result.resultJson && typeof result.resultJson === "object" && !Array.isArray(result.resultJson)
      ? (result.resultJson as Record<string, unknown>)
      : null;

  return (
    readString(result.sessionId)
    ?? readString(sessionParams?.sessionId)
    ?? readString(resultJson?.session_id)
    ?? readString(result.sessionDisplayId)
  );
}

/**
 * Fold the ledger into the adapter's result.
 *
 * The totals are CUMULATIVE for the session, which is the shape the platform
 * already expects from a resuming adapter: `deriveNormalizedUsageDelta` in the
 * heartbeat subtracts the previous run's raw totals for the same session, so a
 * ten-run session bills ten deltas rather than ten copies of the total.
 *
 * Nothing the adapter already established is overwritten: it knows which
 * profile ran and which model label a human configured, and the ledger merely
 * repeating those must not clobber them.
 */
/**
 * Values the adapter emits when it does not know.
 *
 * `provider: "auto"` means "Hermes picked one", which buckets real spend under
 * a non-answer in /costs/by-provider. The ledger records which provider was
 * actually billed, so a placeholder must not outrank it — while a genuine
 * label a human configured still wins.
 */
const PLACEHOLDER_LABELS = new Set(["auto", "unknown", "default", "none"]);

function isInformative(value: unknown): value is string {
  const label = readString(value);
  return label !== null && !PLACEHOLDER_LABELS.has(label.toLowerCase());
}

export function applyHermesSessionUsage(
  result: AdapterExecutionResult,
  usage: HermesSessionUsage | null,
): AdapterExecutionResult {
  if (!usage) return result;
  // AGE-142 (S3): the recovery budget reads turns from resultJson.num_turns
  // (task-recovery-budget.ts), but nothing in this repo ever wrote it, so the
  // turns dimension sat silently at zero and could never exhaust. The ledger's
  // per-model API call counts are that number, from the process that spent
  // them. Cumulative-session caveat, recorded where the write happens: hermes
  // totals are per session, so on a resumed session this reports the
  // session-so-far figure rather than a per-run delta — an overcount that can
  // only bias the budget toward stopping sooner, never toward overspending.
  // A natively reported count the adapter already established is not clobbered.
  const existingResultJson =
    result.resultJson && typeof result.resultJson === "object" && !Array.isArray(result.resultJson)
      ? result.resultJson
      : {};
  const existingTurns = readNumber(
    existingResultJson.num_turns ?? existingResultJson.numTurns,
  );
  const existingToolCalls = readNumber(existingResultJson.num_tool_calls);
  const mergedResultJson = {
    ...existingResultJson,
    ...(existingTurns > 0 || usage.apiCalls <= 0 ? {} : { num_turns: usage.apiCalls }),
    ...(existingToolCalls > 0 || usage.toolCalls == null
      ? {}
      : { num_tool_calls: usage.toolCalls }),
  };
  return {
    ...result,
    ...(Object.keys(mergedResultJson).length > Object.keys(existingResultJson).length
      ? { resultJson: mergedResultJson }
      : {}),
    usage: result.usage ?? usage.usage,
    ...(isInformative(result.model) ? {} : usage.model ? { model: usage.model } : {}),
    ...(isInformative(result.provider) ? {} : usage.provider ? { provider: usage.provider } : {}),
    ...(result.costUsd === undefined || result.costUsd === null
      ? usage.costUsd !== null
        ? { costUsd: usage.costUsd }
        : {}
      : {}),
  };
}
