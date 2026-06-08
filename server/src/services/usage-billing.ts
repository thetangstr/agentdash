// AgentDash (Cloud SKU, G4): usage-based billing.
//
// Aggregates a company's metered inference from cost_events over a billing
// period and computes the billable amount = COGS × markup. A token-price floor
// covers cheap/sub-cent calls where the provider-reported costCents rounded to
// 0 (see dispatch-llm metering, G3). Optionally reports usage to Stripe's
// Billing Meters API when a meter is configured; otherwise no-ops (mirrors the
// rest of billing, which stubs when Stripe is unset).

import { and, eq, gte, lte, sql } from "drizzle-orm";
import { type Db, costEvents } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export interface UsagePricing {
  /** Multiplier applied to COGS to produce the billable amount (e.g. 1.5 = 50% margin). */
  markup: number;
  /** Fallback price per 1M input tokens, in cents (used when provider COGS is 0). */
  inputCentsPerMTok: number;
  /** Fallback price per 1M output tokens, in cents. */
  outputCentsPerMTok: number;
}

export function usagePricingFromEnv(): UsagePricing {
  const markup = Number(process.env.AGENTDASH_USAGE_MARKUP);
  return {
    markup: Number.isFinite(markup) && markup > 0 ? markup : 1.5,
    inputCentsPerMTok: Number(process.env.AGENTDASH_USAGE_INPUT_CENTS_PER_MTOK) || 0,
    outputCentsPerMTok: Number(process.env.AGENTDASH_USAGE_OUTPUT_CENTS_PER_MTOK) || 0,
  };
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported cost of goods sold for the period, in cents. */
  cogsCents: number;
}

export interface UsageBill extends UsageTotals {
  companyId: string;
  markup: number;
  /** What to charge the customer for the period, in cents. */
  billableCents: number;
}

/**
 * Billable cents = max(provider COGS, token-priced COGS) × markup, rounded up.
 *
 * The token-priced basis is a floor: for cheap calls the provider's per-event
 * costCents rounds to 0, so token pricing prevents undercharging. Whichever
 * basis is larger wins. When no token prices are configured (both 0) the
 * provider COGS is used directly.
 */
export function computeBillableCents(totals: UsageTotals, pricing: UsagePricing): number {
  const tokenCogsCents =
    (totals.inputTokens / 1_000_000) * pricing.inputCentsPerMTok +
    (totals.outputTokens / 1_000_000) * pricing.outputCentsPerMTok;
  const cogs = Math.max(totals.cogsCents, tokenCogsCents);
  return Math.ceil(cogs * pricing.markup);
}

/**
 * Best-effort Stripe usage report via the Billing Meters API. Returns true if
 * the event was sent. No-ops (returns false) when Stripe or a meter name is not
 * configured, or on any error — usage billing must never break the request.
 */
export async function reportUsageToStripe(
  stripe: unknown,
  opts: { customerId: string; meterEventName: string; value: number },
): Promise<boolean> {
  const meterEvents = (stripe as { billing?: { meterEvents?: { create?: Function } } })?.billing
    ?.meterEvents;
  if (!meterEvents?.create || !opts.meterEventName || !opts.customerId) return false;
  try {
    await meterEvents.create({
      event_name: opts.meterEventName,
      payload: {
        stripe_customer_id: opts.customerId,
        value: String(Math.max(0, Math.round(opts.value))),
      },
    });
    return true;
  } catch (err) {
    logger.warn({ err }, "[usage-billing] stripe meter report failed (non-fatal)");
    return false;
  }
}

export interface UsagePeriod {
  from?: Date;
  to?: Date;
}

export function usageBillingService(db: Db) {
  async function periodUsage(companyId: string, range?: UsagePeriod): Promise<UsageTotals> {
    const conditions = [eq(costEvents.companyId, companyId)];
    if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
    if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

    const [row] = await db
      .select({
        inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
        cogsCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
      })
      .from(costEvents)
      .where(and(...conditions));

    return {
      inputTokens: Number(row?.inputTokens ?? 0),
      outputTokens: Number(row?.outputTokens ?? 0),
      cogsCents: Number(row?.cogsCents ?? 0),
    };
  }

  return {
    periodUsage,

    currentBill: async (companyId: string, range?: UsagePeriod): Promise<UsageBill> => {
      const totals = await periodUsage(companyId, range);
      const pricing = usagePricingFromEnv();
      return {
        companyId,
        ...totals,
        markup: pricing.markup,
        billableCents: computeBillableCents(totals, pricing),
      };
    },
  };
}
