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
  /**
   * AgentDash (c4 trust): distinct agents with terminal runs in the window.
   * `affectedAgents` counts only agents with failures, so an all-green adapter
   * used to render "0 agents" beside a non-zero run count.
   */
  agents: number;
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
  /** Input + output tokens on issue-linked cost events; cached reads excluded. */
  issueLinkedTokens: number;
  /** Cached input reads on the same events, reported separately. */
  issueLinkedCachedTokens: number;
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
    /**
     * AgentDash: input + cached input + output tokens this month. On a BYOK
     * box cost is not metered (cost is billed by the model provider), so Home
     * shows tokens when monthSpendCents is zero and this is not.
     */
    /** Input + output tokens; cached input is not counted. */
    monthTokens: number;
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

// AgentDash: UX-3 (#784) — Home's "Working now": one row per issue an agent
// is running on right now (queued or running heartbeat run), newest first.
// Runs that carry no issue are listed with `issue: null` so the count is the
// honest number of live runs, never a hash-only card.
export interface WorkingNowItem {
  runId: string;
  status: string;
  agent: { id: string; name: string };
  issue: { id: string; identifier: string | null; title: string; status: string } | null;
  /** The latest thing the run said it was doing, clipped; null if nothing yet. */
  lastStep: string | null;
  /** When the run started (or was queued). Elapsed is computed on the client. */
  startedAt: string;
}

export interface WorkingNow {
  items: WorkingNowItem[];
  total: number;
}

// AgentDash: UX-3 (#784) — "Waiting on you", the payload of
// GET /companies/:companyId/assistant/pending-decisions. The web Home and the
// assistant's list_pending_decisions both read this one route, so they agree.
export interface WaitingOnYouDecision {
  approvalId: string;
  kind: string;
  revision?: number;
  askedBy: string | null;
  summary: string;
  relatedItem: { id: string; identifier: string | null; title: string | null } | null;
  waitingSince: string | null;
  canDecide: boolean;
  risk: { level: string; reason?: string } | null;
  /**
   * AgentDash: UX-7 (#788) — what a yes and a no do, in person words, so a
   * Decisions row can state consequences without opening the detail. Same
   * phrasing family the assistant's confirm read-back uses.
   */
  effects?: { approve: string; reject: string };
}

export interface WaitingOnYouTask {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  updatedAt: string;
  /**
   * AgentDash: UX-7 (#788) — the issue's origin (`routine_execution`,
   * `stale_active_run_evaluation`, …). `manual` is the main Decisions list;
   * anything else is machine-generated and groups under "Other activity".
   */
  originKind?: string;
}

export interface WaitingOnYouQuestion {
  interactionId: string;
  issueId: string;
  identifier: string | null;
  issueTitle: string;
  title: string;
  questionSummary: string;
  waitingSince: string;
  answerOwnerUserId: string;
  answerOwnerName: string;
}

/**
 * AgentDash (MVP launch lane B): a deliverable waiting for the person's
 * review — an `in_review` issue they asked for, or one carrying a
 * `ready_for_review` work product. Accepting it is moving the issue to done.
 */
export interface WaitingOnYouReview {
  issueId: string;
  identifier: string | null;
  title: string;
  /** "Review: <title>" */
  summary: string;
  waitingSince: string;
  /** The agent the issue is assigned to, when there is one. */
  submittedBy: string | null;
  /** Work products on the issue still marked `ready_for_review`. */
  readyForReviewCount: number;
  /** The person created the issue. */
  requestedByYou: boolean;
}

export interface WaitingOnYou {
  pendingQuestions: WaitingOnYouQuestion[];
  pendingQuestionsTotal: number;
  /** Deliverables waiting for the person's review (in_review issues). */
  reviewsWaiting?: WaitingOnYouReview[];
  /** Every review waiting, not only those listed. */
  reviewsWaitingTotal?: number;
  decisions: WaitingOnYouDecision[];
  /** Every waiting approval, not only those in `decisions`. */
  total: number;
  shown: number;
  /**
   * Open issues a human filed and assigned to the person — the "Assigned to
   * you" main list on the Decisions page. The server applies the
   * manual-vs-machine split before its item cap, so
   * `total + tasksAssignedToYouTotal` is the canonical "waiting on you"
   * count the Home block, the sidebar badge and list_pending_decisions all
   * share.
   */
  tasksAssignedToYou: WaitingOnYouTask[];
  /** Every manual-origin open issue assigned to the person, not only those listed. */
  tasksAssignedToYouTotal: number;
  /**
   * Machine-filed open issues assigned to the person (routines,
   * evaluations, escalations — any non-`manual` originKind). These are
   * "Other activity" on the Decisions page and never count in the badge.
   */
  otherTasksAssignedToYou: WaitingOnYouTask[];
  /** Every machine-origin open issue assigned to the person, not only those listed. */
  otherTasksAssignedToYouTotal: number;
}
