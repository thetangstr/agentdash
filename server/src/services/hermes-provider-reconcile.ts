// AgentDash (#725): the company secret is the source of truth for the Hermes
// provider key. At boot, and whenever an agent profile is provisioned, the key
// is re-materialised from the secret into the template and the company's own
// agent profiles (services/hermes-provider-setup.ts
// reconcileHermesProviderFromSecret). Profiles that already hold it are left
// alone.

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { advisoryLock, companySecretStore, listCompanyHermesAgentIds } from "./hermes-provider-db.js";
import { setAgentProfileProvisionedHook } from "./hermes-profile.js";
import {
  hermesProviderOwner,
  reconcileHermesProviderFromSecret,
  type HermesProviderSetupDeps,
} from "./hermes-provider-setup.js";

export interface HermesProviderReconcileDeps {
  setup?: HermesProviderSetupDeps;
  listAgentIds?: (companyId: string) => Promise<string[]>;
  companyOfAgent?: (agentId: string) => Promise<string | null>;
}

export function hermesProviderReconciler(db: Db, deps: HermesProviderReconcileDeps = {}) {
  const setup: HermesProviderSetupDeps = { secrets: companySecretStore(db), lock: advisoryLock(db), ...deps.setup };
  const listAgentIds = deps.listAgentIds ?? ((companyId: string) => listCompanyHermesAgentIds(db, companyId));
  const companyOfAgent =
    deps.companyOfAgent
    ?? (async (agentId: string) => {
      const rows = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId));
      return rows[0]?.companyId ?? null;
    });

  return {
    /** Boot: the company that owns the template, all of its agent profiles. */
    async reconcileAll() {
      const companyId = await hermesProviderOwner(setup);
      if (!companyId) return null;
      return reconcileHermesProviderFromSecret(companyId, { agentIds: await listAgentIds(companyId) }, setup);
    },
    /** A newly provisioned profile: only that agent, only if its company owns the key. */
    async reconcileAgent(agentId: string) {
      const companyId = await companyOfAgent(agentId);
      if (!companyId) return null;
      // probe: "never" — this is awaited on the agent's first run, which must
      // not wait on up to four provider requests. The boot reconcile pins the
      // endpoint; the new profile just gets the pinned value.
      const result = await reconcileHermesProviderFromSecret(companyId, { agentIds: [agentId], probe: "never" }, setup);
      if (result.failed.length > 0) {
        throw new Error(`could not write the provider key into ${result.failed.join(", ")}`);
      }
      return result;
    },
    /**
     * A dispatch failed with Z.AI's "no balance" (code 1113): the pinned
     * endpoint may have lapsed. Probe the endpoints again and pin the one that
     * answers, in every profile. Rate limited to once per REPIN_INTERVAL_MS per
     * instance so a persistently empty account does not probe on every message.
     * Returns whether the pinned endpoint changed (a Retry can then succeed).
     */
    async repinEndpoint(
      forCompanyId: string,
      now: number = Date.now(),
    ): Promise<{ repinned: boolean; skipped?: "rate_limited" | "not_configured" }> {
      // Only the company that owns the template's key can have a lapsed pin on
      // it; a failure in any other company must not probe or spend the budget.
      const companyId = await hermesProviderOwner(setup);
      if (!companyId || companyId !== forCompanyId) return { repinned: false, skipped: "not_configured" };
      if (lastRepinAt !== null && now - lastRepinAt < REPIN_INTERVAL_MS) return { repinned: false, skipped: "rate_limited" };
      lastRepinAt = now;
      const result = await reconcileHermesProviderFromSecret(
        companyId,
        { agentIds: await listAgentIds(companyId), probe: "force" },
        setup,
      );
      return { repinned: Boolean(result.repinned) };
    },
  };
}

const REPIN_INTERVAL_MS = 10 * 60 * 1000;
let lastRepinAt: number | null = null;
/** Test hook. */
export function resetRepinRateLimit(): void {
  lastRepinAt = null;
}

/** Register the provisioning hook and run the boot reconcile (non-fatal, logged). */
export function startHermesProviderReconcile(db: Db): void {
  const reconciler = hermesProviderReconciler(db);
  setAgentProfileProvisionedHook(async (agentId) => {
    await reconciler.reconcileAgent(agentId);
  });
  void reconciler
    .reconcileAll()
    .then((result) => {
      if (result && (result.updated.length > 0 || result.failed.length > 0 || result.status !== "ok")) {
        logger.warn(
          { status: result.status, updated: result.updated, failed: result.failed },
          "[hermes-provider] reconciled profiles from the company secret",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "[hermes-provider] boot reconcile from the company secret failed");
    });
}
