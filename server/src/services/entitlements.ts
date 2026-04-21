// AgentDash: Entitlements service
// Reads and writes the canonical company→tier mapping and materializes
// the pure entitlements map from @agentdash/shared. All gate checks on
// the server go through here so UI can never fabricate access.

import { eq } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { companyPlan } from "@agentdash/db";
import {
  entitlementsForTier,
  type Entitlements,
  type Tier,
  TIERS,
} from "@agentdash/shared";

function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

export function entitlementsService(db: Db) {
  async function getTier(companyId: string): Promise<Tier> {
    const rows = await db
      .select({ planId: companyPlan.planId })
      .from(companyPlan)
      .where(eq(companyPlan.companyId, companyId))
      .limit(1);
    const planId = rows[0]?.planId;
    if (planId && isTier(planId)) return planId;
    return "free";
  }

  async function setTier(companyId: string, tier: Tier): Promise<void> {
    await db
      .insert(companyPlan)
      .values({ companyId, planId: tier })
      .onConflictDoUpdate({
        target: companyPlan.companyId,
        set: { planId: tier, activatedAt: new Date() },
      });
  }

  // AgentDash: Extended for billing state — must stay in sync with billingService
  async function getEntitlements(
    companyId: string,
  ): Promise<Entitlements & { stripeCustomerId: string | null; subscriptionStatus: string | null; currentPeriodEnd: string | null }> {
    const rows = await db
      .select({
        planId: companyPlan.planId,
        stripeCustomerId: companyPlan.stripeCustomerId,
        subscriptionStatus: companyPlan.subscriptionStatus,
        currentPeriodEnd: companyPlan.currentPeriodEnd,
      })
      .from(companyPlan)
      .where(eq(companyPlan.companyId, companyId))
      .limit(1);
    const row = rows[0];
    const planId = row?.planId;
    const tier: Tier = planId && isTier(planId) ? planId : "free";
    return {
      ...entitlementsForTier(tier),
      stripeCustomerId: row?.stripeCustomerId ?? null,
      subscriptionStatus: row?.subscriptionStatus ?? null,
      currentPeriodEnd: row?.currentPeriodEnd?.toISOString() ?? null,
    };
  }

  async function setStripeIds(
    companyId: string,
    stripeCustomerId: string | null,
    stripeSubscriptionId: string | null,
  ): Promise<void> {
    // Stripe does not guarantee event ordering. `null` here means
    // "caller did not learn a new value" — do not overwrite an existing one.
    const updateSet: Partial<{ stripeCustomerId: string; stripeSubscriptionId: string }> = {};
    if (stripeCustomerId !== null) updateSet.stripeCustomerId = stripeCustomerId;
    if (stripeSubscriptionId !== null) updateSet.stripeSubscriptionId = stripeSubscriptionId;

    const insert = db
      .insert(companyPlan)
      .values({ companyId, planId: "free", stripeCustomerId, stripeSubscriptionId });

    if (Object.keys(updateSet).length === 0) {
      await insert.onConflictDoNothing({ target: companyPlan.companyId });
      return;
    }

    await insert.onConflictDoUpdate({
      target: companyPlan.companyId,
      set: updateSet,
    });
  }

  async function setSubscriptionStatus(
    companyId: string,
    status: string | null,
    currentPeriodEnd: Date | null,
  ): Promise<void> {
    await db
      .insert(companyPlan)
      .values({ companyId, planId: "free", subscriptionStatus: status, currentPeriodEnd })
      .onConflictDoUpdate({
        target: companyPlan.companyId,
        set: { subscriptionStatus: status, currentPeriodEnd },
      });
  }

  return { getTier, setTier, getEntitlements, setStripeIds, setSubscriptionStatus };
}

export type EntitlementsService = ReturnType<typeof entitlementsService>;
