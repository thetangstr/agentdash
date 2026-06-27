// AgentDash (Test Drive): anonymous, no-signup trial sessions.
//
// Each session backs an ephemeral `trial_anonymous` company + one curated hero
// agent. The session is keyed by an opaque, url-safe token (no email, no user).
// A credit guard (creditCents/spentCents) bounds anonymous LLM spend; sessions
// expire after a fixed window and are GC'd unless claimed on signup.
//
// See docs/superpowers/specs/2026-06-27-test-drive-no-signup-trial.md (§4, §10).

import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const trialSessions = pgTable(
  "trial_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Opaque, url-safe random token — the only credential a trial visitor holds.
    token: text("token").notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    // Starting trial credit and running spend (cents). creditRemaining is derived.
    creditCents: integer("credit_cents").notNull(),
    spentCents: integer("spent_cents").notNull().default(0),
    // Hashed (never raw) client IP for abuse metering. Nullable.
    ipHash: text("ip_hash"),
    // Set when an anonymous workspace is claimed on signup (Slice 3). Nullable.
    claimedByUserId: text("claimed_by_user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenUniqueIdx: uniqueIndex("trial_sessions_token_unique_idx").on(table.token),
    companyIdx: index("trial_sessions_company_idx").on(table.companyId),
  }),
);
