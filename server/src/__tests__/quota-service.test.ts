import { describe, expect, it, vi } from "vitest";
import { computeIncludedRuns } from "../services/quota.js";

describe("computeIncludedRuns", () => {
  it("returns 50 for free tier", () => {
    expect(computeIncludedRuns("free", 0)).toBe(50);
  });

  it("returns 50 for free tier even if seats are somehow set", () => {
    expect(computeIncludedRuns("free", 5)).toBe(50);
  });

  it("returns 1000 base for pro_active with 0 seats", () => {
    expect(computeIncludedRuns("pro_active", 0)).toBe(1_000);
  });

  it("adds 250 per paid seat for pro_active", () => {
    expect(computeIncludedRuns("pro_active", 1)).toBe(1_250);
    expect(computeIncludedRuns("pro_active", 4)).toBe(2_000);
    expect(computeIncludedRuns("pro_active", 10)).toBe(3_500);
  });

  it("returns pro allotment for pro_trial tier", () => {
    expect(computeIncludedRuns("pro_trial", 1)).toBe(1_250);
  });

  it("returns free allotment for pro_canceled tier", () => {
    // pro_canceled is NOT a live Pro tier, so it falls back to free
    expect(computeIncludedRuns("pro_canceled", 5)).toBe(50);
  });

  it("returns free allotment for pro_past_due tier", () => {
    expect(computeIncludedRuns("pro_past_due", 3)).toBe(50);
  });

  it("returns free allotment for unknown tier", () => {
    expect(computeIncludedRuns("unknown_tier", 0)).toBe(50);
  });

  it("seat count adjustment changes pro allotment in real-time", () => {
    // Simulates: workspace starts with 2 seats, upgrades to 5
    const before = computeIncludedRuns("pro_active", 2);
    const after = computeIncludedRuns("pro_active", 5);
    expect(before).toBe(1_500); // 1000 + 2*250
    expect(after).toBe(2_250);  // 1000 + 5*250
    expect(after - before).toBe(750); // +3 seats * 250
  });
});
