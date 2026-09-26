// GH #800: capabilities are frozen, so nothing can turn claim tracking (and so provisioning) on at runtime.
import { describe, expect, it } from "vitest";
import { capabilities } from "../capabilities.js";

describe("capabilities", () => {
  it("is frozen with claim tracking off", () => {
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(capabilities.claimTrackingReady).toBe(false);
    expect(() => {
      (capabilities as { claimTrackingReady: boolean }).claimTrackingReady = true;
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(capabilities, "claimTrackingReady", { value: true })).toThrow(TypeError);
    expect(capabilities.claimTrackingReady).toBe(false);
  });
});
