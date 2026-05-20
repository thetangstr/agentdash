import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

export type TierCapAction = "invite" | "hire";
export type TierInviteJoinType = "human" | "agent" | "both";

export interface TierCapacityDeps {
  getCompany: (id: string) => Promise<{ planTier: string }>;
  counts: {
    humans: (companyId: string) => Promise<number>;
    agents: (companyId: string) => Promise<number>;
  };
}

export interface TierCapacityAdds {
  humans?: number;
  agents?: number;
}

// AgentDash (#157): pro_past_due is intentionally excluded. Past-due
// customers do not get Pro features until they resolve the payment issue.
const PRO_LIVE = new Set(["pro_trial", "pro_active"]);

export function isProLivePlanTier(planTier: string | null | undefined): boolean {
  return PRO_LIVE.has(planTier ?? "free");
}

/**
 * Billing is "disabled" and all caps bypass when the operator explicitly opts
 * out via AGENTDASH_BILLING_DISABLED=true, or when no Stripe key is configured.
 * Production deployments set STRIPE_SECRET_KEY, so caps are enforced there.
 */
export function isBillingDisabled(): boolean {
  if (process.env.AGENTDASH_BILLING_DISABLED === "true") return true;
  if (!process.env.STRIPE_SECRET_KEY) return true;
  return false;
}

export function freeTierCapExceededPayload(action: TierCapAction) {
  if (action === "invite") {
    return {
      code: "seat_cap_exceeded",
      message: "Free workspaces are limited to 1 user. Upgrade to Pro to invite teammates.",
    } as const;
  }
  return {
    code: "agent_cap_exceeded",
    message: "Free workspaces include only the Chief of Staff. Upgrade to Pro to hire more agents.",
  } as const;
}

export async function exceededFreeTierCapacityAction(
  deps: TierCapacityDeps,
  companyId: string,
  adds: TierCapacityAdds,
): Promise<TierCapAction | null> {
  if (isBillingDisabled()) return null;

  const company = await deps.getCompany(companyId);
  if (isProLivePlanTier(company.planTier)) return null;

  const humansToAdd = adds.humans ?? 0;
  if (humansToAdd > 0) {
    const humans = await deps.counts.humans(companyId);
    if (humans + humansToAdd > 1) return "invite";
  }

  const agentsToAdd = adds.agents ?? 0;
  if (agentsToAdd > 0) {
    const agents = await deps.counts.agents(companyId);
    if (agents + agentsToAdd > 1) return "hire";
  }

  return null;
}

export async function exceededFreeTierInviteCapacityAction(
  deps: TierCapacityDeps,
  companyId: string,
  allowedJoinTypes: TierInviteJoinType,
): Promise<TierCapAction | null> {
  if (allowedJoinTypes === "human") {
    return exceededFreeTierCapacityAction(deps, companyId, { humans: 1 });
  }
  if (allowedJoinTypes === "agent") {
    return exceededFreeTierCapacityAction(deps, companyId, { agents: 1 });
  }

  // A "both" invite is usable when at least one accepted join type still has
  // room. Approval remains the authoritative capacity-consuming write.
  const humanBlocked = await exceededFreeTierCapacityAction(deps, companyId, {
    humans: 1,
  });
  if (!humanBlocked) return null;

  const agentBlocked = await exceededFreeTierCapacityAction(deps, companyId, {
    agents: 1,
  });
  return agentBlocked ? humanBlocked : null;
}

function companyTierCapacityLockKey(companyId: string): number {
  return Number.parseInt(
    createHash("sha256").update(`tier-cap:${companyId}`).digest("hex").slice(0, 12),
    16,
  );
}

export async function withCompanyTierCapacityLock<T>(
  db: Db,
  companyId: string,
  work: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockCompanyTierCapacity(tx as unknown as Db, companyId);
    return work(tx as unknown as Db);
  });
}

export async function lockCompanyTierCapacity(
  dbOrTx: Pick<Db, "execute">,
  companyId: string,
): Promise<void> {
  await dbOrTx.execute(
    sql`SELECT pg_advisory_xact_lock(${companyTierCapacityLockKey(companyId)})`,
  );
}

export async function withCompanyTierCapacityGuard<T>(
  db: Db,
  companyId: string,
  adds: TierCapacityAdds,
  depsFor: (dbOrTx: Db) => TierCapacityDeps,
  onExceeded: (action: TierCapAction) => void,
  work: (dbOrTx: Db) => Promise<T>,
): Promise<T | null> {
  if (isBillingDisabled()) return work(db);

  return withCompanyTierCapacityLock(db, companyId, async (tx) => {
    const blockedAction = await exceededFreeTierCapacityAction(
      depsFor(tx),
      companyId,
      adds,
    );
    if (blockedAction) {
      onExceeded(blockedAction);
      return null;
    }
    return work(tx);
  });
}

export async function withCompanyTierInviteCapacityGuard<T>(
  db: Db,
  companyId: string,
  allowedJoinTypes: TierInviteJoinType,
  depsFor: (dbOrTx: Db) => TierCapacityDeps,
  onExceeded: (action: TierCapAction) => void,
  work: (dbOrTx: Db) => Promise<T>,
): Promise<T | null> {
  if (isBillingDisabled()) return work(db);

  return withCompanyTierCapacityLock(db, companyId, async (tx) => {
    const blockedAction = await exceededFreeTierInviteCapacityAction(
      depsFor(tx),
      companyId,
      allowedJoinTypes,
    );
    if (blockedAction) {
      onExceeded(blockedAction);
      return null;
    }
    return work(tx);
  });
}
