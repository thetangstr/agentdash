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
 *   - hermes ledger rows are CUMULATIVE per session, so a session's total is
 *     attributed to its first run in the window and later runs of the same
 *     session meter a delta of what remains — summed across runs the numbers
 *     reconcile with `session_model_usage` exactly;
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
 *   --force              recompute runs that already have runFacts
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, asc, desc, eq, gte, lt, isNotNull } from "drizzle-orm";
import { createDb, agents, heartbeatRuns } from "@paperclipai/db";
import { loadConfig } from "../src/config.js";
import {
  readHermesSessionUsageDetailed,
  type HermesMeteringStatus,
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

/** Raw cumulative totals recorded in usage_json (raw* fields preferred). */
function rawTotals(usageJson: unknown): TokenTotals | null {
  const u = asObject(usageJson);
  const input = nonNegInt(u.rawInputTokens ?? u.inputTokens);
  const cached = nonNegInt(u.rawCachedInputTokens ?? u.cachedInputTokens) ?? 0;
  const output = nonNegInt(u.rawOutputTokens ?? u.outputTokens);
  if (input === null && output === null) return null;
  if ((input ?? 0) === 0 && output === 0 && cached === 0) return null;
  return { inputTokens: input ?? 0, cachedInputTokens: cached, outputTokens: output ?? 0 };
}

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

function usageDelta(current: TokenTotals, previous: TokenTotals | null): TokenTotals {
  if (!previous) return { ...current };
  return {
    inputTokens: current.inputTokens >= previous.inputTokens ? current.inputTokens - previous.inputTokens : current.inputTokens,
    cachedInputTokens:
      current.cachedInputTokens >= previous.cachedInputTokens
        ? current.cachedInputTokens - previous.cachedInputTokens
        : current.cachedInputTokens,
    outputTokens: current.outputTokens >= previous.outputTokens ? current.outputTokens - previous.outputTokens : current.outputTokens,
  };
}

/**
 * The managed profile an agent's runs used — the same derivation as the live
 * path (`hermesRunProfile` in adapters/registry.ts), plus the deterministic
 * `agentdash-<agentId>` name as a second candidate for agents whose command was
 * later re-pointed at bare `hermes`.
 */
function hermesProfilesFor(agent: { id: string; adapterConfig: unknown }): (string | null)[] {
  const cfg = asObject(agent.adapterConfig);
  const command = typeof cfg.hermesCommand === "string" ? cfg.hermesCommand.trim() : "";
  const profilesDir =
    process.env.HERMES_PROFILES_DIR?.trim() || path.join(os.homedir(), ".hermes", "profiles");
  const out: (string | null)[] = [];
  const flagMatch = command.match(/(?:^|\s)(?:-p|--profile)[=\s]+([^\s]+)/);
  if (flagMatch?.[1]) out.push(flagMatch[1]);
  const base = command ? path.basename(command.split(/\s+/)[0] ?? "") : "";
  if (base && base !== "hermes" && existsSync(path.join(profilesDir, base))) out.push(base);
  const deterministic = agentProfileName(agent.id);
  if (!out.includes(deterministic) && existsSync(path.join(profilesDir, deterministic))) {
    out.push(deterministic);
  }
  out.push(null); // unmanaged/home database last
  return out;
}

type LedgerRead = {
  totals: TokenTotals | null;
  status: HermesMeteringStatus;
  model: string | null;
  provider: string | null;
  apiCalls: number | null;
  toolCalls: number | null;
};

/** Read a session's ledger totals, trying each profile candidate in order. */
function readLedgerForSession(
  sessionId: string,
  profiles: (string | null)[],
): LedgerRead {
  let sawNoSession = false;
  for (const profile of profiles) {
    const read = readHermesSessionUsageDetailed(sessionId, { profile });
    if (read.status === "metered" && read.usage) {
      return {
        totals: {
          inputTokens: read.usage.usage.inputTokens,
          cachedInputTokens: read.usage.usage.cachedInputTokens ?? 0,
          outputTokens: read.usage.usage.outputTokens,
        },
        status: "metered",
        model: read.usage.model,
        provider: read.usage.provider,
        apiCalls: read.usage.apiCalls,
        toolCalls: read.usage.toolCalls,
      };
    }
    if (read.status === "unmetered_no_session") sawNoSession = true;
  }
  return {
    totals: null,
    status: sawNoSession ? "unmetered_no_session" : "unmetered_no_ledger",
    model: null,
    provider: null,
    apiCalls: null,
    toolCalls: null,
  };
}

/** Latest pre-window run in the same session carrying raw totals — the delta baseline. */
async function preWindowBaseline(agentId: string, sessionId: string): Promise<TokenTotals | null> {
  const rows = await db
    .select({ usageJson: heartbeatRuns.usageJson })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agentId),
        eq(heartbeatRuns.sessionIdAfter, sessionId),
        lt(heartbeatRuns.createdAt, since),
        isNotNull(heartbeatRuns.usageJson),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(50);
  for (const row of rows) {
    const totals = rawTotals(row.usageJson);
    if (totals) return totals;
  }
  return null;
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
const ledgerCache = new Map<string, LedgerRead>();
const preWindowCache = new Map<string, TokenTotals | null>();
let updated = 0;
let skipped = 0;
let examined = 0;

const agentRows = await db
  .select({
    id: agents.id,
    companyId: agents.companyId,
    adapterType: agents.adapterType,
    adapterConfig: agents.adapterConfig,
    runtimeConfig: agents.runtimeConfig,
  })
  .from(agents)
  .where(flags.agent ? eq(agents.id, flags.agent) : undefined);

for (const agent of agentRows) {
  const isHermes = agent.adapterType === "hermes_local";
  const profiles = isHermes ? hermesProfilesFor(agent) : [];
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

  // Cumulative counters already attributed to earlier in-window runs of a
  // session, so the session's ledger total is spread first-run-then-delta.
  const sessionSeenTotals = new Map<string, TokenTotals>();
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
    let cumulativeTurns = nonNegInt(resultJson.num_turns ?? resultJson.numTurns);
    let cumulativeToolCalls = nonNegInt(resultJson.num_tool_calls);

    if (isHermes) {
      const sessionId = run.sessionIdAfter;
      if (!sessionId) {
        meteringStatus = "unmetered_no_session";
        tokens = null;
      } else {
        const cacheKey = `${agent.id}:${sessionId}`;
        let ledger = ledgerCache.get(cacheKey);
        if (!ledger) {
          ledger = readLedgerForSession(sessionId, profiles);
          ledgerCache.set(cacheKey, ledger);
        }
        meteringStatus = ledger.status;
        if (ledger.totals) {
          let previous = sessionSeenTotals.get(sessionId) ?? null;
          if (!previous && !preWindowCache.has(cacheKey)) {
            preWindowCache.set(cacheKey, await preWindowBaseline(agent.id, sessionId));
          }
          previous = previous ?? preWindowCache.get(cacheKey) ?? null;
          tokens = usageDelta(ledger.totals, previous);
          sessionSeenTotals.set(sessionId, ledger.totals);
          // The ledger saw which model/provider actually served the session —
          // pre-OBS-1 usage_json rows rarely recorded either.
          servedModel = ledger.model;
          servedProvider = ledger.provider;
          cumulativeTurns = ledger.apiCalls ?? cumulativeTurns;
          cumulativeToolCalls = ledger.toolCalls ?? cumulativeToolCalls;
        } else {
          tokens = null;
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
    }

    // Counter deltas: hermes counters are always cumulative per session; other
    // adapters only when the run's own usage_json says the totals were
    // session-cumulative (`usageSource: "session_delta"`).
    const sessionKey = run.sessionIdAfter ? `${agent.id}:${run.sessionIdAfter}` : null;
    let turns = cumulativeTurns;
    let toolCalls = cumulativeToolCalls;
    if (sessionKey && (isHermes || asObject(run.usageJson).usageSource === "session_delta")) {
      const seen = sessionSeenCounters.get(sessionKey);
      turns = counterDelta(cumulativeTurns, seen?.turns ?? null);
      toolCalls = counterDelta(cumulativeToolCalls, seen?.toolCalls ?? null);
      sessionSeenCounters.set(sessionKey, { turns: cumulativeTurns, toolCalls: cumulativeToolCalls });
    }

    const runFacts = buildRunFacts({
      meteringStatus,
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
