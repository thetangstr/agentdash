// AgentDash: shared types and constants for the deep-interview engine.
//
// `DI_SCOPES` is the single source of truth that both the db schema
// (`packages/db/src/schema/deep_interview_states.ts`) and server-side engine
// (`server/src/services/deep-interview-*.ts`) import from. Keep that schema
// re-export in sync if a new scope is added here.
//
// See docs/superpowers/plans/2026-05-04-onboarding-redesign-deep-interview-plan.md
// (Phase B) for the design rationale.

export const DI_SCOPES = ["cos_onboarding", "assess_project"] as const;
export type DeepInterviewScope = (typeof DI_SCOPES)[number];

export interface DimensionScores {
  goal: number;
  constraints: number;
  criteria: number;
  context: number;
}

export interface OntologyEntity {
  name: string;
  type: "core_domain" | "supporting" | "external_system";
  fields?: string[];
  relationships?: string[];
}

export interface OntologySnapshot {
  round: number;
  entities: OntologyEntity[];
  newCount: number;
  changedCount: number;
  stableCount: number;
  stabilityRatio: number | null;
}

export type ChallengeMode = "contrarian" | "simplifier" | "ontologist";

export interface TranscriptTurn {
  round: number;
  question: string;
  targetDimension: keyof DimensionScores;
  answer: string;
  ambiguityAfter: number;
  challengeMode?: ChallengeMode;
}
