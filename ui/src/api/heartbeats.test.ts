import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { heartbeatsApi } from "./heartbeats";
import { clearLocallyStoppedRuns, wasRunStoppedLocally } from "../lib/locallyStoppedRuns";

describe("heartbeatsApi.liveRunsForCompany", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue([]);
  });

  it("keeps the legacy numeric minCount signature", async () => {
    await heartbeatsApi.liveRunsForCompany("company-1", 4);

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/live-runs?minCount=4");
  });

  it("passes minCount and limit options to the company live-runs endpoint", async () => {
    await heartbeatsApi.liveRunsForCompany("company-1", { minCount: 50, limit: 50 });

    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/live-runs?minCount=50&limit=50");
  });
});

describe("heartbeatsApi.cancel", () => {
  beforeEach(() => {
    mockApi.post.mockReset();
    clearLocallyStoppedRuns();
  });

  it("marks the run locally only after the cancel request succeeds", async () => {
    let settled = false;
    mockApi.post.mockImplementation(async () => {
      // The mark must not exist while the request is still in flight.
      expect(wasRunStoppedLocally("run-1")).toBe(false);
      settled = true;
    });

    await heartbeatsApi.cancel("run-1");

    expect(settled).toBe(true);
    expect(mockApi.post).toHaveBeenCalledWith("/heartbeat-runs/run-1/cancel", {});
    expect(wasRunStoppedLocally("run-1")).toBe(true);
  });

  it("does not mark the run locally when the cancel request fails", async () => {
    mockApi.post.mockRejectedValue(new Error("conflict"));

    await expect(heartbeatsApi.cancel("run-2")).rejects.toThrow("conflict");

    // A failed stop must not pin "Stopped by you" on a later cancellation.
    expect(wasRunStoppedLocally("run-2")).toBe(false);
  });
});
