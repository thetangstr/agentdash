/**
 * OBS-1 (#694): backfill `runFacts` + `meteringStatus` onto historical
 * heartbeat_runs for the last 30 days.
 *
 * Why it exists: pre-OBS-1 runs either recorded no usage at all (hermes_local
 * metered a stale root DB while managed profiles wrote their own ledgers) or
 * recorded adapter-native fields with no normalized shape. This script fills
 * the normalized record for the window the dashboard actually reads, without
 * touching anything else: it writes ONLY `result_json.runFacts` and
 * `usage_json.meteringStatus`.
 *
 * Honesty rules, same as the live path:
 *   - a run whose ledger/session produced no usage is `unmetered_*`, with
 *     null token fields — never zero;
 *   - hermes `session_model_usage` rows are CUMULATIVE over their own
 *     lifetime, so a row is attributed to a run only when its
 *     `[first_seen, last_seen]` span sits inside that run's
 *     `[startedAt, finishedAt]` window. A session with exactly one run is
 *     whole-session attributable. A token-carrying row that straddles a run
 *     boundary — or carries no timestamps at all — cannot be split honestly,
 *     so the run is marked `unmetered_backfill_ambiguous` rather than
 *     guessing a share;
 *   - runs that already carry `runFacts` are skipped, so the script is safe
 *     to re-run (`--force` recomputes).
 *
 * Usage:
 *   set -a && . ~/.config/agentdash/mkboard.env && set +a
 *   pnpm exec tsx scripts/backfill-run-facts.ts --dry-run
 *   pnpm exec tsx scripts/backfill-run-facts.ts
 *
 * Options:
 *   --dry-run            print per-day totals, write nothing
 *   --days N             window length (default 30)
 *   --since ISO-8601     explicit window start (overrides --days)
 *   --agent ID           one agent only
 *   --company ID         one company only
 *   --force              recompute runs that already have runFacts
 */

import { and, asc, eq, gte, count } from "drizzle-orm";
import { createDb, agents, heartbeatRuns } from "@paperclipai/db";
import { loadConfig } from "../src/config.js";
import {
  readHermesSessionUsageRowsDetailed,
  type HermesSessionRowsRead,
  type HermesSessionUsageRowDetail,
} from "../src/adapters/hermes-usage.js";
import {
  buildRunFacts,
  livenessStateToOutcome,
  normalizeWakeReason,
} from "../src/services/run-facts.js";
import { agentProfileName } from "../src/services/hermes-profile.js";
import type { RunMeteringStatus } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// args

const argv = process.argv.slice(2);
const flags = {
  dryRun: argv.includes("--dry-run"),
  force: argv.includes("--force"),
  agent: argValue("--agent"),
  company: argValue("--company"),
  since: argValue("--since"),
  days: Number(argValue("--days") ?? "30"),
};

function argValue(name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1 || idx + 1 >= argv.length) return null;
  return argv[idx + 1] ?? null;
}

const since = flags.since
  ? new Date(flags.since)
  : new Date(Date.now() - flags.days * 24 * 60 * 60 * 1000);
if (Number.isNaN(since.getTime())) {
  console.error(`invalid --since: ${flags.since}`);
  process.exit(64);
}

const config = loadConfig();
const db = createDb(config.databaseUrl);

// ---------------------------------------------------------------------------
// helpers

