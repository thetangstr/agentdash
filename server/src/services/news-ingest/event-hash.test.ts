import { describe, it, expect } from "vitest";
import { canonicalEventHash, sourceUrlHash } from "./event-hash.js";

describe("event-hash", () => {
  it("sourceUrlHash normalizes tracking params + case", () => {
    const a = sourceUrlHash("https://Ex.com/a?utm_source=x&id=1");
    const b = sourceUrlHash("https://ex.com/a?id=1");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("canonicalEventHash is stable regardless of key order", () => {
    const h1 = canonicalEventHash({ title: "T", beat: "x", sourceUrl: "u", occurredAt: "2026-06-14" });
    const h2 = canonicalEventHash({ occurredAt: "2026-06-14", sourceUrl: "u", beat: "x", title: "T" });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});
