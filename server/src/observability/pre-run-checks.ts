import { and, count, eq, gte, sql, sum } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { budgetPolicies, costEvents, heartbeatRuns } from "@paperclipai/db";
import { emitSignal } from "./signals.js";

/**
 * The one seam where a run is allowed to start (M3 budget, M4 runaway cap).
 * Called from the heartbeat scheduler's claim path, next to the blocker and
 * staleness gates that already live there — three checks, one edit site.
 *
 * Two deliberate asymmetries:
 *
 *  - The DAILY CAP refuses today. It counts runs, which are measured, and it
 *    is the only thing standing between a cheap infinite loop and a provider
 *    invoice while token metering (M1) is unbuilt.
 *  - The BUDGET check warns but only refuses when the policy says
 *    hardStopEnabled — and mkboard's policy deliberately says false, because
 *    spend reads zero until M1 lands and a hard stop on a zero-reading metric
 *    is decorative today and a surprise outage the day metering starts.
 *    Flipping it on is on M1's checklist.
 */

const DEFAULT_DAILY_RUN_CAP = 100;

export function dailyRunCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.AGENTDASH_AGENT_DAILY_RUN_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_DAILY_RUN_CAP;
}

export interface PreRunVerdict {
  allowed: boolean;
  reason?: string;
  errorCode?: string;
}

export async function preRunChecks(
  db: Db,
  run: { companyId: string; agentId: string | null },
): Promise<PreRunVerdict> {
  // M4: per-agent daily ceiling. Counts every run STARTED today, any status —
  // a loop of instant failures must trip it exactly as well as a loop of
  // successes.
  if (run.agentId) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const cap = dailyRunCap();
    const startedToday = await db
      .select({ count: count() })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, run.agentId),
          gte(heartbeatRuns.createdAt, dayStart),
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));
    if (startedToday >= cap) {
      emitSignal({
        kind: "run_cap_hit",
        companyId: run.companyId,
        summary: `agent hit the daily run cap (${cap})`,
        detail: { agentId: run.agentId, cap, startedToday },
      });
      return {
        allowed: false,
        errorCode: "daily_run_cap",
        reason:
          `Agent has started ${startedToday} runs today, at the cap of ${cap}. ` +
          "Raise AGENTDASH_AGENT_DAILY_RUN_CAP if this volume is intended.",
      };
    }
  }

  // M3: budget. Active monthly company policy vs this month's cost events.
  const policy = await db
    .select()
    .from(budgetPolicies)
    .where(
      and(
        eq(budgetPolicies.companyId, run.companyId),
        eq(budgetPolicies.scopeType, "company"),
        eq(budgetPolicies.windowKind, "monthly"),
        eq(budgetPolicies.isActive, true),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (policy && policy.amount > 0) {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const spentCents = await db
      .select({ total: sum(costEvents.costCents) })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, run.companyId), gte(costEvents.createdAt, monthStart)))
      .then((rows) => Number(rows[0]?.total ?? 0));

    const warnAt = (policy.amount * policy.warnPercent) / 100;
    if (spentCents >= policy.amount) {
      emitSignal({
        kind: "budget_stop",
        companyId: run.companyId,
        summary: `monthly budget reached: ${(spentCents / 100).toFixed(2)} of ${(policy.amount / 100).toFixed(2)}`,
        detail: { policyId: policy.id, spentCents, amountCents: policy.amount },
      });
      if (policy.hardStopEnabled) {
        return {
          allowed: false,
          errorCode: "budget_hard_stop",
          reason: "Monthly budget reached and the policy has hard stop enabled.",
        };
      }
    } else if (spentCents >= warnAt && policy.notifyEnabled) {
      emitSignal({
        kind: "budget_warn",
        companyId: run.companyId,
        summary: `monthly spend at ${Math.round((spentCents / policy.amount) * 100)}% of budget`,
        detail: { policyId: policy.id, spentCents, amountCents: policy.amount },
      });
    }
  }

  return { allowed: true };
}