type RunRow = {
  id: string;
  agentId: string;
  companyId: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  status: string;
  livenessState: string | null;
  invocationSource: string;
  triggerDetail: string | null;
  contextSnapshot: unknown;
  sessionIdAfter: string | null;
  usageJson: unknown;
  resultJson: unknown;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonNegInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function counterDelta(current: number | null, baseline: number | null): number | null {
  if (current === null) return null;
  if (baseline === null) return current;
  return current >= baseline ? current - baseline : current;
}

type TokenTotals = { inputTokens: number; cachedInputTokens: number; outputTokens: number };

/** The normalized per-run delta recorded in usage_json (non-raw fields). */
function deltaTotals(usageJson: unknown): TokenTotals | null {
  const u = asObject(usageJson);
  const input = nonNegInt(u.inputTokens);
  const output = nonNegInt(u.outputTokens);
  const cached = nonNegInt(u.cachedInputTokens) ?? 0;
  if (input === null && output === null) return null;
  if ((input ?? 0) === 0 && output === 0 && cached === 0) return null;
  return { inputTokens: input ?? 0, cachedInputTokens: cached, outputTokens: output ?? 0 };
}

/**
 * Slack applied to a run's `[startedAt, finishedAt]` window before a ledger
 * row is judged contained or straddling: ledger timestamps are unix seconds
 * written by the adapter process, run timestamps are millisecond-precision
 * server times, and the last ledger write can lag the process exit.
 */
const ROW_ATTRIBUTION_SLACK_MS = 60_000;

function rowHasTokens(row: HermesSessionUsageRowDetail): boolean {
  return row.inputTokens > 0 || row.outputTokens > 0 || row.cachedInputTokens > 0;
}

/**
 * A session's rows, resolved the same way the live path resolves them —
 * command/args/env/wrapper/active-profile through
 * `resolveHermesStateDbResolutions` — plus the deterministic managed profile
 * `agentdash-<agentId>` as a last candidate for agents whose command was
 * later re-pointed at bare `hermes`.
 */
function readSessionLedgerRows(
  sessionId: string,
  agentId: string,
  adapterConfig: Record<string, unknown> | null,
): HermesSessionRowsRead {
  const primary = readHermesSessionUsageRowsDetailed(sessionId, { adapterConfig });
  if (primary.status === "metered") return primary;
  const hinted = readHermesSessionUsageRowsDetailed(sessionId, {
    adapterConfig,
    profile: agentProfileName(agentId),
  });
  // Keep whichever read got further: metered > saw-a-ledger > nothing.
  if (hinted.status === "metered") return hinted;
  if (primary.status === "unmetered_no_ledger" && hinted.status === "unmetered_no_session") {
    return hinted;
  }
  return primary;
}

/** How many runs ever shared this session for this agent (all time). */
async function sessionRunCount(agentId: string, sessionId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.sessionIdAfter, sessionId)));
  return Number(row?.n ?? 0);
}

type SessionAttribution = {
  /** Per-run keyed by run id — present only for runs this function decided. */
  byRun: Map<string, RunAttribution>;
};

type RunAttribution =
  | { kind: "metered"; tokens: TokenTotals; apiCalls: number; model: string | null; provider: string | null }
  | { kind: "ambiguous" }
  | { kind: "empty" };

/**
 * Split a session's ledger rows across the runs that shared it.
 *
 * Single-run session: every row is that run's, timestamps or not.
 * Multi-run session: a row is a run's only when its recorded span sits inside
 * the run's window; a token-carrying row that straddles a boundary, or has no
 * timestamps, makes the whole session's per-run attribution unknowable —
 * every in-window run is marked ambiguous rather than handed a guessed share.
 * Each row is attributed at most once, so overlapping run windows can never
 * double-count.
 */
