// AgentDash (AGE-123): API client for agent-run ledger + receipt endpoints.

import { api } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LedgerRow {
  id: string;
  agentId: string;
  agentName: string;
  issueId: string | null;
  issueTitle: string | null;
  complexityTier: string;
  costCents: number;
  tokenCount: number;
  durationMs: number | null;
  completedAt: string;
}

export interface LedgerPage {
  rows: LedgerRow[];
  total: number;
  hasMore: boolean;
}

export interface QuotaSnapshot {
  tier: string;
  includedRuns: number;
  usedRuns: number;
  remainingRuns: number;
  overageRuns: number;
  seatsCount: number;
  billingPeriodStart: string;
  billingPeriodEnd: string;
}

export interface MonthlyCount {
  companyId: string;
  month: string;
  total: number;
  simple: number;
  medium: number;
  complex: number;
}

export interface AgentMonthlyCount {
  agentId: string;
  total: number;
  simple: number;
  medium: number;
  complex: number;
}

export interface ReceiptResponse {
  quota: QuotaSnapshot | null;
  summary: MonthlyCount;
  activeAgentCount: number;
  byAgent: AgentMonthlyCount[];
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

function ledgerParams(opts?: {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  sort?: string;
}): string {
  const params = new URLSearchParams();
  if (opts?.from) params.set("from", opts.from);
  if (opts?.to) params.set("to", opts.to);
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  if (opts?.sort) params.set("sort", opts.sort);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const agentRunsApi = {
  ledger: (companyId: string, opts?: {
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
    sort?: string;
  }) =>
    api.get<LedgerPage>(
      `/companies/${companyId}/agent-runs/ledger${ledgerParams(opts)}`,
    ),

  receipt: (companyId: string) =>
    api.get<ReceiptResponse>(
      `/companies/${companyId}/agent-runs/receipt`,
    ),

  /** Returns the CSV download URL (caller navigates to it). */
  csvUrl: (companyId: string, from?: string, to?: string): string => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return `/api/companies/${companyId}/agent-runs/ledger.csv${qs ? `?${qs}` : ""}`;
  },
};
