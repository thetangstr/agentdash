import { describe, it, expect } from "vitest";
import { entitlementsForTier, tierAtLeast, TIERS } from "@agentdash/shared";

describe("entitlementsForTier", () => {
  it("returns limits and features for every tier", () => {
    for (const t of TIERS) {
      const e = entitlementsForTier(t);
      expect(e.tier).toBe(t);
      expect(e.limits.agents).toBeGreaterThan(0);
      expect(e.limits.monthlyActions).toBeGreaterThan(0);
      expect(e.limits.pipelines).toBeGreaterThan(0);
      expect(typeof e.features.hubspotSync).toBe("boolean");
      expect(typeof e.features.autoResearch).toBe("boolean");
    }
  });

  it("Pro has more agents than Free", () => {
    expect(entitlementsForTier("pro").limits.agents).toBeGreaterThan(
      entitlementsForTier("free").limits.agents,
    );
  });

  it("Enterprise has more agents than Pro", () => {
    expect(entitlementsForTier("enterprise").limits.agents).toBeGreaterThan(
      entitlementsForTier("pro").limits.agents,
    );
  });

  it("Free does not unlock hubspotSync", () => {
    expect(entitlementsForTier("free").features.hubspotSync).toBe(false);
  });

  it("Pro and Enterprise unlock hubspotSync", () => {
    expect(entitlementsForTier("pro").features.hubspotSync).toBe(true);
    expect(entitlementsForTier("enterprise").features.hubspotSync).toBe(true);
  });

  it("only Enterprise unlocks prioritySupport", () => {
    expect(entitlementsForTier("free").features.prioritySupport).toBe(false);
    expect(entitlementsForTier("pro").features.prioritySupport).toBe(false);
    expect(entitlementsForTier("enterprise").features.prioritySupport).toBe(true);
  });
});

describe("tierAtLeast", () => {
  it("each tier satisfies itself", () => {
    for (const t of TIERS) {
      expect(tierAtLeast(t, t)).toBe(true);
    }
  });

  it("higher tiers satisfy lower tiers", () => {
    expect(tierAtLeast("pro", "free")).toBe(true);
    expect(tierAtLeast("enterprise", "free")).toBe(true);
    expect(tierAtLeast("enterprise", "pro")).toBe(true);
  });

  it("lower tiers do not satisfy higher tiers", () => {
    expect(tierAtLeast("free", "pro")).toBe(false);
    expect(tierAtLeast("free", "enterprise")).toBe(false);
    expect(tierAtLeast("pro", "enterprise")).toBe(false);
  });
});
