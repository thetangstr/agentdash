import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("advertises the four customer-facing presets", () => {
    expect(adapterPresetOptions().map((o) => o.preset).sort()).toEqual(
      ["claude", "gemini", "openai", "stub"],
    );
    expect(ADAPTER_PRESETS.sort()).toEqual(["claude", "gemini", "openai", "stub"]);
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
