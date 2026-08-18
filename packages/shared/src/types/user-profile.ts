import type { IssuePriority, IssueStatus } from "../constants.js";

export interface UserProfileIdentity {
  id: string;
  slug: string;
  name: string | null;
  email: string | null;
  image: string | null;
  membershipRole: string | null;
  membershipStatus: string;
  joinedAt: Date;
}

export interface UserProfileWindowStats {
  key: "last7" | "last30" | "all";
  label: string;
  touchedIssues: number;
  createdIssues: number;
  completedIssues: number;
  assignedOpenIssues: number;
  commentCount: number;
  activityCount: number;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costEventCount: number;
}

export interface UserProfileDailyPoint {
  date: string;
  activityCount: number;
  completedIssues: number;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface UserProfileIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface UserProfileActivitySummary {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

export interface UserProfileAgentUsage {
  agentId: string;
  agentName: string | null;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface UserProfileProviderUsage {
  provider: string;
  biller: string;
  model: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface UserProfileResponse {
  user: UserProfileIdentity;
  /**
   * Has spend ever been measured for this COMPANY — not for this person.
   *
   * The per-person totals below cannot answer the question on their own. A zero
   * on someone's profile has two completely different meanings: "this person
   * has run nothing" and "we do not meter anything here". Reporting the second
   * as the first is a judgement about a colleague's work, made out of a gap in
   * our own instrumentation.
   *
   * Scoped company-wide and deliberately unbounded by date, exactly as
   * `CostSummary.measured` is: once the company has measured anything, a zero
   * for one person is a real zero and should read as one.
   */
  measured: boolean;
  stats: UserProfileWindowStats[];
  daily: UserProfileDailyPoint[];
  recentIssues: UserProfileIssueSummary[];
  recentActivity: UserProfileActivitySummary[];
  topAgents: UserProfileAgentUsage[];
  topProviders: UserProfileProviderUsage[];
}
