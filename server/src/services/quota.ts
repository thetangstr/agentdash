// AgentDash (AGE-120): Agent-run quota computation service.
// Given a workspace (company), compute included runs, used runs, and overage
// based on the company's plan tier and seat count.

import { and, count, eq, gte, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentRuns, companies } from "@paperclipai/db";
import {
  QUOTA_FREE_INCLUDED_RUNS,
  QUOTA_PRO_BASE_INCLUDED_RUNS,
  QUOTA_PRO_PER_SEAT_RUNS,
} from "@paperclipai/shared";
import { isProLivePlanTier } from "./tier-policy.js";

export interface QuotaSnapshot {
  tier: string;
  includedRuns: number;
  usedRuns: number;
  remainingRuns: number;
  overageRuns: number;
  seatsCount: number;
  billingPeriodStart: string; // ISO date
  billingPeriodEnd: string;   // ISO date
}

/**
 * Compute the billing-month window for a company.
 *
 * For Pro companies with a `planPeriodEnd`, the billing month is the 30-day
 * (approx) window ending at `planPeriodEnd`. For Free companies (or when
 * planPeriodEnd is null), we use calendar-month UTC.
 */
function billingWindow(planPeriodEnd: Date | null, now = new Date()) {
  if (planPeriodEnd && planPeriodEnd.getTime() > 0) {
    // Work backward from periodEnd to find the current window.
    // Stripe periods are typically monthly. We compute the start as
    // one month before the period end.
    const end = planPeriodEnd;
    const start = new Date(end);
    start.setUTCMonth(start.getUTCMonth() - 1);
    // If we're past the period end (stale data), fall back to calendar month.
    if (now >= end) {
      return calendarMonthWindow(now);
    }
    return { start, end };
  }
  return calendarMonthWindow(now);
}

function calendarMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

/**
 * Compute the included-run allotment for a given tier and seat count.
 */
export function computeIncludedRuns(
  planTier: string,
  seatsPaid: number,
): number {
  if (isProLivePlanTier(planTier)) {
    return QUOTA_PRO_BASE_INCLUDED_RUNS + seatsPaid * QUOTA_PRO_PER_SEAT_RUNS;
  }
  // team tier could be added later with a configurable pool
  return QUOTA_FREE_INCLUDED_RUNS;
}

export function quotaService(db: Db) {
  return {
    /**
     * Get the full quota snapshot for a company.
     */
    getQuota: async (companyId: string, now?: Date): Promise<QuotaSnapshot | null> => {
      const company = await db
        .select({
          id: companies.id,
          planTier: companies.planTier,
          planSeatsPaid: companies.planSeatsPaid,
          planPeriodEnd: companies.planPeriodEnd,
        })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) return null;

      const tier = company.planTier ?? "free";
      const seatsPaid = company.planSeatsPaid ?? 0;
      const { start, end } = billingWindow(company.planPeriodEnd ?? null, now);

      const includedRuns = computeIncludedRuns(tier, seatsPaid);

      const [usedRow] = await db
        .select({ used: count() })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.companyId, companyId),
            gte(agentRuns.startedAt, start),
            lt(agentRuns.startedAt, end),
          ),
        );

      const usedRuns = usedRow?.used ?? 0;
      const remainingRuns = Math.max(0, includedRuns - usedRuns);
      const overageRuns = Math.max(0, usedRuns - includedRuns);

      return {
        tier,
        includedRuns,
        usedRuns,
        remainingRuns,
        overageRuns,
        seatsCount: seatsPaid,
        billingPeriodStart: start.toISOString(),
        billingPeriodEnd: end.toISOString(),
      };
    },
  };
}
