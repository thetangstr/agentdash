import { describe, expect, it } from "vitest";
import { isMarketingPath } from "./marketing-path";
describe("marketing route classification", () => {
  it("keeps launch posts and nested paths free of the product connection overlay", () => {
    for (const path of ["/whats-new", "/whats-new/", "/whats-new/launch-week", "/whats-new/future/post", "/demo", "/docs/setup/"]) expect(isMarketingPath(path), path).toBe(true);
    for (const path of ["/whats-newish", "/ACME/whats-new", "/ACME/dashboard"]) expect(isMarketingPath(path), path).toBe(false);
  });
});
