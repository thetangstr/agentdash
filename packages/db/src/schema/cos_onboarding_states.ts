// AgentDash: per-conversation onboarding phase + captured goals for the CoS-led
// onboarding flow (Phases B/C/D — see docs/superpowers/specs/2026-05-04-cos-onboarding-conversation-design.md).
import { pgTable, uuid, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { assistantConversations, assistantMessages } from "./assistant_conversations.js";
import { deepInterviewSpecs } from "./deep_interview_specs.js";

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
  // DEPRECATED in favor of `deep_interview_spec_id` once Phase F lands.
  // Read from the linked spec for new conversations; this column is kept for
  // migration compatibility with conversations that crystallized before the
  // deep-interview engine was wired up.
  goals: jsonb("goals").$type<CosOnboardingGoals>().notNull().default({}),
  proposalMessageId: uuid("proposal_message_id").references(() => assistantMessages.id, {
    onDelete: "set null",
  }),
  turnsInPhase: integer("turns_in_phase").notNull().default(0),
  // Set when the deep-interview engine crystallizes a spec for this
  // conversation. Phase F's `crystallizeAndAdvanceCos()` writes this in a
  // single transaction with the matching `deep_interview_states` and
  // `deep_interview_specs` updates. Nullable for legacy conversations and
  // for conversations that haven't crystallized yet.
  deepInterviewSpecId: uuid("deep_interview_spec_id").references(() => deepInterviewSpecs.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
