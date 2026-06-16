import { describe, it, expect } from "vitest";
import { BEATS } from "./feeds.js";

describe("BEATS", () => {
  it("defines 18 beats", () => {
    expect(BEATS).toHaveLength(18);
  });
  it("has unique slugs and at least one feed each", () => {
    const slugs = new Set(BEATS.map((b) => b.slug));
    expect(slugs.size).toBe(18);
    for (const b of BEATS) {
      expect(b.feeds.length).toBeGreaterThan(0);
      for (const url of b.feeds) expect(url).toMatch(/^https?:\/\//);
      expect(b.clockchainTool).toMatch(/^[a-z_]+$/);
    }
  });
});
