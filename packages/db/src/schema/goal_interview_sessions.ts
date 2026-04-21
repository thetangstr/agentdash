// AgentDash (AGE-50 Phase 2): persist whether a Chief of Staff
// /deep-interview is in flight for a goal so the Goal Hub can render a
// "Resume interview" CTA instead of restarting from scratch when the
// operator closes the chat mid-flow.
//
// One row per interview attempt. `completedAt` is set by the
// submit_goal_interview tool once a plan is generated; `abandonedAt` is
// reserved for an explicit "restart" affordance (not wired in Phase 2).

import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { goals } from "./goals.js";

export const goalInterviewSessions = pgTable(
  "goal_interview_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    goalId: uuid("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    // Chat conversation id from the assistant session. Null until the
    // seeded chat completes its first exchange; filled in by
    // `attachConversation` so resume can rehydrate the same thread.
    conversationId: text("conversation_id"),
    // Who kicked off the interview. Null for system-initiated sessions
    // (reserved for future autopilot flows).
    startedByUserId: uuid("started_by_user_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set by submit_goal_interview when the CoS hands back a
    // GoalInterviewPayload and a plan is persisted.
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Set when operator explicitly abandons (e.g., "restart interview"
    // button). Not wired in Phase 2.
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
  },
  (table) => ({
    goalIdx: index("gis_goal_idx").on(table.goalId),
    companyIdx: index("gis_company_idx").on(table.companyId),
  }),
);
