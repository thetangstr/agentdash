// AgentDash (SC-7, GH #768): rate limits for the public API.
//   dbLimiter      durable sliding-window counts in rate_events: the §5.1
//                  limits (signups per IP, find and resend per email) that
//                  must hold across restarts and replicas;
//   MemoryLimiter  cheap per-process windows for high-frequency, low-stakes
//                  calls (the live slug check, verify attempts).
import { and, eq, gte, sql } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { rateEvents } from "../db/schema.js";

export interface LimitRule {
  bucket: string;
  limit: number;
  windowMs: number;
}

export const LIMITS = {
  signupPerIp: { bucket: "signup_ip", limit: 3, windowMs: 3_600_000 },
  signupPerEmail: { bucket: "signup_email", limit: 5, windowMs: 3_600_000 },
  findPerIp: { bucket: "find_ip", limit: 5, windowMs: 3_600_000 },
  findPerEmail: { bucket: "find_email", limit: 3, windowMs: 3_600_000 },
  resendPerIp: { bucket: "resend_ip", limit: 10, windowMs: 3_600_000 },
  resendPerEmail: { bucket: "resend_email", limit: 3, windowMs: 3_600_000 },
} satisfies Record<string, LimitRule>;

/**
 * Count, then record, one hit. Returns false (and records nothing) when the
 * key is already at its limit inside the window. An advisory lock per
 * bucket and key makes the check and the insert atomic.
 */
export async function takeHit(db: CloudDb, rule: LimitRule, key: string, now: Date = new Date()): Promise<boolean> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${rule.bucket}:${key}`}))`);
    const since = new Date(now.getTime() - rule.windowMs);
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(rateEvents)
      .where(and(eq(rateEvents.bucket, rule.bucket), eq(rateEvents.key, key), gte(rateEvents.createdAt, since)));
    if ((row?.n ?? 0) >= rule.limit) return false;
    await tx.insert(rateEvents).values({ bucket: rule.bucket, key, createdAt: now });
    return true;
  });
}

/** Fixed-window counter in memory, bounded so a scan from many addresses cannot grow it. */
export class MemoryLimiter {
  readonly #hits = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 20_000,
  ) {}

  take(key: string): boolean {
    const t = this.now();
    const e = this.#hits.get(key);
    if (!e || t - e.start >= this.windowMs) {
      this.#hits.delete(key);
      this.#hits.set(key, { start: t, count: 1 });
      while (this.#hits.size > this.maxEntries) this.#hits.delete(this.#hits.keys().next().value as string);
      return true;
    }
    if (e.count >= this.limit) return false;
    e.count += 1;
    return true;
  }
}

/** The longest window any limit counts over; prune_rate_events never deletes younger rows. */
export const LONGEST_WINDOW_MS = Math.max(...Object.values(LIMITS).map((l) => l.windowMs), 3_600_000);

/**
 * Delete rate_events rows older than the longest window (GH #836 review),
 * through the SECURITY DEFINER function (the runtime role has no DELETE).
 */
export async function pruneRateEvents(db: CloudDb): Promise<number> {
  const rows = (await db.execute(sql`select prune_rate_events(${Math.ceil(LONGEST_WINDOW_MS / 1000)}) as n`)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
