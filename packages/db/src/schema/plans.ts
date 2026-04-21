// AgentDash: plans + company_plan tables
// Drives the three-tier entitlement system (free / pro / enterprise).
// Stripe-related columns are nullable placeholders; Phase 3 populates them.

import { pgTable, text, uuid, timestamp, index, integer } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  monthlyPriceCents: integer("monthly_price_cents").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const companyPlan = pgTable(
  "company_plan",
  {
    companyId: uuid("company_id")
      .primaryKey()
      .references(() => companies.id, { onDelete: "cascade" }),
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id),
    activatedAt: timestamp("activated_at", { withTimezone: true }).defaultNow().notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    subscriptionStatus: text("subscription_status"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  },
  (t) => [index("company_plan_plan_idx").on(t.planId)],
);
