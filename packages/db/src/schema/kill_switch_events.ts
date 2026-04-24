import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const killSwitchEvents = pgTable(
  "kill_switch_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    scopeId: uuid("scope_id").notNull(),
    action: text("action").notNull(),
    reason: text("reason"),
    triggeredByUserId: text("triggered_by_user_id").notNull(),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("kill_switch_events_company_time_idx").on(table.companyId, table.triggeredAt),
    index("kill_switch_events_scope_idx").on(table.scope, table.scopeId),
  ],
);
