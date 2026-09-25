import { afterEach, describe, expect, it } from "vitest";
import {
  actorMayApplyAdapterPreset,
  actorMaySetHostExecutionConfig,
  assertHostExecutionConfigAllowed,
  findRestrictedHostExecutionFields,
  isSafeHermesExtraArgs,
  runtimeConfigHostExecutionInputs,
} from "../services/adapter-host-execution-policy.js";

// AgentDash (security, #719): one classifier for host-execution fields, shared
// by agent create/update/hire/rollback, approvals, import, issue overrides,
// join approvals, test-environment and setup-adapter.

const MEMBER = {
  type: "board" as const,
  source: "session",
  isInstanceAdmin: false,
  memberships: [{ companyId: "c1", status: "active", membershipRole: "member" }],
};
const OWNER = {
  type: "board" as const,
  source: "session",
  isInstanceAdmin: false,
  memberships: [{ companyId: "c1", status: "active", membershipRole: "owner" }],
};
const INSTANCE_ADMIN = { type: "board" as const, source: "session", isInstanceAdmin: true };
const LOCAL = { type: "board" as const, source: "local_implicit" };
const AGENT = { type: "agent" as const };

describe("findRestrictedHostExecutionFields", () => {
  const originalHermes = process.env.AGENTDASH_HERMES_COMMAND;
  afterEach(() => {
    if (originalHermes === undefined) delete process.env.AGENTDASH_HERMES_COMMAND;
    else process.env.AGENTDASH_HERMES_COMMAND = originalHermes;
  });

  it.each([
    ["command", { command: "/bin/sh" }],
    ["args", { args: ["-c", "id"] }],
    ["extraArgs", { extraArgs: ["--foo"] }],
    ["env", { env: { NODE_OPTIONS: "--require ./x.js" } }],
    ["cwd", { cwd: "/tmp" }],
    ["hermesCommand", { hermesCommand: "/tmp/evil" }],
    ["agentCommand", { agentCommand: "sh -c id" }],
    ["stateDir", { stateDir: "/tmp/state" }],
    ["nested runtime service command", { workspaceRuntime: { services: [{ command: "nc -l 4444" }] } }],
  ])("flags a raw %s", (_label, adapterConfig) => {
    expect(findRestrictedHostExecutionFields({ adapterType: "claude_local", adapterConfig })).not.toEqual([]);
  });

  it("accepts empty values (they select the server default)", () => {
    expect(
      findRestrictedHostExecutionFields({
        adapterType: "claude_local",
        adapterConfig: { command: "", env: {}, extraArgs: [], cwd: "  ", model: "m" },
      }),
    ).toEqual([]);
  });

  it("accepts each adapter's default command", () => {
    expect(findRestrictedHostExecutionFields({ adapterType: "claude_local", adapterConfig: { command: "claude" } })).toEqual([]);
    expect(findRestrictedHostExecutionFields({ adapterType: "hermes_local", adapterConfig: { hermesCommand: "hermes" } })).toEqual([]);
    expect(findRestrictedHostExecutionFields({ adapterType: "codex_local", adapterConfig: { command: "codex" } })).toEqual([]);
    // Another adapter's default is not this adapter's default.
    expect(findRestrictedHostExecutionFields({ adapterType: "claude_local", adapterConfig: { command: "hermes" } })).toEqual([
      "adapterConfig.command",
    ]);
  });

  it("accepts the operator-configured AGENTDASH_HERMES_COMMAND", () => {
    process.env.AGENTDASH_HERMES_COMMAND = "/opt/hermes/bin/hermes";
    expect(
      findRestrictedHostExecutionFields({
        adapterType: "hermes_local",
        adapterConfig: { hermesCommand: "/opt/hermes/bin/hermes" },
      }),
    ).toEqual([]);
  });

  it("accepts the Hermes preset with a profile and reasoning effort", () => {
    expect(
      findRestrictedHostExecutionFields({
        adapterType: "hermes_local",
        adapterConfig: {
          model: "glm-5.3-flash",
          timeoutSec: 1800,
          persistSession: true,
          maxTurnsPerRun: 1000,
          hermesCommand: "hermes",
          extraArgs: ["-p", "agentdash", "--reasoning-effort", "high"],
        },
      }),
    ).toEqual([]);
  });

  it("rejects Hermes extraArgs outside the allowlist", () => {
    for (const extraArgs of [
      ["--reasoning-effort", "$(id)"],
      ["-p", "../../etc"],
      ["-p"],
      ["--yolo"],
      ["--reasoning-effort", "high", "--exec", "id"],
      ["-c", "id"],
    ]) {
      expect(
        findRestrictedHostExecutionFields({ adapterType: "hermes_local", adapterConfig: { extraArgs } }),
        JSON.stringify(extraArgs),
      ).toEqual(["adapterConfig.extraArgs"]);
    }
    // The Hermes allowlist does not apply to other adapters.
    expect(
      findRestrictedHostExecutionFields({
        adapterType: "claude_local",
        adapterConfig: { extraArgs: ["--reasoning-effort", "high"] },
      }),
    ).toEqual(["adapterConfig.extraArgs"]);
  });

  it("parses --flag=value and string forms of Hermes extraArgs", () => {
    expect(isSafeHermesExtraArgs(["--reasoning-effort=medium", "--profile=work_1"])).toBe(true);
    expect(isSafeHermesExtraArgs("-p agentdash --max-turns 40 --checkpoints")).toBe(true);
    expect(isSafeHermesExtraArgs(["--reasoning-effort=extreme"])).toBe(false);
    expect(isSafeHermesExtraArgs([1, 2])).toBe(false);
  });

  it("accepts values unchanged from the stored config, including env envelopes", () => {
    const stored = {
      command: "/usr/local/bin/custom-claude",
      env: { API_TOKEN: { type: "plain", value: "abc" }, KEY: { type: "secret_ref", secretId: "s1" } },
      cwd: "/srv/repo",
      extraArgs: ["--foo"],
    };
    expect(
      findRestrictedHostExecutionFields({
        adapterType: "claude_local",
        adapterConfig: {
          command: "/usr/local/bin/custom-claude",
          env: { API_TOKEN: "abc", KEY: { type: "secret_ref", secretId: "s1" } },
          cwd: "/srv/repo",
          extraArgs: ["--foo"],
        },
        stored,
      }),
    ).toEqual([]);
    expect(
      findRestrictedHostExecutionFields({
        adapterType: "claude_local",
        adapterConfig: { env: { API_TOKEN: "abc", NODE_OPTIONS: "--require x" } },
        stored,
      }),
    ).toEqual(["adapterConfig.env"]);
  });

  it("treats Hermes command and hermesCommand as aliases when comparing to stored", () => {
    expect(
      findRestrictedHostExecutionFields({
        adapterType: "hermes_local",
        adapterConfig: { hermesCommand: "/home/u/.local/bin/agentdash-x", command: "/home/u/.local/bin/agentdash-x" },
        stored: { command: "/home/u/.local/bin/agentdash-x" },
      }),
    ).toEqual([]);
  });

  it("leaves workspaceStrategy commands to their own agents:create gate", () => {
    expect(
      findRestrictedHostExecutionFields({
        adapterType: "claude_local",
        adapterConfig: { workspaceStrategy: { provisionCommand: "make setup" } },
      }),
    ).toEqual([]);
  });

  it("checks runtimeConfig model-profile adapterConfigs too", () => {
    const inputs = runtimeConfigHostExecutionInputs("claude_local", {
      modelProfiles: { cheap: { adapterConfig: { model: "haiku", command: "/bin/sh" } } },
    });
    expect(inputs.flatMap((input) => findRestrictedHostExecutionFields(input))).toEqual([
      "runtimeConfig.modelProfiles.cheap.adapterConfig.command",
    ]);
  });
});

