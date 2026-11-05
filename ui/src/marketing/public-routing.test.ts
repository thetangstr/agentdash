import { describe, expect, it } from "vitest";
import vercel from "../../../vercel.json";
describe("public performance routing", () => {
  const fallback = vercel.redirects.find(item => item.source.startsWith("/:path("));
  const pattern = new RegExp(`^${fallback!.source.slice("/:path(".length, -1)}$`);
  it("allows the performance page and customer update through the marketing SPA", () => {
    expect(pattern.test("agent-performance")).toBe(false);
    expect(pattern.test("whats-new/agent-performance")).toBe(false);
  });
  it("still sends product paths to workspace discovery", () => {
    expect(pattern.test("ACME/issues/ABC-1")).toBe(true);
    expect(pattern.test("evaluation")).toBe(true);
    expect(fallback?.destination).toBe("/find");
  });
});
