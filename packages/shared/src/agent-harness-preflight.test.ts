import { describe, expect, it } from "vitest";
import { isBlockingPreflightResult, isBlockingPreflightWarnCode } from "./agent-harness-preflight.js";

const warn = (code: string) => ({ code, level: "warn" as const, message: "warn" });

describe("isBlockingPreflightWarnCode", () => {
  it("flags adapter probe failures and missing auth", () => {
    for (const code of [
      "claude_hello_probe_auth_required",
      "codex_hello_probe_auth_required",
      "cursor_hello_probe_auth_required",
      "gemini_hello_probe_auth_required",
      "opencode_hello_probe_auth_required",
      "pi_hello_probe_auth_required",
      "claude_hello_probe_failed",
      "codex_hello_probe_failed",
      "hermes_no_api_keys",
    ]) {
      expect(isBlockingPreflightWarnCode(code), code).toBe(true);
    }
  });

  it("leaves advisory warnings alone", () => {
    for (const code of ["no_llm_keys", "claude_hello_probe_timed_out", "hermes_python_old", "custom_warning"]) {
      expect(isBlockingPreflightWarnCode(code), code).toBe(false);
    }
  });
});

describe("isBlockingPreflightResult", () => {
  it("blocks on fail regardless of checks", () => {
    expect(isBlockingPreflightResult({ status: "fail", checks: [] })).toBe(true);
  });

  it("blocks on a warn carrying a blocking check code", () => {
    expect(
      isBlockingPreflightResult({
        status: "warn",
        checks: [warn("claude_hello_probe_auth_required")],
      }),
    ).toBe(true);
    expect(
      isBlockingPreflightResult({
        status: "warn",
        checks: [warn("hermes_no_api_keys")],
      }),
    ).toBe(true);
  });

  it("lets a warn with only advisory checks pass", () => {
    expect(
      isBlockingPreflightResult({
        status: "warn",
        checks: [warn("no_llm_keys")],
      }),
    ).toBe(false);
  });

  it("ignores blocking codes that are not warnings", () => {
    // The same code downgraded to info (configured Hermes) must not block.
    expect(
      isBlockingPreflightResult({
        status: "warn",
        checks: [
          { code: "hermes_no_api_keys", level: "info", message: "configured" },
          warn("no_llm_keys"),
        ],
      }),
    ).toBe(false);
  });

  it("does not block on pass, missing checks, or no result", () => {
    expect(isBlockingPreflightResult({ status: "pass" })).toBe(false);
    expect(isBlockingPreflightResult({ status: "warn", checks: null })).toBe(false);
    expect(isBlockingPreflightResult({ status: "warn" })).toBe(false);
    expect(isBlockingPreflightResult(null)).toBe(false);
    expect(isBlockingPreflightResult(undefined)).toBe(false);
  });
});