describe("host-execution authority", () => {
  it("only instance admins and the local implicit board may set raw fields", () => {
    expect(actorMaySetHostExecutionConfig(INSTANCE_ADMIN)).toBe(true);
    expect(actorMaySetHostExecutionConfig(LOCAL)).toBe(true);
    expect(actorMaySetHostExecutionConfig(OWNER)).toBe(false);
    expect(actorMaySetHostExecutionConfig(MEMBER)).toBe(false);
    expect(actorMaySetHostExecutionConfig(AGENT)).toBe(false);
  });

  it("throws 403 naming the fields for a non-admin, and passes an instance admin", () => {
    expect(() =>
      assertHostExecutionConfigAllowed(OWNER, { adapterType: "claude_local", adapterConfig: { command: "/bin/sh" } }),
    ).toThrow(/Instance admin access required.*adapterConfig\.command/);
    expect(() =>
      assertHostExecutionConfigAllowed(INSTANCE_ADMIN, { adapterType: "claude_local", adapterConfig: { command: "/bin/sh" } }),
    ).not.toThrow();
  });

  it("lets a company owner apply only the Hermes setup-adapter preset", () => {
    expect(actorMayApplyAdapterPreset(OWNER, "hermes")).toBe(true);
    expect(actorMayApplyAdapterPreset(OWNER, "claude")).toBe(false);
    expect(actorMayApplyAdapterPreset(MEMBER, "hermes")).toBe(false);
    expect(actorMayApplyAdapterPreset(INSTANCE_ADMIN, "claude")).toBe(true);
    expect(actorMayApplyAdapterPreset(AGENT, "hermes")).toBe(false);
  });
});
