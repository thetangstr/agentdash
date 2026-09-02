import { describe, expect, it } from "vitest";
import { getHermesCommandFromContext, normalizeHermesConfig } from "../adapters/registry.js";

/**
 * Ross GLM feasibility test (2026-09-02): an agent whose adapterConfig carries
 * `rossFeasibilityTest: true` must launch through its own hermesCommand (the
 * dedicated rosstest profile wrapper), which the default pre-fill in
 * normalizeHermesConfig would otherwise outrank. Agents WITHOUT the marker keep
 * the exact pre-existing resolution order.
 */

const markedWrapper = "/Users/Kailor/.execos/agentdash-local/ross-feasibility/hermes-rosstest";

describe("ross feasibility hermesCommand honor", () => {
  it("marked agent: the agent's wrapper wins over the instance default", () => {
    const ctx = normalizeHermesConfig({
      config: {},
      agent: { id: "a1", adapterConfig: { hermesCommand: markedWrapper, rossFeasibilityTest: true } },
    });
    expect((ctx.config as Record<string, unknown>).hermesCommand).toBe(markedWrapper);
    expect(getHermesCommandFromContext(ctx as never)).toBe(markedWrapper);
  });

  it("unmarked agent: the instance default still outranks the agent wrapper (unchanged)", () => {
    const ctx = normalizeHermesConfig({
      config: {},
      agent: { id: "a2", adapterConfig: { hermesCommand: markedWrapper } },
    });
    expect((ctx.config as Record<string, unknown>).hermesCommand).toBe("hermes");
    expect(getHermesCommandFromContext(ctx as never)).toBe("hermes");
  });

  it("marked agent without a wrapper: falls back to the default (unchanged)", () => {
    const ctx = normalizeHermesConfig({
      config: {},
      agent: { id: "a3", adapterConfig: { rossFeasibilityTest: true } },
    });
    expect((ctx.config as Record<string, unknown>).hermesCommand).toBe("hermes");
  });

  it("marker present but not strictly true: no honor (unchanged)", () => {
    const ctx = normalizeHermesConfig({
      config: {},
      agent: { id: "a4", adapterConfig: { hermesCommand: markedWrapper, rossFeasibilityTest: "yes" } },
    });
    expect((ctx.config as Record<string, unknown>).hermesCommand).toBe("hermes");
  });

  it("existing config.hermesCommand is never overwritten, marker or not", () => {
    const marked = normalizeHermesConfig({
      config: { hermesCommand: "/explicit" },
      agent: { id: "a5", adapterConfig: { hermesCommand: markedWrapper, rossFeasibilityTest: true } },
    });
    expect((marked.config as Record<string, unknown>).hermesCommand).toBe("/explicit");
  });
});
