import { describe, it, expect } from "vitest";
import { computeProgress } from "../useDescentProgress";

describe("computeProgress", () => {
  it("returns 0 when the section top is at viewport top (just entering)", () => {
    expect(computeProgress({ top: 0, height: 7000 }, 1000)).toBe(0);
  });

  it("returns ~1 when the section bottom aligns with viewport bottom (last layer settled)", () => {
    expect(computeProgress({ top: -(7000 - 1000), height: 7000 }, 1000)).toBeCloseTo(1, 5);
  });

  it("returns 0.5 at the midpoint of the pinned travel", () => {
    expect(computeProgress({ top: -(7000 - 1000) / 2, height: 7000 }, 1000)).toBeCloseTo(0.5, 5);
  });

  it("clamps to 0 when section is below the viewport", () => {
    expect(computeProgress({ top: 500, height: 7000 }, 1000)).toBe(0);
  });

  it("clamps to 1 when section is fully scrolled past", () => {
    expect(computeProgress({ top: -10000, height: 7000 }, 1000)).toBe(1);
  });
});
