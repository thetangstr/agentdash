import { describe, it, expect } from "vitest";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";

describe("sidebar badge routes", () => {
  it("exports a route factory function", () => {
    expect(typeof sidebarBadgeRoutes).toBe("function");
  });

  it("returns an express router", () => {
    const router = sidebarBadgeRoutes({} as any);
    expect(router).toBeDefined();
    expect(typeof router).toBe("function");
  });
});
