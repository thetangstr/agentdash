import { describe, expect, it } from "vitest";
import {
  listServerAdapters,
  getServerAdapter,
  findServerAdapter,
} from "../adapters/index.js";

describe("adapter registry contract", () => {
  it("registers all expected builtin adapters", () => {
    const types = listServerAdapters().map((a) => a.type);
    const expected = [
      "claude_local",
      "codex_local",
      "cursor",
      "gemini_local",
      "hermes_local",
      "opencode_local",
      "pi_local",
      "process",
      "http",
    ];
    for (const type of expected) {
      expect(types).toContain(type);
    }
  });

  it("every registered adapter has an execute function", () => {
    for (const adapter of listServerAdapters()) {
      expect(typeof adapter.execute).toBe("function");
    }
  });

  it("getServerAdapter returns a real adapter for known types", () => {
    const adapter = getServerAdapter("process");
    expect(adapter.type).toBe("process");
  });

  it("getServerAdapter falls back to process adapter for unknown types", () => {
    const adapter = getServerAdapter("nonexistent_type_xyz");
    expect(adapter.type).toBe("process");
  });

  it("findServerAdapter returns null for unknown types", () => {
    expect(findServerAdapter("nonexistent_type_xyz")).toBeNull();
  });

  it("registry code does not bake machine-specific absolute paths into defaults", () => {
    // The registry must not hardcode paths like /Users/maxiaoer/... as
    // fallback defaults — those break on every non-mini deployment (cloud,
    // on-prem, dev machines). This test fails if someone reintroduces them.
    for (const adapter of listServerAdapters()) {
      // Adapters with models are fine; we check the source via toString.
      const src = adapter.execute.toString();
      expect(src).not.toMatch(/\/Users\/maxiaoer/);
    }
  });
});
