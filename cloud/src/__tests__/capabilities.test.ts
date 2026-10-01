// GH #800: capabilities are frozen, so nothing can change claim tracking (and so provisioning) at runtime.
import { describe, expect, it } from "vitest";
import { capabilities } from "../capabilities.js";

describe("capabilities", () => {
  it("is frozen with claim tracking on (flipped for the MVP launch, 2026-10-01)", () => {
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(capabilities.claimTrackingReady).toBe(true);
    expect(() => {
      (capabilities as { claimTrackingReady: boolean }).claimTrackingReady = false;
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(capabilities, "claimTrackingReady", { value: false })).toThrow(TypeError);
    expect(capabilities.claimTrackingReady).toBe(true);
  });
});
