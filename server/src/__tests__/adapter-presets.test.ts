import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADAPTER_PRESETS,
  adapterPresetOptions,
  applyAdapterPreset,
  readAdapterStatus,
} from "../services/adapter-presets.js";

// adapter-presets reads/writes process.env and an env file. Both are restored
// per-test so cases are order-independent.
const KEYS = [
  "AGENTDASH_DEFAULT_ADAPTER",
  "ANTHROPIC_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_BASE_URL",
  "OPENAI_COMPAT_MODEL",
  "MINIMAX_API_KEY",
  "PAPERCLIP_E2E_SKIP_LLM",
  "AGENTDASH_ENV_FILE",
  "AGENTDASH_HERMES_COMMAND",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.PAPERCLIP_E2E_SKIP_LLM;
  delete process.env.AGENTDASH_DEFAULT_ADAPTER;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_COMPAT_API_KEY;
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function useTempEnvFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentdash-env-"));
  const path = join(dir, "agentdash.env");
  process.env.AGENTDASH_ENV_FILE = path;
  return path;
}

describe("adapter-presets", () => {
  it("advertises every customer-facing preset, including the adapters actually in use", () => {
    // minimax and hermes were missing while both were the shipped configuration:
    // status reported them correctly as ready, but a user who opened the model
    // screen and picked anything was moved back onto Claude.
    const expected = ["claude", "gemini", "hermes", "minimax", "openai", "stub"];
    expect(adapterPresetOptions().map((o) => o.preset).sort()).toEqual(expected);
    expect([...ADAPTER_PRESETS].sort()).toEqual(expected);
  });

  it("names minimax and hermes rather than reporting them as custom", () => {
    // A screen that calls the running configuration "custom" invites someone to
    // replace it with a listed option.
    process.env.AGENTDASH_DEFAULT_ADAPTER = "minimax";
    process.env.MINIMAX_API_KEY = "mm-key";
    expect(readAdapterStatus()).toMatchObject({ ready: true, preset: "minimax" });

    process.env.AGENTDASH_DEFAULT_ADAPTER = "hermes_local";
    process.env.AGENTDASH_HERMES_COMMAND = "/bin/sh";
    expect(readAdapterStatus()).toMatchObject({ ready: true, preset: "hermes" });
  });

  it("pins the MiniMax preset to the China endpoint", () => {
    // api.minimaxi.com is China; api.minimax.io is international. The hostnames
    // read backwards, so a wrong default 401s with a confusing message.
    const applied = applyAdapterPreset({ preset: "minimax", apiKey: "mm-key" });
    expect(applied.status.adapter).toBe("minimax");
    expect(process.env.MINIMAX_BASE_URL).toContain("api.minimaxi.com");
  });

  it("claude_api without a key is NOT ready (degrades to stub replies, no crash)", () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "claude_api";
    const s = readAdapterStatus();
    expect(s.ready).toBe(false);
    expect(s.preset).toBe("claude");
    expect(s.reason).toContain("ANTHROPIC_API_KEY");
  });

  it("stub mode is always ready", () => {
    process.env.PAPERCLIP_E2E_SKIP_LLM = "true";
    expect(readAdapterStatus()).toMatchObject({ ready: true, preset: "stub" });
  });

  it("applying the claude preset hot-sets env and flips readiness on", () => {
    const path = useTempEnvFile();
    const r = applyAdapterPreset({ preset: "claude", apiKey: "sk-ant-test-123" });
    expect(r.status.ready).toBe(true);
    expect(r.status.preset).toBe("claude");
    expect(process.env.AGENTDASH_DEFAULT_ADAPTER).toBe("claude_api");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-test-123");
    expect(process.env.PAPERCLIP_E2E_SKIP_LLM).toBeUndefined();
    // persisted to the env file (key included so a restart remembers it)
    expect(readFileSync(path, "utf8")).toContain("ANTHROPIC_API_KEY=sk-ant-test-123");
    // never echoes the secret in the applied list (keys only)
    expect(r.applied).toContain("ANTHROPIC_API_KEY");
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  it("the gemini preset routes through openai_compat at the Gemini endpoint", () => {
    useTempEnvFile();
    applyAdapterPreset({ preset: "gemini", apiKey: "gem-key" });
    expect(process.env.AGENTDASH_DEFAULT_ADAPTER).toBe("openai_compat");
    expect(process.env.OPENAI_COMPAT_BASE_URL).toContain("generativelanguage.googleapis.com");
    expect(process.env.OPENAI_COMPAT_MODEL).toContain("gemini");
    expect(readAdapterStatus()).toMatchObject({ ready: true, preset: "gemini" });
  });

  it("the openai preset points at api.openai.com", () => {
    useTempEnvFile();
    applyAdapterPreset({ preset: "openai", apiKey: "oai-key" });
    expect(process.env.OPENAI_COMPAT_BASE_URL).toContain("api.openai.com");
    expect(readAdapterStatus()).toMatchObject({ ready: true, preset: "openai" });
  });

  it("the stub preset enables E2E skip mode with no key", () => {
    useTempEnvFile();
    const r = applyAdapterPreset({ preset: "stub" });
    expect(process.env.PAPERCLIP_E2E_SKIP_LLM).toBe("true");
    expect(r.status.ready).toBe(true);
  });

  it("switching stub → claude clears the skip flag", () => {
    useTempEnvFile();
    applyAdapterPreset({ preset: "stub" });
    expect(process.env.PAPERCLIP_E2E_SKIP_LLM).toBe("true");
    applyAdapterPreset({ preset: "claude", apiKey: "sk-ant-x" });
    expect(process.env.PAPERCLIP_E2E_SKIP_LLM).toBeUndefined();
    expect(process.env.AGENTDASH_DEFAULT_ADAPTER).toBe("claude_api");
  });

  it("rejects a hosted preset without a key (400)", () => {
    expect(() => applyAdapterPreset({ preset: "claude" })).toThrow(/API key/);
    expect(() => applyAdapterPreset({ preset: "openai", apiKey: "  " })).toThrow(/API key/);
  });

  it("rejects an unknown preset (400)", () => {
    expect(() =>
      applyAdapterPreset({ preset: "grok" as unknown as "claude", apiKey: "x" }),
    ).toThrow(/Unknown adapter preset/);
  });

  it("merging preserves unrelated env lines and replaces existing keys", () => {
    const path = useTempEnvFile();
    writeFileSync(path, "PAPERCLIP_DEPLOYMENT_MODE=authenticated\nANTHROPIC_API_KEY=OLD-VALUE\n", "utf8");
    applyAdapterPreset({ preset: "claude", apiKey: "NEW-VALUE" });
    const after = readFileSync(path, "utf8");
    expect(after).toContain("PAPERCLIP_DEPLOYMENT_MODE=authenticated"); // preserved
    expect(after).toContain("ANTHROPIC_API_KEY=NEW-VALUE"); // replaced
    expect(after).not.toContain("OLD-VALUE");
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  it("apply still hot-sets env when the env file cannot be written (non-fatal)", () => {
    process.env.AGENTDASH_ENV_FILE = "/no/such/dir/cannot/exist/agentdash.env";
    const r = applyAdapterPreset({ preset: "claude", apiKey: "sk-ant-y" });
    expect(r.persisted).toBe(false);
    expect(r.persistError).toBeTruthy();
    // hot-set still took effect
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-y");
    expect(r.status.ready).toBe(true);
  });
});

/**
 * Readiness for the adapters that shell out to a local binary.
 *
 * These two were the only presets with no coverage, and they were the only two
 * that were broken. `hasBinary` used `require("node:child_process")`; the server
 * runs as ESM, so that threw ReferenceError on every call, the bare catch
 * swallowed it, and readiness was false for everything — including binaries that
 * plainly exist. `/health` and onboarding both surface this, so an on-prem box
 * reported "not ready" while it was actively serving replies through Hermes.
 */
describe("readAdapterStatus for local-binary adapters", () => {
  it("reports ready when AGENTDASH_HERMES_COMMAND is an executable path", () => {
    // /bin/sh rather than a fixture: it is executable on every machine that can
    // run this suite, so the case cannot pass for the wrong reason.
    process.env.AGENTDASH_DEFAULT_ADAPTER = "hermes_local";
    process.env.AGENTDASH_HERMES_COMMAND = "/bin/sh";

    expect(readAdapterStatus()).toMatchObject({
      adapter: "hermes_local",
      ready: true,
      reason: null,
    });
  });

  it("reports not ready when the configured path does not exist", () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "hermes_local";
    process.env.AGENTDASH_HERMES_COMMAND = "/nonexistent/definitely/not/hermes";

    const status = readAdapterStatus();
    expect(status.ready).toBe(false);
    expect(status.reason).toMatch(/not found/i);
  });

  it("resolves a bare command name against PATH", () => {
    // The default is the bare name "hermes"; a bare name must be looked up the
    // way a shell would, not treated as a relative path.
    process.env.AGENTDASH_DEFAULT_ADAPTER = "claude_local";
    const originalPath = process.env.PATH;
    process.env.PATH = "/bin:/usr/bin";
    try {
      // "claude_local" hardcodes the name "claude", so assert the resolver
      // directly through a preset whose command we control instead.
      process.env.AGENTDASH_DEFAULT_ADAPTER = "hermes_local";
      process.env.AGENTDASH_HERMES_COMMAND = "sh";
      expect(readAdapterStatus()).toMatchObject({ ready: true });
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("does not run the configured value through a shell", () => {
    // The old implementation interpolated this straight into `command -v ...`.
    // A value with a semicolon must be treated as a (missing) path, not run.
    process.env.AGENTDASH_DEFAULT_ADAPTER = "hermes_local";
    process.env.AGENTDASH_HERMES_COMMAND = "/bin/sh; touch /tmp/agentdash-pwned";

    expect(readAdapterStatus().ready).toBe(false);
    expect(existsSync("/tmp/agentdash-pwned"), "the value reached a shell").toBe(false);
  });
});
