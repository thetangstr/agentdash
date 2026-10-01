import { pgTable, uuid, text, integer, timestamp, boolean, uniqueIndex, index, varchar, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { CompanyProductProfile } from "@paperclipai/shared";

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    // `$type` is a compile-time narrowing only — the column stays `text`, so
    // this adds no migration and lets profile checks stay type-safe.
    productProfile: text("product_profile").$type<CompanyProductProfile>().notNull().default("default"),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    issuePrefix: text("issue_prefix").notNull().default("PAP"),
    issueCounter: integer("issue_counter").notNull().default(0),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    attachmentMaxBytes: integer("attachment_max_bytes")
      .notNull()
      .default(10 * 1024 * 1024),
    requireBoardApprovalForNewAgents: boolean("require_board_approval_for_new_agents")
      .notNull()
      .default(false),
    // AgentDash: the status a new issue gets when its creator names none.
    // Off = `backlog` (parked, nobody woken); on = `todo` (the assignee is
    // woken and starts). An explicit status on create always wins.
    newIssuesStartAsTodo: boolean("new_issues_start_as_todo").notNull().default(false),
    /**
     * Agent visibility (2026-09-30): what an agent with no visibility of its
     * own resolves to. 'company' is the inherited default — every member sees
     * every agent — so nothing changes on upgrade. 'owner' makes members see
     * only the agents they answer for, their reports' line, agents they
     * created, and agents an admin marked 'company'. Admins always see all.
     */
    agentVisibilityDefault: text("agent_visibility_default").notNull().default("company"),
    feedbackDataSharingEnabled: boolean("feedback_data_sharing_enabled")
      .notNull()
      .default(false),
    feedbackDataSharingConsentAt: timestamp("feedback_data_sharing_consent_at", { withTimezone: true }),
    feedbackDataSharingConsentByUserId: text("feedback_data_sharing_consent_by_user_id"),
    feedbackDataSharingTermsVersion: text("feedback_data_sharing_terms_version"),
    brandColor: text("brand_color"),
    // AgentDash (AGE-55): FRE Plan B — domain-keyed companies. Nullable so
    // local_implicit actors (single-machine dev) aren't forced to provide one.
    emailDomain: text("email_domain"),
    // AgentDash: billing tier — written only by Stripe webhook handlers.
    planTier: varchar("plan_tier", { length: 32 }).notNull().default("free"),
    planSeatsPaid: integer("plan_seats_paid").notNull().default(0),
    planPeriodEnd: timestamp("plan_period_end", { withTimezone: true }),
    stripeCustomerId: varchar("stripe_customer_id", { length: 64 }),
    stripeSubscriptionId: varchar("stripe_subscription_id", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuePrefixUniqueIdx: uniqueIndex("companies_issue_prefix_idx").on(table.issuePrefix),
    // AGE-55: partial unique index — NULL domains are excluded so multiple
    // local_implicit workspaces can coexist without colliding.
    emailDomainUniqueIdx: uniqueIndex("companies_email_domain_unique_idx")
      .on(table.emailDomain)
      .where(sql`${table.emailDomain} IS NOT NULL`),
    planTierIdx: index("companies_plan_tier_idx").on(table.planTier),
    agentVisibilityDefaultCk: check(
      "companies_agent_visibility_default_ck",
      sql`${table.agentVisibilityDefault} in ('company', 'owner')`,
    ),
  }),
);
