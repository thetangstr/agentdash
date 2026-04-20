import { describe, expect, it } from "vitest";
import { getAdapterDisplay } from "../adapter-display-registry.js";

describe("adapter-display-registry availability", () => {
  it("exposes openclaw_gateway as available", () => {
    expect(getAdapterDisplay("openclaw_gateway").comingSoon).toBeFalsy();
  });
  it("exposes process as available", () => {
    expect(getAdapterDisplay("process").comingSoon).toBeFalsy();
  });
  it("exposes http as available", () => {
    expect(getAdapterDisplay("http").comingSoon).toBeFalsy();
  });
});
