export type IssueWorkProductType =
  | "preview_url"
  | "runtime_service"
  | "pull_request"
  | "branch"
  | "commit"
  | "artifact"
  | "document";

export type IssueWorkProductProvider =
  | "paperclip"
  | "github"
  | "vercel"
  | "s3"
  | "custom";

export type IssueWorkProductStatus =
  | "active"
  | "ready_for_review"
  | "approved"
  | "changes_requested"
  | "merged"
  | "closed"
  | "failed"
  | "archived"
  | "draft";

export type IssueWorkProductReviewState =
  | "none"
  | "needs_board_review"
  | "approved"
  | "changes_requested";

export interface IssueWorkProduct {
  id: string;
  companyId: string;
  projectId: string | null;
  issueId: string;
  executionWorkspaceId: string | null;
  runtimeServiceId: string | null;
  type: IssueWorkProductType;
  provider: IssueWorkProductProvider | string;
  externalId: string | null;
  title: string;
  url: string | null;
  status: IssueWorkProductStatus | string;
  reviewState: IssueWorkProductReviewState;
  isPrimary: boolean;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  summary: string | null;
  metadata: Record<string, unknown> | null;
  createdByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// AgentDash: UX-2 (#783) — the company-wide "Shipped" feed. A work product
// joined to the issue it belongs to, the agent that produced it, and the
// metered usage of every run on that issue. `usage.metered === false` means no
// cost event was ever recorded for the issue: show "not metered yet", never 0.
export interface ShippedIssueUsage {
  metered: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface ShippedWorkProduct extends IssueWorkProduct {
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    projectId: string | null;
  };
  agent: { id: string; name: string } | null;
  usage: ShippedIssueUsage;
}

export interface ShippedMonthTotal {
  /** First instant of the current UTC month, ISO. */
  since: string;
  count: number;
  pullRequests: number;
  /** Usage summed over the distinct issues that shipped this month. */
  usage: ShippedIssueUsage;
}

export interface ShippedFeed {
  items: ShippedWorkProduct[];
  /** Everything the filters match, ignoring the cursor. */
  total: number;
  /** Pass back as `before` to read the next page; null on the last page. */
  nextCursor: string | null;
  monthTotal: ShippedMonthTotal;
}