function attributeSessionRows(
  rows: HermesSessionUsageRowDetail[],
  sessionRuns: RunRow[],
  singleRunSession: boolean,
): SessionAttribution {
  const byRun = new Map<string, RunAttribution>();
  if (singleRunSession) {
    const run = sessionRuns[0];
    if (run) {
      byRun.set(run.id, {
        kind: "metered",
        tokens: {
          inputTokens: rows.reduce((n, r) => n + r.inputTokens, 0),
          cachedInputTokens: rows.reduce((n, r) => n + r.cachedInputTokens, 0),
          outputTokens: rows.reduce((n, r) => n + r.outputTokens, 0),
        },
        apiCalls: rows.reduce((n, r) => n + r.apiCalls, 0),
        model: dominantRow(rows)?.model ?? null,
        provider: dominantRow(rows)?.provider ?? null,
      });
    }
    return { byRun };
  }

  // An untimed token row cannot be placed in any run's window, so no run's
  // share of this session is provable.
  if (rows.some((row) => rowHasTokens(row) && (!row.firstSeenAt || !row.lastSeenAt))) {
    for (const run of sessionRuns) byRun.set(run.id, { kind: "ambiguous" });
    return { byRun };
  }

  const consumed = new Set<number>();
  for (const run of sessionRuns) {
    const start = (run.startedAt ?? run.createdAt).getTime() - ROW_ATTRIBUTION_SLACK_MS;
    const end = (run.finishedAt ?? new Date()).getTime() + ROW_ATTRIBUTION_SLACK_MS;
    const contained: number[] = [];
    let ambiguous = false;
    rows.forEach((row, index) => {
      const first = row.firstSeenAt!.getTime();
      const last = row.lastSeenAt!.getTime();
      if (last < start || first > end) return; // clearly another run's work
      if (first >= start && last <= end) {
        if (!consumed.has(index)) contained.push(index);
        return;
      }
      // Straddles a boundary — the row's tokens cannot be split honestly.
      if (rowHasTokens(row)) ambiguous = true;
    });
    if (ambiguous) {
      byRun.set(run.id, { kind: "ambiguous" });
      continue;
    }
    contained.forEach((index) => consumed.add(index));
    const containedRows = contained.map((index) => rows[index]!);
    byRun.set(
      run.id,
      containedRows.length === 0
        ? { kind: "empty" }
        : {
            kind: "metered",
            tokens: {
              inputTokens: containedRows.reduce((n, r) => n + r.inputTokens, 0),
              cachedInputTokens: containedRows.reduce((n, r) => n + r.cachedInputTokens, 0),
              outputTokens: containedRows.reduce((n, r) => n + r.outputTokens, 0),
            },
            apiCalls: containedRows.reduce((n, r) => n + r.apiCalls, 0),
            model: dominantRow(containedRows)?.model ?? null,
            provider: dominantRow(containedRows)?.provider ?? null,
          },
    );
  }
  return { byRun };
}

