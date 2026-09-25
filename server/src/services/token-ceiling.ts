import { and, eq, gte, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { AGENT_DEFAULT_MAX_DAILY_TOKENS, type AgentTokenCeilingStatus } from "@paperclipai/shared";
import { parseObject } from "../adapters/utils.js";

/**
 * AgentDash (OBS-2 / GH #695): the per-agent daily token ceiling.
 *
 * Exists to stop the 09-15→09-21 incident shape: a resumed heartbeat session
 * spending ~10M input tokens a day on no-op timer wakes until the provider
 * quota was gone. The ceiling counts the OBS-1 `runFacts` record — input +
 * cached-input + output — over the UTC day (`heartbeat_runs.created_at` —
 * documented choice over instance timezone so the boundary is the same for
 * every deployment and every reader). Unmetered runs never count: a missing
 * measurement is unknown spend, not zero spend.
 */

/** The wakeup-request skip reason persisted when the ceiling refuses a wake. */
export const TOKEN_CEILING_SKIP_REASON = "token_ceiling";

/**
 * The skip reason persisted when the unmetered-run fallback guard refuses a
 * wake — spend that cannot be metered cannot be bounded, so a runaway of
 * unmetered unattended wakes pauses the agent the same way the ceiling does.
 */
export const UNMETERED_RUNAWAY_GUARD_REASON = "unmetered runaway guard";

/**
 * How many unmetered timer/comment runs in one UTC day trip the fallback
 * guard. Unmetered runs can never trip the token ceiling — their spend is
 * unknown, not zero — so the guard bounds the COUNT instead: 48 unattended
 * wakes is roughly one full day of a 30-minute heartbeat, which is also the
 * incident shape this whole feature exists to stop.
 */
export const UNMETERED_RUNAWAY_GUARD_LIMIT = 48;

/** The steward-inbox kind emitted once per agent per UTC day on first pause. */
export const TOKEN_CEILING_INBOX_KIND = "agent.token_ceiling";

export function tokenCeilingDedupeKey(agentId: string, dayKey: string): string {
  return `token_ceiling:${agentId}:${dayKey}`;
}

/**
 * The UTC calendar day containing `now`. The window, and the dedupe key the
 * inbox item hangs off, both come from this — one definition of "today".
 */
export function utcDayWindow(now: Date): { start: Date; liftsAt: Date; dayKey: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    start,
    liftsAt: new Date(start.getTime() + 24 * 60 * 60 * 1000),
    dayKey: start.toISOString().slice(0, 10),
  };
}

/**
 * `runtimeConfig.heartbeat.maxDailyTokens` → the ceiling actually enforced.
 *
 * - absent → `AGENT_DEFAULT_MAX_DAILY_TOKENS` (5M)
 * - `0` or `null` → off (returns `null`)
 * - positive finite number → that value (floored)
 * - anything else → the default: a typo must never disable a safety bound
 */
export function resolveMaxDailyTokens(runtimeConfig: unknown): {
  ceiling: number | null;
  isDefault: boolean;
} {
  const heartbeat = parseObject(parseObject(runtimeConfig).heartbeat);
  const raw = heartbeat.maxDailyTokens;
  if (raw === undefined) return { ceiling: AGENT_DEFAULT_MAX_DAILY_TOKENS, isDefault: true };
  if (raw === null) return { ceiling: null, isDefault: false };
  if (raw === 0) return { ceiling: null, isDefault: false };
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return { ceiling: Math.floor(raw), isDefault: false };
  }
  return { ceiling: AGENT_DEFAULT_MAX_DAILY_TOKENS, isDefault: true };
}

export interface AgentDailyTokenUsage {
  windowStart: Date;
  liftsAt: Date;
  dayKey: string;
  /** input + cached-input + output, metered runs only. */
  totalTokens: number;
  /** The share of `totalTokens` spent on runs whose outcome was `no_op`. */
  noOpTokens: number;
  meteredRuns: number;
  unmeteredRuns: number;
  /** Unmetered timer/comment runs — the runaway guard's input. */
  unmeteredPausableRuns: number;
}

