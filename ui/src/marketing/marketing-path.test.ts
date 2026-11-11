import { describe, expect, it } from "vitest";
import { isMarketingPath } from "./marketing-path";
describe("marketing route classification", () => {
  it("keeps launch posts and nested paths free of the product connection overlay", () => {
    for (const path of ["/whats-new", "/whats-new/", "/whats-new/launch-week", "/whats-new/future/post", "/demo", "/agent-performance", "/how-it-works", "/docs/setup/"]) expect(isMarketingPath(path), path).toBe(true);
    for (const path of ["/whats-newish", "/ACME/whats-new", "/ACME/dashboard"]) expect(isMarketingPath(path), path).toBe(false);
  });
  it("keeps the public release notes free of the product connection overlay", () => {
    for (const path of ["/releases", "/releases/", "/releases/v2026.1105.0"]) expect(isMarketingPath(path), path).toBe(true);
    for (const path of ["/releasesx", "/ACME/releases", "/instance/settings/changelog"]) expect(isMarketingPath(path), path).toBe(false);
  });
});
