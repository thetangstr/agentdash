// AgentDash (GH #790): person-facing plan copy.
import { describe, expect, it } from "vitest";
import { planLabel, seatsPhrase } from "./billing-copy";

const NOW = new Date("2026-09-27T12:00:00Z");

describe("planLabel", () => {
  it("renders Free for the free tier", () => {
    expect(planLabel("free", null, NOW)).toBe("Free");
  });

  it("renders Pro trial with days left", () => {
    const end = new Date("2026-10-06T12:00:00Z").toISOString(); // 9 days out
    expect(planLabel("pro_trial", end, NOW)).toBe("Pro trial — 9 days left");
  });

  it("renders Pro trial with one day left", () => {
    const end = new Date("2026-09-28T10:00:00Z").toISOString(); // ~22h out
    expect(planLabel("pro_trial", end, NOW)).toBe("Pro trial — 1 day left");
  });

  it("renders Pro trial ending today when past the end time", () => {
    const end = new Date("2026-09-27T11:00:00Z").toISOString();
    expect(planLabel("pro_trial", end, NOW)).toBe("Pro trial — ends today");
  });

  it("renders Pro trial without a countdown when periodEnd is missing", () => {
    expect(planLabel("pro_trial", null, NOW)).toBe("Pro trial");
  });

  it("renders Pro for the active tier", () => {
    expect(planLabel("pro_active", null, NOW)).toBe("Pro");
  });

  it("renders a payment-past-due phrase for the past-due tier", () => {
    expect(planLabel("pro_past_due", null, NOW)).toBe("Pro — payment past due");
  });

  it("never returns a raw tier identifier for unknown tiers", () => {
    const label = planLabel("enterprise_annual_v2", null, NOW);
    expect(label).not.toContain("enterprise_annual_v2");
    expect(label).toBe("Enterprise Annual V2");
  });
});

describe("seatsPhrase", () => {
  it("uses words for small counts", () => {
    expect(seatsPhrase(0)).toBe("No seats");
    expect(seatsPhrase(1)).toBe("One seat");
    expect(seatsPhrase(2)).toBe("Two seats");
    expect(seatsPhrase(5)).toBe("Five seats");
    expect(seatsPhrase(12)).toBe("Twelve seats");
  });

  it("falls back to digits above the word range", () => {
    expect(seatsPhrase(13)).toBe("13 seats");
  });
});
