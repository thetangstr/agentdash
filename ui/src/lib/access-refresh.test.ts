import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESS_REFRESH_TIMEOUT_MS, refreshAccessQueries } from "./access-refresh";

afterEach(() => {
  vi.useRealTimers();
});

describe("refreshAccessQueries", () => {
  it("refetches the cached access queries, including inactive ones", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const boardAccess = vi.fn().mockResolvedValueOnce({ companyIds: [] }).mockResolvedValue({ companyIds: ["c1"] });
    await qc.prefetchQuery({ queryKey: ["access", "current-board-access"], queryFn: boardAccess });

    await refreshAccessQueries(qc);

    expect(boardAccess).toHaveBeenCalledTimes(2);
    expect(qc.getQueryData(["access", "current-board-access"])).toEqual({ companyIds: ["c1"] });
  });

  it("does not throw when a refetch fails", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const health = vi.fn().mockResolvedValueOnce({ status: "ok" }).mockRejectedValue(new Error("410"));
    await qc.prefetchQuery({ queryKey: ["health"], queryFn: health });

    await expect(refreshAccessQueries(qc)).resolves.toBeUndefined();
  });

  it("gives up after the timeout when a fetch never settles, so navigation is not blocked", async () => {
    vi.useFakeTimers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const never = vi.fn().mockResolvedValueOnce({ status: "ok" }).mockImplementation(() => new Promise(() => {}));
    await qc.prefetchQuery({ queryKey: ["health"], queryFn: never });

    let settled = false;
    const refresh = refreshAccessQueries(qc).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(ACCESS_REFRESH_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await refresh;
    expect(settled).toBe(true);
    expect(never).toHaveBeenCalledTimes(2);
    // The query stays invalidated, so the gate refetches it on its own.
    expect(qc.getQueryState(["health"])?.isInvalidated).toBe(true);
  });
});
