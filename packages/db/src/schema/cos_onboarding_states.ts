// AgentDash: per-conversation onboarding phase + captured goals for the CoS-led
// onboarding flow (Phases B/C/D — see docs/superpowers/specs/2026-05-04-cos-onboarding-conversation-design.md).
import { pgTable, uuid, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { assistantConversations, assistantMessages } from "./assistant_conversations.js";

export interface CosOnboardingGoals {
  shortTerm?: string;
  longTerm?: string;
  constraints?: Record<string, unknown>;
}

export const COS_ONBOARDING_PHASES = ["goals", "plan", "materializing", "ready"] as const;
export type CosOnboardingPhase = (typeof COS_ONBOARDING_PHASES)[number];

export const cosOnboardingStates = pgTable("cos_onboarding_states", {
  conversationId: uuid("conversation_id")
    .primaryKey()
    .references(() => assistantConversations.id, { onDelete: "cascade" }),
  phase: text("phase").notNull().default("goals"),
  goals: jsonb("goals").$type<CosOnboardingGoals>().notNull().default({}),
  proposalMessageId: uuid("proposal_message_id").references(() => assistantMessages.id, {
    onDelete: "set null",
  }),
  turnsInPhase: integer("turns_in_phase").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
