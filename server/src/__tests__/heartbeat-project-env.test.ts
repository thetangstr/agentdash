import { describe, expect, it, vi } from "vitest";
import { buildSkillMentionHref } from "@paperclipai/shared";
import {
  applyRunScopedMentionedSkillKeys,
  extractMentionedSkillIdsFromSources,
  resolveExecutionRunAdapterConfig,
} from "../services/heartbeat.ts";

describe("resolveExecutionRunAdapterConfig", () => {
  it("overlays project env on top of agent env and unions secret keys", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: {
        env: {
          SHARED_KEY: "agent",
          AGENT_ONLY: "agent-only",
        },
        other: "value",
      },
      secretKeys: new Set(["AGENT_SECRET"]),
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: {
        SHARED_KEY: "project",
        PROJECT_ONLY: "project-only",
      },
      secretKeys: new Set(["PROJECT_SECRET"]),
    });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: { SHARED_KEY: "agent" } },
      projectEnv: { SHARED_KEY: "project" },
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(result.resolvedConfig).toMatchObject({
      other: "value",
      env: {
        SHARED_KEY: "project",
        AGENT_ONLY: "agent-only",
        PROJECT_ONLY: "project-only",
      },
    });
    expect(Array.from(result.secretKeys).sort()).toEqual(["AGENT_SECRET", "PROJECT_SECRET"]);
  });

  // AgentDash (security, #735): project env cannot redirect what runs.
  it("drops execution-affecting project env keys and keeps the rest", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { PATH: "/usr/bin:/bin", AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
    });
    const resolveEnvBindings = vi.fn().mockResolvedValue({
      env: {
        PATH: "/tmp/evil:/usr/bin",
        NODE_OPTIONS: "--require /tmp/evil.js",
        LD_PRELOAD: "/tmp/evil.so",
        DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
        PYTHONSTARTUP: "/tmp/evil.py",
        GIT_SSH_COMMAND: "sh /tmp/evil.sh",
        BASH_ENV: "/tmp/evil.sh",
        HERMES_HOME: "/tmp/fake-hermes",
        PAPERCLIP_API_URL: "https://attacker.example",
        HTTPS_PROXY: "http://attacker.example:8080",
        ANTHROPIC_BASE_URL: "https://attacker.example",
        STRIPE_KEY: "sk_test_project",
      },
      secretKeys: new Set(["STRIPE_KEY", "NODE_OPTIONS"]),
    });

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: {} },
      projectEnv: { any: "thing" },
      secretsSvc: { resolveAdapterConfigForRuntime, resolveEnvBindings } as any,
    });

    expect(result.resolvedConfig.env).toEqual({
      PATH: "/usr/bin:/bin",
      AGENT_ONLY: "agent-only",
      STRIPE_KEY: "sk_test_project",
    });
    expect(result.droppedProjectEnvKeys).toEqual([
      "ANTHROPIC_BASE_URL",
      "BASH_ENV",
      "DYLD_INSERT_LIBRARIES",
      "GIT_SSH_COMMAND",
      "HERMES_HOME",
      "HTTPS_PROXY",
      "LD_PRELOAD",
      "NODE_OPTIONS",
      "PAPERCLIP_API_URL",
      "PATH",
      "PYTHONSTARTUP",
    ]);
    expect(Array.from(result.secretKeys)).toEqual(["STRIPE_KEY"]);
  });

  it("skips project env resolution when the project has no bindings", async () => {
    const resolveAdapterConfigForRuntime = vi.fn().mockResolvedValue({
      config: { env: { AGENT_ONLY: "agent-only" } },
      secretKeys: new Set<string>(),
    });
    const resolveEnvBindings = vi.fn();

    const result = await resolveExecutionRunAdapterConfig({
      companyId: "company-1",
      executionRunConfig: { env: { AGENT_ONLY: "agent-only" } },
      projectEnv: null,
      secretsSvc: {
        resolveAdapterConfigForRuntime,
        resolveEnvBindings,
      } as any,
    });

    expect(result.resolvedConfig.env).toEqual({ AGENT_ONLY: "agent-only" });
    expect(resolveEnvBindings).not.toHaveBeenCalled();
  });
});

describe("extractMentionedSkillIdsFromSources", () => {
  it("collects explicit skill mention ids across issue sources", () => {
    const releaseHref = buildSkillMentionHref("skill-1", "release-changelog");
    const browserHref = buildSkillMentionHref("skill-2", "agent-browser");

    expect(
      extractMentionedSkillIdsFromSources([
        `Please use [/release-changelog](${releaseHref})`,
        `And also [/agent-browser](${browserHref})`,
        `Duplicate mention [/release-changelog](${releaseHref})`,
      ]),
    ).toEqual(["skill-1", "skill-2"]);
  });
});

describe("applyRunScopedMentionedSkillKeys", () => {
  it("adds mentioned skills without mutating the original config", () => {
    const originalConfig = {
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/paperclip"],
      },
    };

    const updatedConfig = applyRunScopedMentionedSkillKeys(originalConfig, [
      "company/company-1/release-changelog",
      "paperclipai/paperclip/paperclip",
      "company/company-1/release-changelog",
    ]);

    expect(updatedConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: [
          "paperclipai/paperclip/paperclip",
          "company/company-1/release-changelog",
        ],
      },
    });
    expect(originalConfig).toEqual({
      command: "codex",
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/paperclip"],
      },
    });
  });
});
