// AgentDash (#767 review, SC-6): the persisted claim of a hosted box.
//
// One row at most (the primary key is the constant "box"). The first sign-up
// through the claim link inserts it atomically (INSERT … ON CONFLICT DO
// NOTHING) inside Better Auth's user.create.before hook, so of N parallel
// claim sign-ups exactly one may create a user. `attempt` names the request
// that took it, so only that request's user creation passes and only that
// request can release it if its sign-up fails. Once the box is claimed the row
// stays: the claim code never works again, even if every user is deleted.
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const agentdashBoxClaim = pgTable("agentdash_box_claim", {
  id: text("id").primaryKey().default("box"),
  email: text("email").notNull(),
  attempt: text("attempt").notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
});
