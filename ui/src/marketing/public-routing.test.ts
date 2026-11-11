import { describe, expect, it } from "vitest";
import vercel from "../../../vercel.json";
describe("public performance routing", () => {
  const fallback = vercel.redirects.find(item => item.source.startsWith("/:path("));
  const pattern = new RegExp(`^${fallback!.source.slice("/:path(".length, -1)}$`);
  it("allows the performance page and customer update through the marketing SPA", () => {
    expect(pattern.test("agent-performance")).toBe(false);
    expect(pattern.test("whats-new/agent-performance")).toBe(false);
  });
  it("allows the release-notes index and version pages through the marketing SPA", () => {
    expect(pattern.test("releases")).toBe(false);
    expect(pattern.test("releases/")).toBe(false);
    // Version paths contain dots, which the fallback never matches.
    expect(pattern.test("releases/v2026.1105.0")).toBe(false);
    expect(pattern.test("releasesx")).toBe(true);
    expect(pattern.test("ACME/releases")).toBe(true);
  });
  it("still sends product paths to workspace discovery", () => {
    expect(pattern.test("ACME/issues/ABC-1")).toBe(true);
    expect(pattern.test("evaluation")).toBe(true);
    expect(fallback?.destination).toBe("/find");
  });
});
