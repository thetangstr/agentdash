export interface DashboardRunActivityDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

export type DashboardHarnessStatus = "ok" | "warn" | "critical";

export interface DashboardHarnessAdapterHealth {
  adapterType: string;
  status: DashboardHarnessStatus;
  totalRuns: number;
  failedRuns: number;
  failureRatePercent: number;
  affectedAgents: number;
  latestFailureAt: string | null;
  topFailureCategory: string | null;
}

export interface DashboardHarnessHealth {
  windowHours: number;
  overallStatus: DashboardHarnessStatus;
  totalRuns: number;
  failedRuns: number;
  failureRatePercent: number;
  adapters: DashboardHarnessAdapterHealth[];
}

export interface DashboardTaskOutcomeQuality {
  windowDays: number;
  issuesInScope: number;
  issuesWithDefinitionOfDone: number;
  dodCoveragePercent: number;
  reviewedIssues: number;
  passedIssues: number;
  failedIssues: number;
  revisionRequestedIssues: number;
  escalatedIssues: number;
  unreviewedDoneIssues: number;
  acceptanceRatePercent: number;
  greenRunsPendingReview: number;
  greenRunsWithOpenTasks: number;
  issueLinkedSpendCents: number;
  issueLinkedTokens: number;
  spendPerAcceptedIssueCents: number | null;
}

export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  budgets: {
    activeIncidents: number;
    pendingApprovals: number;
    pausedAgents: number;
    pausedProjects: number;
  };
  runActivity: DashboardRunActivityDay[];
  harness: DashboardHarnessHealth;
  taskQuality: DashboardTaskOutcomeQuality;
}