export function tokenCeilingService(db: Db) {
  async function dailyUsage(
    companyId: string,
    agentId: string,
    now: Date,
  ): Promise<AgentDailyTokenUsage> {
    const window = utcDayWindow(now);
    const runFacts = sql`coalesce(${heartbeatRuns.resultJson} -> 'runFacts', '{}'::jsonb)`;
    const metered = sql`${runFacts} ->> 'meteringStatus' in ('metered', 'adapter_reported')`;
    const unmetered = sql`${runFacts} ->> 'meteringStatus' in ('unmetered_no_ledger', 'unmetered_no_session', 'unmetered_backfill_ambiguous')`;
    const tokens = sql`(
      coalesce((${runFacts} ->> 'inputTokens')::numeric, 0)
      + coalesce((${runFacts} ->> 'cachedInputTokens')::numeric, 0)
      + coalesce((${runFacts} ->> 'outputTokens')::numeric, 0)
    )`;

    const [row] = await db
      .select({
        totalTokens: sql<number>`coalesce(sum(${tokens}) filter (where ${metered}), 0)::bigint`,
        noOpTokens: sql<number>`coalesce(sum(${tokens}) filter (where ${metered} and ${runFacts} ->> 'outcome' = 'no_op'), 0)::bigint`,
        meteredRuns: sql<number>`count(*) filter (where ${metered})::int`,
        unmeteredRuns: sql<number>`count(*) filter (where ${unmetered})::int`,
        unmeteredPausableRuns: sql<number>`count(*) filter (where ${unmetered} and ${runFacts} ->> 'wakeReason' in ('timer', 'comment'))::int`,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          gte(heartbeatRuns.createdAt, window.start),
        ),
      );

    return {
      windowStart: window.start,
      liftsAt: window.liftsAt,
      dayKey: window.dayKey,
      totalTokens: Number(row?.totalTokens ?? 0),
      noOpTokens: Number(row?.noOpTokens ?? 0),
      meteredRuns: Number(row?.meteredRuns ?? 0),
      unmeteredRuns: Number(row?.unmeteredRuns ?? 0),
      unmeteredPausableRuns: Number(row?.unmeteredPausableRuns ?? 0),
    };
  }

  /**
   * Where the agent stands against its ceiling today. `paused` is a property
   * of the sum, not a stored flag — so it lifts by itself at the day boundary
   * and the moment a steward raises the ceiling. Two distinct pauses share it:
   * the metered total hitting the ceiling, and the unmetered runaway guard —
   * spend that cannot be metered cannot be bounded, so an unmetered flood of
   * unattended wakes pauses the agent too. `pauseReason` says which.
   */
  async function evaluate(
    agent: { id: string; companyId: string; runtimeConfig: unknown },
    now: Date = new Date(),
  ): Promise<AgentTokenCeilingStatus> {
    const { ceiling, isDefault } = resolveMaxDailyTokens(agent.runtimeConfig);
    const usage = await dailyUsage(agent.companyId, agent.id, now);
    const overCeiling = ceiling !== null && usage.totalTokens >= ceiling;
    const runaway = usage.unmeteredPausableRuns > UNMETERED_RUNAWAY_GUARD_LIMIT;
    return {
      ceiling,
      isDefault,
      tokensToday: usage.totalTokens,
      meteredRuns: usage.meteredRuns,
      unmeteredRuns: usage.unmeteredRuns,
      unmeteredPausableRuns: usage.unmeteredPausableRuns,
      paused: overCeiling || runaway,
      pauseReason: overCeiling
        ? TOKEN_CEILING_SKIP_REASON
        : runaway
          ? UNMETERED_RUNAWAY_GUARD_REASON
          : null,
      liftsAt: usage.liftsAt.toISOString(),
    };
  }

  return { dailyUsage, evaluate };
}

export type TokenCeilingService = ReturnType<typeof tokenCeilingService>;
