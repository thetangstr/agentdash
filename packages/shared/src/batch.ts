/**
 * AgentDash admin powers, part 2: the one batch engine.
 *
 * A batch is a preview of exact records and the exact change to each, a
 * single-use confirmation bound to that preview, then one request per record
 * through the record's own single-record route. These are the shared numbers
 * and words; the engine lives in server/src/services/batch/.
 */

/** Prefix of the in-process, single-use credential each batch item is sent with. Never leaves the server. */
export const BATCH_ITEM_TOKEN_PREFIX = "pcbx_";

/** Records one batch started in the product may hold. */
export const BATCH_MAX_RECORDS_UI = 200;
/** Previews one person may have open (not yet confirmed, cancelled or expired) at once. */
export const BATCH_MAX_OPEN_PREVIEWS_PER_USER = 5;
/** Records one person may confirm in any rolling hour, counted from confirmed batches. */
export const BATCH_MAX_CONFIRMED_RECORDS_PER_HOUR = 1000;
/** How long a preview may be confirmed. */
export const BATCH_PREVIEW_TTL_MS = 15 * 60 * 1000;
/** How long one item's credential lives; it is also spent on first use. */
export const BATCH_ITEM_CREDENTIAL_TTL_MS = 30 * 1000;
/** A sent item with no answer after this long is recorded as unknown, never retried. */
export const BATCH_ITEM_TIMEOUT_MS = 20 * 1000;
/** A running batch stops starting new items after this long. */
export const BATCH_TIME_BUDGET_MS = 10 * 60 * 1000;
/** The runner writes its heartbeat this often. */
export const BATCH_HEARTBEAT_INTERVAL_MS = 5 * 1000;
/** A running batch whose heartbeat is older than this is treated as stopped by the sweeper. */
export const BATCH_HEARTBEAT_STALE_MS = 60 * 1000;
/** How often the sweeper runs (it also runs once at boot). */
export const BATCH_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** Longest per-record reason stored or shown. */
export const BATCH_REASON_MAX_LENGTH = 500;

export const BATCH_ORIGINS = ["ui", "assistant"] as const;
export type BatchOrigin = (typeof BATCH_ORIGINS)[number];

export const BATCH_STATUSES = ["previewed", "running", "completed", "interrupted", "expired", "cancelled"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const BATCH_ITEM_OUTCOMES = ["pending", "applying", "applied", "refused", "failed", "unknown"] as const;
export type BatchItemOutcome = (typeof BATCH_ITEM_OUTCOMES)[number];

/** Outcomes a finished item can have. `unknown` is its own state: never counted as applied or as failed. */
export type BatchItemFinalOutcome = Exclude<BatchItemOutcome, "pending" | "applying">;

export const BATCH_RECONCILE_VERDICTS = ["landed", "did_not_land"] as const;
export type BatchReconcileVerdict = (typeof BATCH_RECONCILE_VERDICTS)[number];

/** Machine-readable reasons the engine itself writes (routes add their own HTTP refusals). */
export const BATCH_REASON_CODES = {
  changedSincePreview: "changed_since_preview",
  noLongerVisible: "no_longer_visible",
  routeRefused: "route_refused",
  routeFailed: "route_failed",
  notSent: "not_sent",
  noAnswer: "no_answer",
  interrupted: "batch_interrupted",
  timeBudget: "batch_time_budget",
  accessEnded: "access_ended",
  /** Applied, but the record now differs from the preview: the route did something else (see `actual`). */
  appliedDifferently: "applied_differently",
  /** Left out at preview: the record's review or approval steps decide this change, not the batch. */
  goesToReviewFirst: "goes_to_review_first",
  /** Left out at preview: a review or approval step is under way, so its workflow decides status and assignee. */
  inReviewNow: "in_review_now",
  /** Left out at preview: the approval is not among those waiting on this person. */
  notWaitingOnYou: "not_waiting_on_you",
  /** Left out at preview: this person may not decide the approval. */
  notYoursToDecide: "not_yours_to_decide",
} as const;
export type BatchReasonCode = (typeof BATCH_REASON_CODES)[keyof typeof BATCH_REASON_CODES];

export interface BatchCounts {
  applied: number;
  refused: number;
  failed: number;
  unknown: number;
  /** Of `applied`: records the route changed differently from the preview. */
  appliedDifferently?: number;
}

export interface BatchPreviewItem {
  itemId: string;
  entityType: string;
  entityId: string;
  /** What a person calls the record, for example "ENG-12 Fix the login page". */
  label: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** Plain consequences worth knowing before applying, for example "Moving it out of done reopens it." Preview only. */
  notes?: string[];
}

export interface BatchPreviewResult {
  /** Null when nothing in the selection would change. */
  batchId: string | null;
  previewDigest: string | null;
  /** Shown once. Only its hash is stored. */
  confirmHandle: string | null;
  expiresAt: string | null;
  kind: string;
  items: BatchPreviewItem[];
  omitted: { notFound: number; noop: number; notDecidable: number };
  /** The records counted as `notDecidable`, each with a plain reason (the person can see them). */
  notDecidable: Array<{ entityType: string; entityId: string; label: string; reasonCode: string; reason: string }>;
}

export interface BatchItemView extends BatchPreviewItem {
  ordinal: number;
  outcome: BatchItemOutcome;
  reasonCode: string | null;
  reason: string | null;
  httpStatus: number | null;
  /**
   * Applied records: the touched fields as they are after the route answered.
   * When `reasonCode` is `applied_differently` they differ from `after`.
   */
  actual: Record<string, unknown> | null;
  appliedAt: string | null;
  reconciledVerdict: BatchReconcileVerdict | null;
  reconciledAt: string | null;
}

export interface BatchView {
  id: string;
  companyId: string;
  kind: string;
  change: Record<string, unknown>;
  origin: BatchOrigin;
  status: BatchStatus;
  createdByUserId: string;
  itemCount: number;
  counts: BatchCounts;
  expiresAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  items?: BatchItemView[];
}

export function emptyBatchCounts(): BatchCounts {
  return { applied: 0, refused: 0, failed: 0, unknown: 0, appliedDifferently: 0 };
}
