// AgentDash (AGE-121): Tests for the run-quota enforcement gate.

import { describe, expect, it } from "vitest";
import {
  decideQuota,
  quotaExceededPayload,
  type QuotaDecision,
} from "../services/quota-enforcement.js";
import type { QuotaSnapshot } from "../services/quota.js";

function makeSnapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    tier: "free",
    includedRuns: 50,
    usedRuns: 0,
    remainingRuns: 50,
    overageRuns: 0,
    seatsCount: 0,
    billingPeriodStart: "2026-06-01T00:00:00.000Z",
    billingPeriodEnd: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// decideQuota — pure decision function
// ---------------------------------------------------------------------------

describe("decideQuota", () => {
  // --- Free tier ---

  it("allows a free workspace with remaining runs", () => {
    const result = decideQuota(makeSnapshot({ tier: "free", remainingRuns: 25 }));
    expect(result.allowed).toBe(true);
    expect(result.isOverage).toBe(false);
  });

  it("blocks a free workspace at exactly 0 remaining runs", () => {
    const result = decideQuota(
      makeSnapshot({ tier: "free", remainingRuns: 0, usedRuns: 50, includedRuns: 50 }),
    );
    expect(result.allowed).toBe(false);
    expect(result.isOverage).toBe(false);
  });

  it("blocks a free workspace with overageRuns > 0 and remainingRuns = 0", () => {
    const result = decideQuota(
      makeSnapshot({
        tier: "free",
        remainingRuns: 0,
        usedRuns: 55,
        includedRuns: 50,
        overageRuns: 5,
      }),
    );
    expect(result.allowed).toBe(false);
  });

  // --- Pro tier (active) ---

  it("allows a pro_active workspace with remaining runs (no overage)", () => {
    const result = decideQuota(
      makeSnapshot({ tier: "pro_active", remainingRuns: 500, includedRuns: 1000 }),
    );
    expect(result.allowed).toBe(true);
    expect(result.isOverage).toBe(false);
  });

  it("allows a pro_active workspace at 0 remaining — flags as overage", () => {
    const result = decideQuota(
      makeSnapshot({
        tier: "pro_active",
        remainingRuns: 0,
        usedRuns: 1250,
        includedRuns: 1250,
        overageRuns: 0,
      }),
    );
    expect(result.allowed).toBe(true);
    expect(result.isOverage).toBe(true);
  });

  it("allows a pro_active workspace past included — flags as overage", () => {
    const result = decideQuota(
      makeSnapshot({
        tier: "pro_active",
        remainingRuns: 0,
        usedRuns: 1500,
        includedRuns: 1250,
        overageRuns: 250,
      }),
    );
    expect(result.allowed).toBe(true);
    expect(result.isOverage).toBe(true);
  });

  // --- Pro tier (trial) ---

  it("allows a pro_trial workspace at 0 remaining — flags as overage", () => {
    const result = decideQuota(
      makeSnapshot({
        tier: "pro_trial",
        remainingRuns: 0,
        usedRuns: 1000,
        includedRuns: 1000,
      }),
    );
    expect(result.allowed).toBe(true);
    expect(result.isOverage).toBe(true);
  });

  // --- Pro past due (NOT a live pro tier — treated like free) ---

  it("blocks a pro_past_due workspace at 0 remaining (not a live pro tier)", () => {
    const result = decideQuota(
      makeSnapshot({
        tier: "pro_past_due",
        remainingRuns: 0,
        usedRuns: 50,
        includedRuns: 50,
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.isOverage).toBe(false);
  });

  // --- Edge: exactly 1 remaining ---

  it("allows with exactly 1 remaining run (any tier)", () => {
    const freeResult = decideQuota(makeSnapshot({ tier: "free", remainingRuns: 1 }));
    expect(freeResult.allowed).toBe(true);
    expect(freeResult.isOverage).toBe(false);

    const proResult = decideQuota(makeSnapshot({ tier: "pro_active", remainingRuns: 1 }));
    expect(proResult.allowed).toBe(true);
    expect(proResult.isOverage).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// quotaExceededPayload
// ---------------------------------------------------------------------------

describe("quotaExceededPayload", () => {
  it("returns a structured 402-style error payload", () => {
    const snapshot = makeSnapshot({
      tier: "free",
      usedRuns: 50,
      includedRuns: 50,
      remainingRuns: 0,
    });
    const payload = quotaExceededPayload(snapshot);
    expect(payload).toEqual({
      error: "quota_exceeded",
      tier: "free",
      used: 50,
      included: 50,
      upgrade_url: "/billing",
    });
  });

  it("reflects actual usage for pro tier", () => {
    const snapshot = makeSnapshot({
      tier: "pro_active",
      usedRuns: 1500,
      includedRuns: 1250,
    });
    const payload = quotaExceededPayload(snapshot);
    expect(payload.used).toBe(1500);
    expect(payload.included).toBe(1250);
    expect(payload.tier).toBe("pro_active");
  });
});
