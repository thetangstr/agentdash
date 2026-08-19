import { afterEach, describe, expect, it } from "vitest";
import { nextFallbackHop, readFallbackChain } from "../lib/adapter-fallback-chain.js";

const originalChain = process.env.AGENTDASH_FALLBACK_CHAIN;

afterEach(() => {
  if (originalChain === undefined) {
    delete process.env.AGENTDASH_FALLBACK_CHAIN;
  } else {
    process.env.AGENTDASH_FALLBACK_CHAIN = originalChain;
  }
});

describe("readFallbackChain", () => {
  it("returns [] when unset or blank", () => {
    delete process.env.AGENTDASH_FALLBACK_CHAIN;
    expect(readFallbackChain()).toEqual([]);
    process.env.AGENTDASH_FALLBACK_CHAIN = "   ";
    expect(readFallbackChain()).toEqual([]);
  });

  it("parses adapter[:model] entries, tolerating whitespace and empties", () => {
    process.env.AGENTDASH_FALLBACK_CHAIN = " hermes_local:k3 , hermes_local:glm-5.3 ,, claude_api ";
    expect(readFallbackChain()).toEqual([
      { adapter: "hermes_local", model: "k3" },
      { adapter: "hermes_local", model: "glm-5.3" },
      { adapter: "claude_api" },
    ]);
  });

  it("skips hops with unknown adapter types instead of failing the chain", () => {
    process.env.AGENTDASH_FALLBACK_CHAIN = "definitely_not_an_adapter:x,hermes_local:k3";
    expect(readFallbackChain()).toEqual([{ adapter: "hermes_local", model: "k3" }]);
  });
});

describe("nextFallbackHop", () => {
  const chain = [
    { adapter: "hermes_local", model: "k3" },
    { adapter: "hermes_local", model: "glm-5.3" },
  ];

  it("returns the first hop for a caller not in the chain (the primary)", () => {
    expect(nextFallbackHop(chain, { adapter: "codex_local", model: "gpt-5.6-terra" })).toEqual({
      adapter: "hermes_local",
      model: "k3",
    });
  });

  it("advances a caller sitting on a hop to the next hop", () => {
    expect(nextFallbackHop(chain, { adapter: "hermes_local", model: "k3" })).toEqual({
      adapter: "hermes_local",
      model: "glm-5.3",
    });
  });

  it("returns null when the chain is exhausted", () => {
    expect(nextFallbackHop(chain, { adapter: "hermes_local", model: "glm-5.3" })).toBeNull();
  });

  it("treats null/undefined/empty model as the same adapter-default position", () => {
    const modelless = [{ adapter: "opencode_local" }, { adapter: "hermes_local", model: "k3" }];
    expect(nextFallbackHop(modelless, { adapter: "opencode_local", model: null })).toEqual({
      adapter: "hermes_local",
      model: "k3",
    });
  });

  it("returns null rather than a hop identical to the current position", () => {
    expect(
      nextFallbackHop([{ adapter: "hermes_local", model: "k3" }], {
        adapter: "hermes_local",
        model: "k3",
      }),
    ).toBeNull();
  });

  it("returns null for an empty chain", () => {
    expect(nextFallbackHop([], { adapter: "codex_local" })).toBeNull();
  });
});
