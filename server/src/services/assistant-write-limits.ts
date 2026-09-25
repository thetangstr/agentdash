/**
 * AgentDash assistant MCP (GH #678, spec §7.1): the per-grant write budget
 * the work toolset lives under — at most 30 writes and 10 newly created tasks
 * per rolling hour, because every write can queue a paid agent run.
 *
 * The counters are in-memory, one map per process, exactly like the `pcin_`
 * loopback registry beside it: the limit exists to bound assistant-driven
 * churn, not to survive a deploy. A restart opens a fresh hour — the failure
 * direction is a momentarily wider window, not locked-out users, which is the
 * acceptable side for a limiter whose job is "a person did not ask for this
 * much work."
 *
 * Counting happens on ADMISSION, before the route runs: a write the route
 * later rejects still consumed its slot, so a caller cannot keep a window
 * permanently fresh by sending requests that fail validation. The grant id —
 * not the loopback token or the client id — is the key, so rotating access
 * tokens cannot reset the budget.
 */

import {
  ASSISTANT_TASK_CREATE_LIMIT_PER_HOUR,
  ASSISTANT_WRITE_LIMIT_PER_HOUR,
} from "@paperclipai/shared";

const WINDOW_MS = 60 * 60 * 1000;
const MAX_GRANT_BUCKETS = 10_000;

interface GrantBucket {
  writes: number[];
  taskCreates: number[];
}

const buckets = new Map<string, GrantBucket>();

function pruneTimestamps(timestamps: number[], windowStart: number): number[] {
  const firstLive = timestamps.findIndex((ts) => ts > windowStart);
  if (firstLive < 0) return [];
  return firstLive === 0 ? timestamps : timestamps.slice(firstLive);
}

export type AssistantWriteLimitResult =
  | { allowed: true }
  | {
      allowed: false;
      /** Which ceiling the write hit — "writes" (30/h) or "taskCreates" (10/h). */
      limit: "writes" | "taskCreates";
      retryAfterSeconds: number;
    };

/**
 * Check the grant's hourly budget and, when a slot remains, record the write.
 * Returns the refusal shape when either ceiling is reached; nothing is
 * recorded for a refused attempt so the refusal itself is free.
 */
export function consumeAssistantWriteAllowance(
  grantId: string,
  opts: { taskCreate?: boolean; now?: number } = {},
): AssistantWriteLimitResult {
  const now = opts.now ?? Date.now();
  const windowStart = now - WINDOW_MS;
  if (buckets.size >= MAX_GRANT_BUCKETS) {
    for (const [key, bucket] of buckets) {
      bucket.writes = pruneTimestamps(bucket.writes, windowStart);
      bucket.taskCreates = pruneTimestamps(bucket.taskCreates, windowStart);
      if (bucket.writes.length === 0 && bucket.taskCreates.length === 0) buckets.delete(key);
    }
  }
  const bucket = buckets.get(grantId) ?? { writes: [], taskCreates: [] };
  bucket.writes = pruneTimestamps(bucket.writes, windowStart);
  bucket.taskCreates = pruneTimestamps(bucket.taskCreates, windowStart);
  buckets.set(grantId, bucket);

  if (opts.taskCreate && bucket.taskCreates.length >= ASSISTANT_TASK_CREATE_LIMIT_PER_HOUR) {
    return {
      allowed: false,
      limit: "taskCreates",
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.taskCreates[0]! + WINDOW_MS - now) / 1000)),
    };
  }
  if (bucket.writes.length >= ASSISTANT_WRITE_LIMIT_PER_HOUR) {
    return {
      allowed: false,
      limit: "writes",
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.writes[0]! + WINDOW_MS - now) / 1000)),
    };
  }

  bucket.writes.push(now);
  if (opts.taskCreate) bucket.taskCreates.push(now);
  return { allowed: true };
}

/** Test isolation — the counters are module-level state. */
export function resetAssistantWriteLimits(): void {
  buckets.clear();
}
