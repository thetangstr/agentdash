import type {
  EvaluationMilestoneRef,
  EvaluationOverview,
  EvaluationScorecardVersionSummary,
  ScoredCard,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * AgentDash: Company Evaluator — Milestone 4 client. Every read renders what
 * the server stored; the only writes are the administrator's snapshot and
 * replay, which the server gates.
 */

export interface StoredScorecard {
  id: string;
  companyId: string;
  milestoneKind: "project" | "goal";
  milestoneId: string;
  version: number;
  contractVersion: string;
  formulaVersion: string;
  throughSeq: number | string;
  throughEventId: string | null;
  card: ScoredCard;
  cardHash: string;
  createdAt: string;
}

export interface EvaluationEventRow {
  id: string;
  seq: number | string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  actorType: string;
  actorId: string | null;
  sourceTable: string;
  sourceId: string;
  sourceVersion: string;
  eventType: string;
  eventTime: string;
  ingestTime: string;
  payload: Record<string, unknown>;
  correlationId: string | null;
}

export interface ScorecardVerifyResult {
  ok: boolean;
  reason?: string;
  storedHash?: string;
  replayHash?: string;
  version?: number;
  [key: string]: unknown;
}

const refQuery = (ref: EvaluationMilestoneRef) => `kind=${ref.kind}&id=${encodeURIComponent(ref.id)}`;

export const evaluationApi = {
  overview: (companyId: string) => api.get<EvaluationOverview>(`/companies/${companyId}/evaluation/overview`),
  latest: (companyId: string, ref: EvaluationMilestoneRef, verify = false) =>
    api.get<{ latest: StoredScorecard | null; verify: ScorecardVerifyResult | null }>(`/companies/${companyId}/evaluation/scorecards?${refQuery(ref)}${verify ? "&verify=true" : ""}`),
  versions: (companyId: string, ref: EvaluationMilestoneRef) =>
    api.get<{ versions: EvaluationScorecardVersionSummary[] }>(`/companies/${companyId}/evaluation/scorecards/versions?${refQuery(ref)}`),
  events: (companyId: string, opts: { type?: string; since?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.type) q.set("type", opts.type);
    if (opts.since) q.set("since", opts.since);
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return api.get<{ events: EvaluationEventRow[]; count: number }>(`/companies/${companyId}/evaluation/events${qs ? `?${qs}` : ""}`);
  },
  event: (companyId: string, eventId: string) => api.get<{ event: EvaluationEventRow }>(`/companies/${companyId}/evaluation/events/${encodeURIComponent(eventId)}`),
  /** Administrators only: rebuild the card from the ledger and compare with the stored one. */
  replay: (companyId: string, ref: EvaluationMilestoneRef) =>
    api.get<{ card: ScoredCard; hash: string; state: { open: boolean; retrospective: boolean; hasContract: boolean }; throughSeq: number | string }>(`/companies/${companyId}/evaluation/replay?${refQuery(ref)}`),
  /** Administrators only: store the current projection as the next version. */
  snapshot: (companyId: string, ref: EvaluationMilestoneRef, reviewItems = false) =>
    api.post<{ stored: StoredScorecard; verify: ScorecardVerifyResult | null }>(`/companies/${companyId}/evaluation/scorecards/snapshot${reviewItems ? "?reviewItems=true" : ""}`, { kind: ref.kind, id: ref.id }),
};
