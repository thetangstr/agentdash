import { describe, expect, it } from "vitest";
import { describeRuntimeDirectiveDelivery } from "../adapters/runtime-directives-support.js";

/**
 * AgentDash (AGE-2): the push route must never report "pushed" as if it meant
 * "applied". This pins the delivery answer per adapter family.
 */
describe("runtime directive delivery", () => {
  it("every prompt-rendering adapter reports delivery into the prompt", () => {
    for (const type of [
      "acpx_local",
      "claude_local",
      "codex_local",
      "cursor",
      "gemini_local",
      "opencode_local",
      "pi_local",
      "openclaw_gateway",
      "hermes_local",
    ]) {
      expect(describeRuntimeDirectiveDelivery(type)).toMatchObject({ adapterType: type, delivered: true, via: "prompt" });
    }
  });

  it("the http adapter forwards the context and says so", () => {
    expect(describeRuntimeDirectiveDelivery("http")).toMatchObject({ delivered: true, via: "context" });
  });

  it("the process adapter and unknown adapters are reported as undelivered", () => {
    for (const type of ["process", "some_external_adapter"]) {
      const delivery = describeRuntimeDirectiveDelivery(type);
      expect(delivery).toMatchObject({ adapterType: type, delivered: false, via: null });
      expect(delivery.detail).toContain("will not see them");
    }
  });
});
