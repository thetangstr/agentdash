// AgentDash: goals-eval-hitl
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { featureFlags } from "@paperclipai/db";

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
 * Audit logging is intentionally skipped here: the activity_log action set
 * for goals-eval-hitl is enumerated in shared/constants.ts and does not
 * include a feature-flag-mutation action. Audit logging for flag changes
 * can be added under a future `feature_flag_changed` action.
 */
export function featureFlagsService(db: Db) {
  async function get(companyId: string, flagKey: string): Promise<FeatureFlagRow | null> {
    return db
      .select()
      .from(featureFlags)
      .where(and(eq(featureFlags.companyId, companyId), eq(featureFlags.flagKey, flagKey)))
      .then((rows) => rows[0] ?? null);
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
    ): Promise<FeatureFlagRow> => {
      const now = new Date();
      const inserted = await db
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
