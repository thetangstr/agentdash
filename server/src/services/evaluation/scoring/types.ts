/**
 * AgentDash: Company Evaluator — the card's result shapes live in
 * `@paperclipai/shared` (evaluation-card.ts) so the Milestone 4 surfaces
 * render exactly what the server stores; this module re-exports them for the
 * scoring code.
 */
export type {
  UndecidableReason,
  MetricBreakdown,
  MetricResult,
  CompositeResult,
  ExceptionRecord,
  ActorRow,
  ContractSummary,
  ScoredCard,
} from "@paperclipai/shared";
