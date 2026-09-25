import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  actorMayApplyAdapterPreset,
  actorMaySetHostExecutionConfig,
  assertHostExecutionConfigAllowed,
  findRestrictedHostExecutionFields,
  isSafeHermesExtraArgs,
  runtimeConfigHostExecutionInputs,
} from "../services/adapter-host-execution-policy.js";
import { stripForeignHermesProfileArgs } from "../adapters/hermes-profile-args.js";
import { hostExecutionContextForCompany } from "../services/host-execution-context.js";
import { agentProfileName, hermesManagedProfilesEnabled } from "../services/hermes-profile.js";
import { isHostedBox } from "../services/license.js";

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

  it("validates the exact Hermes extraArgs tokens that reach the CLI", () => {
    expect(isSafeHermesExtraArgs(["--reasoning-effort=medium", "--profile=work_1"])).toBe(true);
    expect(isSafeHermesExtraArgs(["-p", "agentdash", "--max-turns", "40", "--checkpoints"])).toBe(true);
    expect(isSafeHermesExtraArgs(["--reasoning-effort=extreme"])).toBe(false);
    expect(isSafeHermesExtraArgs([1, 2])).toBe(false);
    // Empty or whitespace tokens would reach Hermes as stray arguments.
    expect(isSafeHermesExtraArgs(["-p", "", "x"])).toBe(false);
    expect(isSafeHermesExtraArgs(["-p", " agentdash"])).toBe(false);
    expect(isSafeHermesExtraArgs(["-p", "agentdash", "  "])).toBe(false);
    // The adapter reads an array; a string is not what it will pass.
    expect(isSafeHermesExtraArgs("-p agentdash")).toBe(false);
    // Only the documented reasoning-effort levels.
    expect(isSafeHermesExtraArgs(["--reasoning-effort", "xhigh"])).toBe(false);
    expect(isSafeHermesExtraArgs(["--reasoning-effort", "minimal"])).toBe(false);
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

// AgentDash (security, #737): `*Path` keys and managed Hermes profiles.
describe("instructions *Path keys (#737)", () => {
  const saved = { home: process.env.PAPERCLIP_HOME, instance: process.env.PAPERCLIP_INSTANCE_ID };
  let scratch = "";
  let instanceRoot = "";
  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "host-exec-path-")));
    process.env.PAPERCLIP_HOME = scratch;
    process.env.PAPERCLIP_INSTANCE_ID = "policy";
    instanceRoot = path.join(scratch, "instances", "policy");
  });
  afterEach(() => {
    if (saved.home === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = saved.home;
    if (saved.instance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = saved.instance;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it.each(["instructionsFilePath", "instructionsRootPath", "agentsMdPath"])("flags %s outside the company area", (key) => {
    expect(
      findRestrictedHostExecutionFields({
        adapterType: "hermes_local",
        adapterConfig: { [key]: "/home/founder/.ssh/authorized_keys" },
        companyId: "c1",
      }),
    ).toEqual([`adapterConfig.${key}`]);
  });

  it("lets a path inside the company's managed or shared instructions directory through", () => {
    const managed = path.join(instanceRoot, "companies", "c1", "agents", "a1", "instructions", "AGENTS.md");
    const shared = path.join(instanceRoot, "companies", "c1", "shared-instructions", "team");
    expect(
      findRestrictedHostExecutionFields({
        adapterType: "hermes_local",
        adapterConfig: { instructionsFilePath: managed, instructionsRootPath: shared },
        companyId: "c1",
      }),
    ).toEqual([]);
  });

  it("refuses another company's directory, a sibling of the instructions dir, and a path without a company", () => {
    const otherCompany = path.join(instanceRoot, "companies", "c2", "shared-instructions", "AGENTS.md");
    const agentHome = path.join(instanceRoot, "companies", "c1", "agents", "a1", "codex-home", "config.toml");
    for (const value of [otherCompany, agentHome]) {
      expect(
        findRestrictedHostExecutionFields({ adapterType: "hermes_local", adapterConfig: { instructionsFilePath: value }, companyId: "c1" }),
      ).toEqual(["adapterConfig.instructionsFilePath"]);
    }
    const managed = path.join(instanceRoot, "companies", "c1", "agents", "a1", "instructions", "AGENTS.md");
    expect(
      findRestrictedHostExecutionFields({ adapterType: "hermes_local", adapterConfig: { instructionsFilePath: managed } }),
    ).toEqual(["adapterConfig.instructionsFilePath"]);
  });

  it("refuses a path through a symlink planted in the company area", () => {
    const shared = path.join(instanceRoot, "companies", "c1", "shared-instructions");
    fs.mkdirSync(shared, { recursive: true });
    fs.symlinkSync(os.tmpdir(), path.join(shared, "out"));
    expect(
      findRestrictedHostExecutionFields({
        adapterType: "hermes_local",
        adapterConfig: { instructionsRootPath: path.join(shared, "out") },
        companyId: "c1",
      }),
    ).toEqual(["adapterConfig.instructionsRootPath"]);
  });

  it("accepts an unchanged stored path", () => {
    expect(
      findRestrictedHostExecutionFields({
        adapterType: "hermes_local",
        adapterConfig: { instructionsFilePath: "/srv/checkout/AGENTS.md" },
        stored: { instructionsFilePath: "/srv/checkout/AGENTS.md" },
        companyId: "c1",
      }),
    ).toEqual([]);
  });
});

describe("Hermes -p with managed profiles (#737)", () => {
  const saved = {
    managed: process.env.AGENTDASH_HERMES_MANAGED_PROFILES,
    kind: process.env.AGENTDASH_DEPLOYMENT_KIND,
  };
  afterEach(() => {
    if (saved.managed === undefined) delete process.env.AGENTDASH_HERMES_MANAGED_PROFILES;
    else process.env.AGENTDASH_HERMES_MANAGED_PROFILES = saved.managed;
    if (saved.kind === undefined) delete process.env.AGENTDASH_DEPLOYMENT_KIND;
    else process.env.AGENTDASH_DEPLOYMENT_KIND = saved.kind;
  });

  const company = new Set(["agentdash-aaaa"]);

  it("allows any valid profile name when managed profiles are off", () => {
    delete process.env.AGENTDASH_HERMES_MANAGED_PROFILES;
    delete process.env.AGENTDASH_DEPLOYMENT_KIND;
    expect(isSafeHermesExtraArgs(["-p", "ccworker"])).toBe(true);
  });

  it.each([
    ["AGENTDASH_HERMES_MANAGED_PROFILES", "true"],
    ["AGENTDASH_DEPLOYMENT_KIND", "hosted"],
  ])("with %s=%s allows only this company's profiles", (key, value) => {
    process.env[key] = value;
    expect(isSafeHermesExtraArgs(["-p", "agentdash-aaaa"], { allowedProfiles: company })).toBe(true);
    expect(isSafeHermesExtraArgs(["--profile=agentdash-aaaa"], { allowedProfiles: company })).toBe(true);
    expect(isSafeHermesExtraArgs(["-p", "ccworker"], { allowedProfiles: company })).toBe(false);
    expect(isSafeHermesExtraArgs(["--profile=ccworker"], { allowedProfiles: company })).toBe(false);
    expect(isSafeHermesExtraArgs(["-p", "agentdash-aaaa"])).toBe(false);
    expect(isSafeHermesExtraArgs(["--reasoning-effort", "low"])).toBe(true);
    expect(
      findRestrictedHostExecutionFields({
        adapterType: "hermes_local",
        adapterConfig: { extraArgs: ["-p", "ccworker"] },
        hermesProfiles: company,
      }),
    ).toEqual(["adapterConfig.extraArgs"]);
  });

  it("strips every profile flag but the agent's own at run time", () => {
    const own = "agentdash-aaaa";
    expect(stripForeignHermesProfileArgs(["-p", own, "--reasoning-effort", "low"], own)).toEqual({
      extraArgs: ["-p", own, "--reasoning-effort", "low"],
      dropped: [],
    });
    expect(
      stripForeignHermesProfileArgs(
        ["-p", "ccworker", "--profile=root", "-pother", "--prof", "x", "--prof=y", "--verbose"],
        own,
      ),
    ).toEqual({ extraArgs: ["--verbose"], dropped: ["ccworker", "root", "other", "x", "y"] });
    expect(stripForeignHermesProfileArgs(undefined, own)).toEqual({ extraArgs: undefined, dropped: [] });
  });
});

describe("write-time -p matches the run-time strip (#737)", () => {
  const saved = process.env.AGENTDASH_DEPLOYMENT_KIND;
  const savedManaged = process.env.AGENTDASH_HERMES_MANAGED_PROFILES;
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENTDASH_DEPLOYMENT_KIND;
    else process.env.AGENTDASH_DEPLOYMENT_KIND = saved;
    if (savedManaged === undefined) delete process.env.AGENTDASH_HERMES_MANAGED_PROFILES;
    else process.env.AGENTDASH_HERMES_MANAGED_PROFILES = savedManaged;
  });

  const own = "11111111-1111-4111-8111-111111111111";
  const sibling = "22222222-2222-4222-8222-222222222222";

  function restricted(extraArgs: string[], agentId: string | null) {
    return findRestrictedHostExecutionFields({
      adapterType: "hermes_local",
      adapterConfig: { extraArgs },
      ...hostExecutionContextForCompany("company-1", { agentId }),
    });
  }

  it("on a hosted box accepts only the agent's own profile, never a sibling agent's", () => {
    process.env.AGENTDASH_DEPLOYMENT_KIND = " Hosted ";
    expect(restricted(["-p", agentProfileName(own)], own)).toEqual([]);
    // A sibling's profile is in the same company, but every run of this agent
    // would drop it (registry.ts keeps only the agent's own profile).
    expect(restricted(["-p", agentProfileName(sibling)], own)).toEqual(["adapterConfig.extraArgs"]);
    expect(stripForeignHermesProfileArgs(["-p", agentProfileName(sibling)], agentProfileName(own)).dropped).toEqual([
      agentProfileName(sibling),
    ]);
  });

  it("a configuration with no agent yet may name no profile", () => {
    process.env.AGENTDASH_HERMES_MANAGED_PROFILES = "true";
    expect(restricted(["-p", agentProfileName(own)], null)).toEqual(["adapterConfig.extraArgs"]);
    expect(restricted(["--reasoning-effort", "low"], null)).toEqual([]);
  });

  it("uses the one managed-profiles helper, which reads the hosted flag through isHostedBox", () => {
    delete process.env.AGENTDASH_HERMES_MANAGED_PROFILES;
    process.env.AGENTDASH_DEPLOYMENT_KIND = "HOSTED";
    expect(hermesManagedProfilesEnabled()).toBe(isHostedBox());
    expect(isSafeHermesExtraArgs(["-p", "ccworker"])).toBe(false);
    delete process.env.AGENTDASH_DEPLOYMENT_KIND;
    expect(isSafeHermesExtraArgs(["-p", "ccworker"])).toBe(true);
  });
});
