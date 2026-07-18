// AgentDash (AGE-121): Run-quota enforcement gate.
// Checks workspace quota before an agent task starts. Free workspaces are
// hard-blocked when their monthly allotment is exhausted. Pro workspaces are
// soft-allowed (overage metered) so work is never dropped.

import type { Db } from "@paperclipai/db";
import { quotaService, type QuotaSnapshot } from "./quota.js";
import { isBillingDisabled, isProLivePlanTier } from "./tier-policy.js";

// ---------------------------------------------------------------------------
// Decision types
// ---------------------------------------------------------------------------

export type QuotaDecision =
  | { allowed: true; isOverage: false; snapshot: QuotaSnapshot }
  | { allowed: true; isOverage: true; snapshot: QuotaSnapshot }
  | { allowed: false; isOverage: false; snapshot: QuotaSnapshot };

/**
 * 402-style payload returned when a Free workspace exceeds its run quota.
 */
export function quotaExceededPayload(snapshot: QuotaSnapshot) {
  return {
    error: "quota_exceeded" as const,
    tier: snapshot.tier,
    used: snapshot.usedRuns,
    included: snapshot.includedRuns,
    upgrade_url: "/billing",
  };
}

// ---------------------------------------------------------------------------
// Pure decision function (testable without DB)
// ---------------------------------------------------------------------------

/**
 * Given a quota snapshot, decide whether the run should proceed.
 *
 * - Free tier at 0 remaining: blocked (hard cap).
 * - Pro tier at 0 remaining: allowed with isOverage=true (soft cap, metered).
 * - Any tier with remaining > 0: allowed, not overage.
 */
export function decideQuota(snapshot: QuotaSnapshot): QuotaDecision {
  if (snapshot.remainingRuns > 0) {
    return { allowed: true, isOverage: false, snapshot };
  }

  // Remaining is 0 — check tier
  if (isProLivePlanTier(snapshot.tier)) {
    // Pro: soft-allow, flag as overage
    return { allowed: true, isOverage: true, snapshot };
  }

  // Free (or any non-Pro tier): hard block
  return { allowed: false, isOverage: false, snapshot };
}

// ---------------------------------------------------------------------------
// Service (DB-backed)
// ---------------------------------------------------------------------------

export function quotaEnforcementService(db: Db) {
  const quota = quotaService(db);

  return {
    /**
     * Check whether a company is allowed to start a new agent run.
     *
     * Returns a QuotaDecision. Callers should:
     * - If `allowed: false`: cancel the run with a 402-style error.
     * - If `allowed: true, isOverage: true`: proceed but tag the run as overage.
     * - If `allowed: true, isOverage: false`: proceed normally.
     *
     * When billing is disabled (dev mode), always allows.
     */
    checkRunQuota: async (companyId: string): Promise<QuotaDecision> => {
      // Dev mode bypass — same pattern as tier-policy.ts
      if (isBillingDisabled()) {
        return {
          allowed: true,
          isOverage: false,
          snapshot: {
            tier: "free",
            includedRuns: Infinity,
            usedRuns: 0,
            remainingRuns: Infinity,
            overageRuns: 0,
            seatsCount: 0,
            billingPeriodStart: new Date().toISOString(),
            billingPeriodEnd: new Date().toISOString(),
          },
        };
      }

      const snapshot = await quota.getQuota(companyId);
      if (!snapshot) {
        // Company not found — allow by default (fail-open for missing data,
        // the route-level auth already validated the company exists)
        return {
          allowed: true,
          isOverage: false,
          snapshot: {
            tier: "free",
            includedRuns: 0,
            usedRuns: 0,
            remainingRuns: 0,
            overageRuns: 0,
            seatsCount: 0,
            billingPeriodStart: new Date().toISOString(),
            billingPeriodEnd: new Date().toISOString(),
          },
        };
      }

      return decideQuota(snapshot);
    },
  };
}