function dominantRow(rows: readonly HermesSessionUsageRowDetail[]) {
  let best: HermesSessionUsageRowDetail | null = null;
  for (const row of rows) {
    if (!best || row.inputTokens + row.outputTokens > best.inputTokens + best.outputTokens) {
      best = row;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// main

type DayBucket = {
  runs: number;
  metered: number;
  unmetered: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

const perDay = new Map<string, DayBucket>();
const sessionRowsCache = new Map<string, HermesSessionRowsRead>();
const sessionRunCountCache = new Map<string, number>();
let updated = 0;
let skipped = 0;
let examined = 0;

const agentWhere = flags.agent
  ? eq(agents.id, flags.agent)
  : flags.company
    ? eq(agents.companyId, flags.company)
    : undefined;

const agentRows = await db
  .select({
    id: agents.id,
    companyId: agents.companyId,
    adapterType: agents.adapterType,
    adapterConfig: agents.adapterConfig,
    runtimeConfig: agents.runtimeConfig,
  })
  .from(agents)
  .where(agentWhere);

for (const agent of agentRows) {
  const isHermes = agent.adapterType === "hermes_local";
  const configuredModel =
    typeof asObject(agent.adapterConfig).model === "string"
      ? (asObject(agent.adapterConfig).model as string)
      : null;

  const runs = (await db
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      companyId: heartbeatRuns.companyId,
      createdAt: heartbeatRuns.createdAt,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      status: heartbeatRuns.status,
      livenessState: heartbeatRuns.livenessState,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      sessionIdAfter: heartbeatRuns.sessionIdAfter,
      usageJson: heartbeatRuns.usageJson,
      resultJson: heartbeatRuns.resultJson,
    })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agent.id), gte(heartbeatRuns.createdAt, since)))
    .orderBy(asc(heartbeatRuns.createdAt))) as RunRow[];

  // The runs that share a session, in order — attribution needs the whole
  // session cohort, including runs that already carry runFacts (skipping them
  // must not re-attribute their rows to a later run).
  const sessionCohorts = new Map<string, RunRow[]>();
  for (const run of runs) {
    if (!run.sessionIdAfter) continue;
    const cohort = sessionCohorts.get(run.sessionIdAfter) ?? [];
    cohort.push(run);
    sessionCohorts.set(run.sessionIdAfter, cohort);
  }
  const sessionAttributions = new Map<string, SessionAttribution>();
  if (isHermes) {
    for (const [sessionId, cohort] of sessionCohorts) {
      const cacheKey = `${agent.id}:${sessionId}`;
      let read = sessionRowsCache.get(cacheKey);
      if (!read) {
        read = readSessionLedgerRows(sessionId, agent.id, asObject(agent.adapterConfig));
        sessionRowsCache.set(cacheKey, read);
      }
      let totalRuns = sessionRunCountCache.get(cacheKey);
      if (totalRuns === undefined) {
        totalRuns = await sessionRunCount(agent.id, sessionId);
        sessionRunCountCache.set(cacheKey, totalRuns);
      }
      if (read.status !== "metered") continue;
      // A session whose only run ever is this one is whole-session
      // attributable; anything else goes through per-row windows.
      sessionAttributions.set(sessionId, attributeSessionRows(read.rows, cohort, totalRuns === 1));
    }
  }

  // Cumulative counter deltas for non-hermes adapters whose usage_json says
  // the totals were session-cumulative (`usageSource: "session_delta"`).
  const sessionSeenCounters = new Map<string, { turns: number | null; toolCalls: number | null }>();

  for (const run of runs) {
    examined += 1;
    const resultJson = asObject(run.resultJson);
    if (!flags.force && resultJson.runFacts && typeof resultJson.runFacts === "object") {
      skipped += 1;
      continue;
    }

    let meteringStatus: RunMeteringStatus;
    let tokens: TokenTotals | null;
    let servedModel: string | null = null;
    let servedProvider: string | null = null;
    let ledgerSource: string | null = null;
    let ledgerCertainty: "certain" | "uncertain" | null = null;
    let cumulativeTurns = nonNegInt(resultJson.num_turns ?? resultJson.numTurns);
    let cumulativeToolCalls = nonNegInt(resultJson.num_tool_calls);
    let turns: number | null = cumulativeTurns;
    let toolCalls: number | null = cumulativeToolCalls;

    if (isHermes) {
      const sessionId = run.sessionIdAfter;
      if (!sessionId) {
        meteringStatus = "unmetered_no_session";
        tokens = null;
        turns = null;
        toolCalls = null;
      } else {
        const cacheKey = `${agent.id}:${sessionId}`;
        const read = sessionRowsCache.get(cacheKey)!;
        const totalRuns = sessionRunCountCache.get(cacheKey) ?? 0;
        ledgerSource = read.ledger?.source ?? null;
        ledgerCertainty = read.ledger?.certainty ?? null;
        // The run's own `num_turns`/`num_tool_calls` are cumulative for the
        // session — they equal this run's share only when no other run ever
        // used the session.
        turns = totalRuns === 1 ? cumulativeTurns : null;
        toolCalls = totalRuns === 1 ? cumulativeToolCalls : null;
        if (read.status !== "metered") {
          meteringStatus = read.status;
          tokens = null;
        } else {
          const attribution = sessionAttributions.get(sessionId)?.byRun.get(run.id);
          if (!attribution || attribution.kind === "empty") {
            // The session exists but no ledger row lands in this run's window —
            // it provably consumed nothing.
            meteringStatus = "metered";
            tokens = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
            turns = 0;
            toolCalls = null;
          } else if (attribution.kind === "ambiguous") {
            meteringStatus = "unmetered_backfill_ambiguous";
            tokens = null;
            turns = null;
            toolCalls = null;
          } else {
            meteringStatus = "metered";
            tokens = attribution.tokens;
            turns = attribution.apiCalls;
            servedModel = attribution.model;
            servedProvider = attribution.provider;
            // sessions.tool_call_count is cumulative for the whole session —
            // attributable only when this run is the session's only run.
            toolCalls = totalRuns === 1 ? read.sessionToolCalls : null;
          }
        }
      }
      // Whatever the run recorded about itself still applies for labels.
      const uj = asObject(run.usageJson);
      servedModel = servedModel ?? (typeof uj.model === "string" ? uj.model : null);
      servedProvider = servedProvider ?? (typeof uj.provider === "string" ? uj.provider : null);
    } else {
      const deltas = deltaTotals(run.usageJson);
      tokens = deltas;
      meteringStatus = deltas ? "adapter_reported" : "unmetered_no_session";
      const uj = asObject(run.usageJson);
      servedModel = typeof uj.model === "string" ? uj.model : null;
      servedProvider = typeof uj.provider === "string" ? uj.provider : null;

      const sessionKey = run.sessionIdAfter ? `${agent.id}:${run.sessionIdAfter}` : null;
      if (sessionKey && asObject(run.usageJson).usageSource === "session_delta") {
        const seen = sessionSeenCounters.get(sessionKey);
        turns = counterDelta(cumulativeTurns, seen?.turns ?? null);
        toolCalls = counterDelta(cumulativeToolCalls, seen?.toolCalls ?? null);
        sessionSeenCounters.set(sessionKey, {
          turns: cumulativeTurns,
          toolCalls: cumulativeToolCalls,
        });
      }
    }

    const runFacts = buildRunFacts({
      meteringStatus,
      ledgerSource,
      ledgerCertainty,
      servedModel,
      servedProvider,
      configuredModel,
      inputTokens: tokens?.inputTokens ?? null,
      cachedInputTokens: tokens?.cachedInputTokens ?? null,
      outputTokens: tokens?.outputTokens ?? null,
      turns,
      toolCalls,
      startedAt: run.startedAt ?? run.createdAt,
      finishedAt: run.finishedAt,
      firstOutputAt: null,
      outcome: livenessStateToOutcome(run.livenessState, run.status),
      wakeReason: normalizeWakeReason({
        invocationSource: run.invocationSource,
        triggerDetail: run.triggerDetail,
        contextSnapshot: asObject(run.contextSnapshot),
      }),
    });

    const day = run.createdAt.toISOString().slice(0, 10);
    const bucket = perDay.get(day) ?? {
      runs: 0,
      metered: 0,
      unmetered: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    bucket.runs += 1;
    if (meteringStatus === "metered" || meteringStatus === "adapter_reported") {
      bucket.metered += 1;
      bucket.inputTokens += tokens?.inputTokens ?? 0;
      bucket.cachedInputTokens += tokens?.cachedInputTokens ?? 0;
      bucket.outputTokens += tokens?.outputTokens ?? 0;
    } else {
      bucket.unmetered += 1;
    }
    perDay.set(day, bucket);

    if (!flags.dryRun) {
      await db
        .update(heartbeatRuns)
        .set({
          resultJson: { ...resultJson, runFacts },
          usageJson: { ...asObject(run.usageJson), meteringStatus },
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
      updated += 1;
    }
  }
}

const days = [...perDay.entries()].sort(([a], [b]) => a.localeCompare(b));
console.log(
  `${flags.dryRun ? "[dry-run] " : ""}window since ${since.toISOString()} — ${examined} runs examined, ${skipped} already had runFacts, ${flags.dryRun ? 0 : updated} updated`,
);
console.log("\nper-day totals (metered runs only; unmetered counted separately):");
console.log("date        runs  metered  unmetered   input   cached  output");
let totals = { runs: 0, metered: 0, unmetered: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
for (const [day, b] of days) {
  totals.runs += b.runs;
  totals.metered += b.metered;
  totals.unmetered += b.unmetered;
  totals.inputTokens += b.inputTokens;
  totals.cachedInputTokens += b.cachedInputTokens;
  totals.outputTokens += b.outputTokens;
  console.log(
    `${day}  ${String(b.runs).padStart(4)}  ${String(b.metered).padStart(7)}  ${String(b.unmetered).padStart(9)}  ${String(b.inputTokens).padStart(7)}  ${String(b.cachedInputTokens).padStart(7)}  ${String(b.outputTokens).padStart(7)}`,
  );
}
console.log(
  `TOTAL       ${String(totals.runs).padStart(4)}  ${String(totals.metered).padStart(7)}  ${String(totals.unmetered).padStart(9)}  ${String(totals.inputTokens).padStart(7)}  ${String(totals.cachedInputTokens).padStart(7)}  ${String(totals.outputTokens).padStart(7)}`,
);

process.exit(0);
