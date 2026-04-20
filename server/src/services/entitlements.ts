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

  async function getEntitlements(companyId: string): Promise<Entitlements> {
    const tier = await getTier(companyId);
    return entitlementsForTier(tier);
  }

  return { getTier, setTier, getEntitlements };
}

export type EntitlementsService = ReturnType<typeof entitlementsService>;
