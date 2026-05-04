// AgentDash: crystallized deep-interview spec — the immutable output of the
// Socratic interview engine. Phase F (`crystallizeAndAdvanceCos`) writes one
// row here in the same transaction that flips the linked
// `deep_interview_states` row to `crystallized` and advances
// `cos_onboarding_states.phase` to `plan`.
//
// Source-of-truth contract (mirrored in deep_interview_states):
//   - assistantMessages          → canonical timeline (read by UI)
//   - deep_interview_states.transcript → engine cache, rebuilt on resume
//   - deep_interview_specs.transcript  → frozen export, read-only after write
//
// See docs/superpowers/plans/2026-05-04-onboarding-redesign-deep-interview-plan.md
// (Phase B) for the full design rationale.
import { pgTable, uuid, text, real, timestamp, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { deepInterviewStates } from "./deep_interview_states.js";

export const deepInterviewSpecs = pgTable("deep_interview_specs", {
  id: uuid("id").primaryKey().defaultRandom(),
  stateId: uuid("state_id")
    .notNull()
    .references(() => deepInterviewStates.id, { onDelete: "cascade" }),
  goal: text("goal").notNull(),
  // Array of constraint strings, e.g. ["must work offline", "no PII storage"].
  constraints: jsonb("constraints").notNull().default(sql`'[]'::jsonb`),
  // Array of acceptance-criteria strings (testable conditions).
  criteria: jsonb("criteria").notNull().default(sql`'[]'::jsonb`),
  // Array of explicitly-excluded scope statements.
  nonGoals: jsonb("non_goals").notNull().default(sql`'[]'::jsonb`),
  // Final entity list (OntologyEntity[] from the last interview round).
  ontology: jsonb("ontology").notNull().default(sql`'[]'::jsonb`),
  // Frozen export of the interview transcript at crystallization time.
  // READ-ONLY after this row is written. The canonical timeline lives in
  // assistantMessages; deep_interview_states.transcript is the engine cache.
  transcript: jsonb("transcript").notNull().default(sql`'[]'::jsonb`),
  finalAmbiguity: real("final_ambiguity").notNull(),
  // Final-round dimension scores: { goal, constraints, criteria, context }.
  dimensionScores: jsonb("dimension_scores").notNull(),
  crystallizedAt: timestamp("crystallized_at", { withTimezone: true }).notNull().defaultNow(),
});
