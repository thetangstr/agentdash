// AgentDash: goals-eval-hitl
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, featureFlags } from "@paperclipai/db";

import { assertActivityAcceptance, type ActivityAcceptance } from "./activity-log.js";

export type FeatureFlagRow = typeof featureFlags.$inferSelect;

/**
 * Per-company feature-flag service. Used to gate the DoD guard rollout
 * (and any future per-tenant feature toggles) without modifying inherited
 * schema files.
 *
 * `isEnabled` is the hot-path read; it's a tiny indexed lookup, so we just
 * query directly rather than plumbing per-request memoization. Callers that
 * need batched lookups can wrap their own cache.
 *
 * Writes from the HTTP route go through `change`, which returns the value it
 * replaced so the route can record a `feature_flag.updated` activity row in
 * the same transaction. `set` stays for internal callers that compose their
 * own transaction.
 */
export function featureFlagsService(db: Db) {
  async function readFlag(executor: Db, companyId: string, flagKey: string): Promise<FeatureFlagRow | null> {
    return executor
      .select()
      .from(featureFlags)
      .where(and(eq(featureFlags.companyId, companyId), eq(featureFlags.flagKey, flagKey)))
      .then((rows) => rows[0] ?? null);
  }

  async function get(companyId: string, flagKey: string): Promise<FeatureFlagRow | null> {
    return readFlag(db, companyId, flagKey);
  }

  async function upsert(executor: Db, companyId: string, flagKey: string, enabled: boolean): Promise<FeatureFlagRow> {
    const now = new Date();
    const inserted = await executor
      .insert(featureFlags)
      .values({
        companyId,
        flagKey,
        enabled,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [featureFlags.companyId, featureFlags.flagKey],
        set: {
          enabled,
          updatedAt: now,
        },
      })
      .returning();
    return inserted[0]!;
  }

  function lockCompany(executor: Db, companyId: string) {
    return executor.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("no key update");
  }

  return {
    get,

    isEnabled: async (companyId: string, flagKey: string): Promise<boolean> => {
      const row = await get(companyId, flagKey);
      return row?.enabled === true;
    },

    set: async (
      companyId: string,
      flagKey: string,
      enabled: boolean,
      acceptance?: ActivityAcceptance,
    ): Promise<FeatureFlagRow> => {
      const write = async (executor: Db) => {
        if (flagKey === "dod_guard_enabled") {
          await lockCompany(executor, companyId);
        }
        return upsert(executor, companyId, flagKey, enabled);
      };
      if (acceptance !== undefined) { assertActivityAcceptance(acceptance); return write(acceptance.executor); }
      return flagKey === "dod_guard_enabled" ? db.transaction(tx => write(tx as unknown as Db)) : write(db);
    },

    /**
     * Upsert on the caller's transaction and return the value it replaced
     * (`null` when the flag had never been set). The company row is locked
     * first — the same per-company lock `set` takes for the DoD guard — so two
     * concurrent changes to one company's flags serialize and each records the
     * value it actually replaced.
     */
    change: async (
      companyId: string,
      flagKey: string,
      enabled: boolean,
      acceptance: ActivityAcceptance,
    ): Promise<{ row: FeatureFlagRow; previousEnabled: boolean | null }> => {
      assertActivityAcceptance(acceptance);
      const executor = acceptance.executor;
      await lockCompany(executor, companyId);
      const previous = await readFlag(executor, companyId, flagKey);
      const row = await upsert(executor, companyId, flagKey, enabled);
      return { row, previousEnabled: previous ? previous.enabled : null };
    },

    listForCompany: async (companyId: string): Promise<FeatureFlagRow[]> => {
      return db
        .select()
        .from(featureFlags)
        .where(eq(featureFlags.companyId, companyId));
    },
  };
}

export type FeatureFlagsService = ReturnType<typeof featureFlagsService>;
