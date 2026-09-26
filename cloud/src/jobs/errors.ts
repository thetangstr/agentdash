// AgentDash: how a job step tells the runner what kind of failure it hit
// (spec §3.4). Anything else thrown is treated as retryable.
import { RailwayApiError } from "../railway/client.js";

/** Never retry: a safety rule refused (e.g. a deployed box missing its secrets). The job goes `dead` and ops is paged. */
export class FatalJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalJobError";
  }
}

/** Retry, optionally after a specific delay. */
export class RetryableJobError extends Error {
  readonly delayMs: number | null;
  constructor(message: string, delayMs: number | null = null) {
    super(message);
    this.name = "RetryableJobError";
    this.delayMs = delayMs;
  }
}

export class StepTimeoutError extends Error {
  constructor(step: string, ms: number) {
    super(`step ${step} timed out after ${Math.round(ms / 1000)} s`);
    this.name = "StepTimeoutError";
  }
}

/** The job ran past its kind's total cap (30 minutes for provision). No retry. */
export class JobCapExceededError extends Error {
  constructor(kind: string, ms: number) {
    super(`${kind} job exceeded its ${Math.round(ms / 60_000)}-minute cap`);
    this.name = "JobCapExceededError";
  }
}

/** This worker no longer holds the job (lease expired and another worker took it). Stop quietly. */
export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`lost the lease on job ${jobId}`);
    this.name = "LeaseLostError";
  }
}

/** Backoff after attempt 1, 2, 3, 4 (spec §3.4: 15 s, 1 min, 4 min, 10 min); 5 attempts in all. */
export const BACKOFF_MS: readonly number[] = [15_000, 60_000, 240_000, 600_000];
export const DEFAULT_MAX_ATTEMPTS = 5;
/** A Retry-After longer than this is clamped (a misbehaving header must not park a job for days). */
export const MAX_RETRY_AFTER_MS = 60 * 60_000;

export function backoffFor(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1]!;
}

export interface RetryDecision {
  delayMs: number;
  /** Rate-limited retries do not use up an attempt (the job's total cap still bounds them). */
  countsAsAttempt: boolean;
}

export function retryDecision(err: unknown, attempt: number): RetryDecision {
  if (err instanceof RailwayApiError && err.rateLimited) {
    const delay = err.retryAfterMs ?? backoffFor(attempt);
    return { delayMs: Math.min(delay, MAX_RETRY_AFTER_MS), countsAsAttempt: false };
  }
  if (err instanceof RetryableJobError && err.delayMs !== null) {
    return { delayMs: Math.min(err.delayMs, MAX_RETRY_AFTER_MS), countsAsAttempt: true };
  }
  return { delayMs: backoffFor(attempt), countsAsAttempt: true };
}
