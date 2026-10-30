import type {
  AgentAccessInventory,
  AgentCardResponse,
  AgentCardSnapshotResponse,
  AgentCardSummary,
  AgentCardVersionList,
  AgentCardView,
  AgentCaseFilter,
  AgentCaseList,
  AgentPerformanceProjection,
  AgentProfileView,
  EvaluationAgentDisposition,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * AgentDash: Agent Performance Management gate 1 ("see what's true today").
 *
 * Three read-only views of an agent: its operating profile (gate 2: the
 * active revision, the open draft and pending proposal, the newest
 * application, and — while nothing is applied — the revision 0 derived from
 * today's records), what today's rules let it see, do, talk to and spend, and
 * how its work has gone in a window. Every route here is a GET; none of them
 * writes, grants or scores anything. The server decides who may read each
 * one. Profile writes live in `./agent-profiles`.
 *
 * Gate 3 (P3.5) adds the agent card (evaluation LLD §11–§12): the stored card
 * projected for the viewer, a side-effect-free "Compute now", the cases behind
 * each number, a snapshot (admin or accountable person), and the agent
 * dispositions (`use_confirmed`, `disagreement_noted`, bound `criterion_attest`).
 * P3.7: the stored versions list, server-side case filters (fact, criterion,
 * judge) and the shared snapshot/verify result types.
 */

export const AGENT_PERFORMANCE_DEFAULT_WINDOW_DAYS = 30;

/** The case-list page size the drill-down asks for (the server allows 1–500). */
export const AGENT_CASES_PAGE_SIZE = 50;

export const agentPerformanceQueryKeys = {
  profile: (companyId: string, agentId: string) =>
    ["agents", "performance-mgmt", companyId, agentId, "profile"] as const,
  access: (companyId: string, agentId: string) =>
    ["agents", "performance-mgmt", companyId, agentId, "access"] as const,
  projection: (companyId: string, agentId: string, windowDays: number) =>
    ["agents", "performance-mgmt", companyId, agentId, "projection", windowDays] as const,
  /** Every agent-card read for one agent, for invalidation after a snapshot or disposition. */
  cardAll: (companyId: string, agentId: string) =>
    ["agents", "performance-mgmt", companyId, agentId, "card"] as const,
  card: (companyId: string, agentId: string, version: number | null) =>
    ["agents", "performance-mgmt", companyId, agentId, "card", "stored", version ?? "latest"] as const,
  versions: (companyId: string, agentId: string) =>
    ["agents", "performance-mgmt", companyId, agentId, "card", "versions"] as const,
  compute: (companyId: string, agentId: string, windowDays: number, nonce: number) =>
    ["agents", "performance-mgmt", companyId, agentId, "card", "compute", windowDays, nonce] as const,
  cases: (companyId: string, agentId: string, filter: AgentCaseFilter) =>
    ["agents", "performance-mgmt", companyId, agentId, "card", "cases", filter] as const,
  cards: (companyId: string) => ["evaluation", companyId, "agent-cards"] as const,
};

export interface AgentDispositionResponse {
  inserted: number;
  skipped: number;
  eventId: string | null;
  status: string;
}

function agentPath(companyId: string, agentId: string): string {
  return `/companies/${encodeURIComponent(companyId)}/evaluation/agents/${encodeURIComponent(agentId)}`;
}

function caseQuery(filter: AgentCaseFilter): string {
  const q = new URLSearchParams();
  if (filter.version != null) q.set("version", String(filter.version));
  if (filter.responsibility) q.set("responsibility", filter.responsibility);
  if (filter.state) q.set("state", filter.state);
  if (filter.section) q.set("section", filter.section);
  if (filter.fact) q.set("fact", filter.fact);
  if (filter.criterion) q.set("criterion", filter.criterion);
  if (filter.judge) q.set("judge", filter.judge);
  if (filter.limit != null) q.set("limit", String(filter.limit));
  if (filter.cursor) q.set("cursor", filter.cursor);
  const qs = q.toString();
  return qs ? `?${qs}` : "";
}

export const agentPerformanceApi = {
  /** Any member who can see the agent. Gate 2: `AgentProfileView`, with the gate 1 derived profile embedded as `derived`. */
  profile: (companyId: string, agentId: string) =>
    api.get<AgentProfileView>(
      `/companies/${encodeURIComponent(companyId)}/agents/${encodeURIComponent(agentId)}/profile`,
    ),
  /** Company admins, the accountable person and the active steward; 403 for everyone else. */
  access: (companyId: string, agentId: string) =>
    api.get<AgentAccessInventory>(
      `/companies/${encodeURIComponent(companyId)}/agents/${encodeURIComponent(agentId)}/access`,
    ),
  /** Same readers as `access`. `windowDays` is 1–365; the server defaults to 30. */
  projection: (
    companyId: string,
    agentId: string,
    windowDays: number = AGENT_PERFORMANCE_DEFAULT_WINDOW_DAYS,
  ) =>
    api.get<AgentPerformanceProjection>(
      `${agentPath(companyId, agentId)}/projection?windowDays=${windowDays}`,
    ),
  /** Gate 3: the latest stored card per agent the viewer can see, each projected for the viewer. People only. */
  cards: (companyId: string) =>
    api.get<{ agents: AgentCardSummary[] }>(`/companies/${encodeURIComponent(companyId)}/evaluation/agents`),
  /**
   * Gate 3: a stored card (latest, or `version`), projected for the viewer; `card: null` when none is stored.
   * `viewer` says what the caller may do (snapshot, note a disagreement, confirm use, attest which criteria).
   */
  card: (companyId: string, agentId: string, version: number | null = null) =>
    api.get<AgentCardResponse>(
      `${agentPath(companyId, agentId)}${version != null ? `?version=${version}` : ""}`,
    ),
  /** P3.7: the stored versions, newest first (version, hash, cut, asOf, saved at). No card content. */
  versions: (companyId: string, agentId: string) =>
    api.get<AgentCardVersionList>(`${agentPath(companyId, agentId)}/versions`),
  /** Gate 3: "Compute now" — the card at the current cut. Stores nothing, appends nothing, creates no review item. */
  compute: (companyId: string, agentId: string, windowDays: number = AGENT_PERFORMANCE_DEFAULT_WINDOW_DAYS) =>
    api.get<{ card: AgentCardView }>(`${agentPath(companyId, agentId)}/compute?windowDays=${windowDays}`),
  /** Gate 3: the cases behind a stored card's numbers, filtered by access class before counting or paging. */
  cases: (companyId: string, agentId: string, filter: AgentCaseFilter) =>
    api.get<AgentCaseList>(`${agentPath(companyId, agentId)}/cases${caseQuery(filter)}`),
  /** Gate 3: store a version (admin or accountable person). Appends findings and may create calibration review items. */
  snapshot: (companyId: string, agentId: string, windowDays: number = AGENT_PERFORMANCE_DEFAULT_WINDOW_DAYS) =>
    api.post<AgentCardSnapshotResponse>(`${agentPath(companyId, agentId)}/snapshot?windowDays=${windowDays}`, {}),
  /** Gate 3: an agent disposition. The server checks who may record each kind. */
  recordDisposition: (companyId: string, body: EvaluationAgentDisposition) =>
    api.post<AgentDispositionResponse>(`/companies/${encodeURIComponent(companyId)}/evaluation/dispositions`, body),
};
