// AgentDash: per-conversation deep-interview engine state. Drives the Socratic
// interview that crystallizes into a `deep_interview_specs` row when the
// ambiguity score crosses the configured threshold (default 0.20). The same
// engine runs against multiple scopes — see `DI_SCOPES` below.
//
// Source-of-truth contract (mirrored in deep_interview_specs):
//   - assistantMessages          → canonical timeline (read by UI)
//   - deep_interview_states.transcript → engine cache, rebuilt on resume
//   - deep_interview_specs.transcript  → frozen export, read-only after write
//
// See docs/superpowers/plans/2026-05-04-onboarding-redesign-deep-interview-plan.md
// (Phase B) for the full design rationale.
import { pgTable, uuid, text, integer, timestamp, jsonb, real, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Re-exported from packages/shared/src/deep-interview.ts so server-side code
// (Phase C) can import without crossing the db-package boundary at the type
// level. Keep this list in sync with that module.
export const DI_SCOPES = ["cos_onboarding", "assess_project"] as const;
export type DeepInterviewScope = (typeof DI_SCOPES)[number];

export const deepInterviewStates = pgTable(
  "deep_interview_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // One of `DI_SCOPES`. Stored as text so that adding a new scope is a code-
    // only change with no migration; validated at the application boundary.
    scope: text("scope").notNull(),
    // Polymorphic reference: for `cos_onboarding` this is the conversation_id;
    // for `assess_project` it is the project_id. No FK is declared because the
    // referenced table differs by scope — invariants are enforced in the
    // service layer (server/src/services/deep-interview-engine.ts).
    scopeRefId: uuid("scope_ref_id").notNull(),
    // "in_progress" | "crystallized" | "abandoned".
    status: text("status").notNull().default("in_progress"),
    currentRound: integer("current_round").notNull().default(0),
    // Last computed ambiguity score (0.0 = perfect clarity, 1.0 = unknown).
    // Nullable until the first turn lands.
    ambiguityScore: real("ambiguity_score"),
    // Last-round dimension scores: { goal, constraints, criteria, context }.
    dimensionScores: jsonb("dimension_scores"),
    // Array of { round, entities[], stability_ratio } snapshots, one per round.
    ontologySnapshots: jsonb("ontology_snapshots").notNull().default(sql`'[]'::jsonb`),
    // Subset of ["contrarian", "simplifier", "ontologist"]. Each mode fires
    // at most once per interview; the engine consults this list to gate.
    challengeModesUsed: text("challenge_modes_used")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Denormalized engine cache. Canonical truth lives in `assistantMessages`
    // per the source-of-truth contract above; this column is rebuilt from
    // canonical on resume to avoid re-querying every turn.
    transcript: jsonb("transcript").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Fast lookup by (scope, scopeRefId) — the engine's primary read path.
    index("deep_interview_states_scope_idx").on(table.scope, table.scopeRefId),
    // "Find all in-progress" sweep used by GET /api/onboarding/in-progress.
    index("deep_interview_states_status_idx").on(table.status),
  ],
);
