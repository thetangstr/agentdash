// AgentDash (scan 3 lane L): the one way the UI reads /billing/status.
//
// Three readers (the trial banner in Layout, the upgrade modal, the Billing
// page) each fetched it on their own: the banner on every mount with no
// cache and no catch. Billing routes sit behind a 20-per-15-minutes limiter,
// so ordinary navigation ran it out and every further mount added a 429 and
// an uncaught "ApiError: Rate limited" page error (122 of each in one
// session). Now every reader shares one cache entry, refreshes rarely, never
// retries a 429 and waits out the server's Retry-After before asking again.
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { billingApi, type BillingStatus } from "../api/billing";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";

/** Plan state changes rarely (checkout, a webhook, a trial ending). */
export const BILLING_STATUS_STALE_MS = 5 * 60_000;
/** Background refresh while a reader is mounted. */
export const BILLING_STATUS_REFRESH_MS = 10 * 60_000;
/** Wait at least this long after a 429 that carries no Retry-After. */
export const BILLING_RATE_LIMIT_MIN_BACKOFF_MS = 60_000;
/** And never longer than the limiter's own window. */
export const BILLING_RATE_LIMIT_MAX_BACKOFF_MS = 15 * 60_000;

export function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && error.status === 429;
}

/**
 * Retry only what a retry can fix: a dropped connection or a 5xx, twice. A 429
 * means "stop asking", and any other 4xx will answer the same way again.
 */
export function shouldRetryBillingStatus(failureCount: number, error: unknown): boolean {
  if (!(error instanceof ApiError)) return failureCount < 2;
  if (error.status === 0 || error.status >= 500) return failureCount < 2;
  return false;
}

/** How long to wait before asking again after `error`. */
export function billingStatusBackoffMs(error: unknown): number {
  if (isRateLimited(error)) {
    const retryAfter = (error as ApiError).retryAfterMs ?? 0;
    return Math.min(
      Math.max(retryAfter, BILLING_RATE_LIMIT_MIN_BACKOFF_MS),
      BILLING_RATE_LIMIT_MAX_BACKOFF_MS,
    );
  }
  return BILLING_RATE_LIMIT_MIN_BACKOFF_MS;
}

/** The refresh interval for a mounted reader: back off while failing. */
export function billingStatusRefetchInterval(state: { status: string; error: unknown }): number {
  return state.status === "error" ? billingStatusBackoffMs(state.error) : BILLING_STATUS_REFRESH_MS;
}

/** The fetch itself: the shared key, the request, and the retry rule. */
function billingStatusFetch(companyId: string) {
  return {
    queryKey: queryKeys.billing.status(companyId),
    queryFn: () => billingApi.status(companyId),
    retry: shouldRetryBillingStatus,
  };
}

export function useBillingStatus(companyId: string | null | undefined, enabled = true) {
  return useQuery<BillingStatus>({
    ...billingStatusFetch(companyId ?? ""),
    enabled: Boolean(companyId) && enabled,
    staleTime: BILLING_STATUS_STALE_MS,
    refetchOnWindowFocus: false,
    // An errored query would otherwise refetch on every new mount, which is
    // exactly how a 429 turned into a storm.
    retryOnMount: false,
    refetchInterval: (query) => billingStatusRefetchInterval(query.state),
  });
}

/** A fresh read that also updates every reader (the Billing page's post-checkout poll). */
export function fetchFreshBillingStatus(queryClient: QueryClient, companyId: string) {
  return queryClient.fetchQuery({ ...billingStatusFetch(companyId), staleTime: 0 });
}
