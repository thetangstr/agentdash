import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";

describe("ADAPTER_SKILLS_DIRS map", () => {
  // Mirrors the constant from cli/src/commands/setup.ts
  const ADAPTER_SKILLS_DIRS: Record<string, string | undefined> = {
    claude_local: `${os.homedir()}/.claude/skills/deep-interview`,
    claude_api: `${os.homedir()}/.claude/skills/deep-interview`,
    hermes_local: `${os.homedir()}/.hermes/skills/deep-interview`,
    codex_local: `${process.env.CODEX_HOME ?? `${os.homedir()}/.codex`}/skills/deep-interview`,
    gemini_local: `${os.homedir()}/.gemini/skills/deep-interview`,
    opencode_local: `${os.homedir()}/.opencode/skills/deep-interview`,
    acpx_local: `${os.homedir()}/.acpx/skills/deep-interview`,
    cursor: `${os.homedir()}/.cursor/skills/deep-interview`,
  };

  it("maps claude_local and claude_api to ~/.claude/skills/deep-interview", () => {
    expect(ADAPTER_SKILLS_DIRS["claude_local"]).toBe(
      path.join(os.homedir(), ".claude/skills/deep-interview")
    );
    expect(ADAPTER_SKILLS_DIRS["claude_api"]).toBe(
      path.join(os.homedir(), ".claude/skills/deep-interview")
    );
  });

  it("maps hermes_local to ~/.hermes/skills/deep-interview", () => {
    expect(ADAPTER_SKILLS_DIRS["hermes_local"]).toBe(
      path.join(os.homedir(), ".hermes/skills/deep-interview")
    );
  });

  it("maps codex_local to CODEX_HOME or ~/.codex", () => {
    // When CODEX_HOME is unset, defaults to ~/.codex
    expect(ADAPTER_SKILLS_DIRS["codex_local"]).toBe(
      path.join(os.homedir(), ".codex/skills/deep-interview")
    );
  });

  it("maps gemini_local to ~/.gemini/skills/deep-interview", () => {
    expect(ADAPTER_SKILLS_DIRS["gemini_local"]).toBe(
      path.join(os.homedir(), ".gemini/skills/deep-interview")
    );
  });

  it("maps opencode_local to ~/.opencode/skills/deep-interview", () => {
    expect(ADAPTER_SKILLS_DIRS["opencode_local"]).toBe(
      path.join(os.homedir(), ".opencode/skills/deep-interview")
    );
  });

  it("maps acpx_local to ~/.acpx/skills/deep-interview", () => {
    expect(ADAPTER_SKILLS_DIRS["acpx_local"]).toBe(
      path.join(os.homedir(), ".acpx/skills/deep-interview")
    );
  });

  it("maps cursor to ~/.cursor/skills/deep-interview", () => {
    expect(ADAPTER_SKILLS_DIRS["cursor"]).toBe(
      path.join(os.homedir(), ".cursor/skills/deep-interview")
    );
  });

  it("pi_local has no skills directory (skipped by install)", () => {
    expect(ADAPTER_SKILLS_DIRS["pi_local"]).toBeUndefined();
  });

  it("http has no skills directory (skipped by install)", () => {
    expect(ADAPTER_SKILLS_DIRS["http"]).toBeUndefined();
  });

  it("openclaw_gateway has no skills directory (skipped by install)", () => {
    expect(ADAPTER_SKILLS_DIRS["openclaw_gateway"]).toBeUndefined();
  });

  it("process has no skills directory (skipped by install)", () => {
    expect(ADAPTER_SKILLS_DIRS["process"]).toBeUndefined();
  });

  it("SKILL.md filename is correct for all mapped adapters", () => {
    const SKILL_FILE = "SKILL.md";
    for (const [adapter, dir] of Object.entries(ADAPTER_SKILLS_DIRS)) {
      if (dir) {
        expect(path.join(dir, SKILL_FILE)).toBe(
          `${dir}/SKILL.md`
        );
      }
    }
  });
});
