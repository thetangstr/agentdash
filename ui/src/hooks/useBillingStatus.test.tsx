// @vitest-environment jsdom
// AgentDash (scan 3 lane L): /billing/status was hit 122 times in one session,
// each a 429 and an uncaught page error. These pin the shape that stops it:
// one shared request, no retry on 429, no refetch on remount after a failure.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStatus = vi.hoisted(() => vi.fn());
vi.mock("../api/billing", () => ({
  billingApi: { status: mockStatus, startCheckout: vi.fn(), openPortal: vi.fn() },
}));

import { ApiError } from "../api/client";
import {
  BILLING_RATE_LIMIT_MAX_BACKOFF_MS,
  BILLING_RATE_LIMIT_MIN_BACKOFF_MS,
  BILLING_STATUS_REFRESH_MS,
  billingStatusBackoffMs,
  billingStatusRefetchInterval,
  shouldRetryBillingStatus,
  useBillingStatus,
} from "./useBillingStatus";
import { TrialBanner } from "../components/TrialBanner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Reader({ companyId }: { companyId: string }) {
  const { data, error } = useBillingStatus(companyId);
  return <span>{data ? data.tier : error ? "error" : "loading"}</span>;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe("billing status retry and backoff rules", () => {
  it("never retries a 429 or another 4xx", () => {
    expect(shouldRetryBillingStatus(0, new ApiError("Rate limited", 429, null))).toBe(false);
    expect(shouldRetryBillingStatus(0, new ApiError("Forbidden", 403, null))).toBe(false);
    expect(shouldRetryBillingStatus(0, new ApiError("Not found", 404, null))).toBe(false);
  });

  it("retries a dropped connection or a 5xx at most twice", () => {
    expect(shouldRetryBillingStatus(0, new ApiError("down", 503, null))).toBe(true);
    expect(shouldRetryBillingStatus(1, new ApiError("offline", 0, null))).toBe(true);
    expect(shouldRetryBillingStatus(2, new ApiError("down", 500, null))).toBe(false);
  });

  it("waits out Retry-After, within sane bounds", () => {
    expect(billingStatusBackoffMs(new ApiError("Rate limited", 429, null, 120_000))).toBe(120_000);
    expect(billingStatusBackoffMs(new ApiError("Rate limited", 429, null, 1_000))).toBe(
      BILLING_RATE_LIMIT_MIN_BACKOFF_MS,
    );
    expect(billingStatusBackoffMs(new ApiError("Rate limited", 429, null, 3_600_000))).toBe(
      BILLING_RATE_LIMIT_MAX_BACKOFF_MS,
    );
    expect(billingStatusBackoffMs(new ApiError("Rate limited", 429, null))).toBe(BILLING_RATE_LIMIT_MIN_BACKOFF_MS);
  });

  it("refreshes rarely when healthy and backs off when failing", () => {
    expect(billingStatusRefetchInterval({ status: "success", error: null })).toBe(BILLING_STATUS_REFRESH_MS);
    expect(
      billingStatusRefetchInterval({ status: "error", error: new ApiError("Rate limited", 429, null, 900_000) }),
    ).toBe(900_000);
  });
});

describe("useBillingStatus", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let client: QueryClient;

  beforeEach(() => {
    mockStatus.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  });

  it("shares one request between every reader, the trial banner included", async () => {
    mockStatus.mockResolvedValue({ tier: "free", seatsPaid: 0, periodEnd: null });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <TrialBanner companyId="c1" />
          <Reader companyId="c1" />
          <Reader companyId="c1" />
        </QueryClientProvider>,
      );
    });
    await flush();
    expect(mockStatus).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("free");
  });

  it("asks once on a 429, and a remount does not ask again", async () => {
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    mockStatus.mockRejectedValue(new ApiError("Rate limited", 429, { error: "Rate limited" }, 900_000));
    const tree = (show: boolean) => (
      <QueryClientProvider client={client}>
        {show ? <TrialBanner companyId="c1" /> : null}
        {show ? <Reader companyId="c1" /> : null}
      </QueryClientProvider>
    );
    await act(async () => {
      root.render(tree(true));
    });
    await flush();
    expect(mockStatus).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("error");
    // The banner renders nothing on a failed read.
    expect(container.querySelector(".trial-banner")).toBeNull();

    // Navigation remounts the layout: an errored query must not refetch on mount.
    await act(async () => {
      root.render(tree(false));
    });
    await act(async () => {
      root.render(tree(true));
    });
    await flush();
    expect(mockStatus).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });
});
