// AgentDash: goals-eval-hitl
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Per-company feature flag store. Used initially for the `dod_guard_enabled`
 * rollout — backfill defaults to `false` for existing companies; new tenants
 * receive `true` at create time so fresh tenants ship strict DoD enforcement.
 */
export const featureFlags = pgTable(
  "feature_flags",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    flagKey: text("flag_key").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.companyId, table.flagKey],
      name: "feature_flags_pk",
    }),
  }),
);
