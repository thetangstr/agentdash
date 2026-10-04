import { describe, expect, it } from "vitest";
import { getAdapterLabel, plainRuntimeLabel } from "./adapter-display-registry";

// AgentDash (Scan 3, lane J): where an agent runs, in plain words.
describe("plainRuntimeLabel", () => {
  it("names local harnesses by where they run, not by harness", () => {
    for (const type of ["hermes_local", "claude_local", "codex_local", "cursor"]) {
      expect(plainRuntimeLabel(type)).toBe("Runs on your server");
    }
  });

  it("says another service runs remote adapters", () => {
    expect(plainRuntimeLabel("openclaw_gateway")).toBe("Runs on another service");
    expect(plainRuntimeLabel("http")).toBe("Runs on another service");
  });

  it("falls back to the adapter label for anything else", () => {
    expect(plainRuntimeLabel("process")).toBe(getAdapterLabel("process"));
  });
});
