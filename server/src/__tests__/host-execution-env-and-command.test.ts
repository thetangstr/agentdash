import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  actorMaySetHostWorkspaceCommand,
  assertProjectEnvAllowed,
  defaultAdapterCommands,
  findExecutionAffectingEnvKeys,
  isExecutionAffectingEnvKey,
} from "../services/adapter-host-execution-policy.js";
import {
  defaultHermesCommand,
  initializeDefaultAdapterCommands,
  pinDefaultHermesCommand,
  resetDefaultAdapterCommandsForTests,
  resolveCommandOnPath,
} from "../services/adapter-command-resolution.js";
import { normalizeHermesConfig } from "../adapters/registry.js";

// AgentDash (security, #735).

const OWNER = {
  type: "board" as const,
  source: "session",
  isInstanceAdmin: false,
  memberships: [{ companyId: "c1", status: "active", membershipRole: "owner" }],
};
const INSTANCE_ADMIN = { type: "board" as const, source: "session", isInstanceAdmin: true };
const LOCAL = { type: "board" as const, source: "local_implicit" };
const AGENT = { type: "agent" as const };

describe("execution-affecting env denylist", () => {
  it.each([
    "PATH",
    "path",
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "BASH_ENV",
    "ENV",
    "ZDOTDIR",
    "GIT_SSH_COMMAND",
    "GIT_SSH",
    "GIT_EXEC_PATH",
    "GIT_PROXY_COMMAND",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "PERL5LIB",
    "PERL5OPT",
    "RUBYOPT",
    "HOME",
    "SHELL",
    "JAVA_TOOL_OPTIONS",
    "npm_config_script_shell",
    "HERMES_HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "HTTPS_PROXY",
    "all_proxy",
    "OPENAI_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "SSL_CERT_FILE",
    "PAPERCLIP_API_URL",
    "PAPERCLIP_API_KEY",
    "AGENTDASH_HERMES_COMMAND",
  ])("refuses %s", (key) => {
    expect(isExecutionAffectingEnvKey(key)).toBe(true);
  });

  it.each(["STRIPE_SECRET_KEY", "DATABASE_URL", "OPENAI_API_KEY", "APP_ENV", "FEATURE_FLAG", "LOG_LEVEL"])(
    "keeps %s",
    (key) => {
      expect(isExecutionAffectingEnvKey(key)).toBe(false);
    },
  );

  it("lists the refused keys of an env record, envelopes included", () => {
    expect(
      findExecutionAffectingEnvKeys({
        PATH: { type: "plain", value: "/tmp/evil" },
        API_TOKEN: { type: "secret_ref", secretId: "s1" },
        NODE_OPTIONS: "--require /tmp/x.js",
      }),
    ).toEqual(["NODE_OPTIONS", "PATH"]);
  });
});

describe("assertProjectEnvAllowed", () => {
  it("refuses a denylisted key for everyone, instance admin included", () => {
    for (const actor of [OWNER, INSTANCE_ADMIN, LOCAL]) {
      expect(() => assertProjectEnvAllowed(actor, { PATH: "/tmp/evil" })).toThrow(/execution-affecting variables \(PATH\)/);
    }
  });

  it("lets board members set ordinary project env", () => {
    expect(() => assertProjectEnvAllowed(OWNER, { STRIPE_SECRET_KEY: "sk_test" })).not.toThrow();
    expect(() => assertProjectEnvAllowed(OWNER, undefined)).not.toThrow();
  });

  it("refuses an agent key any change to project env, but not an echo of the stored value", () => {
    expect(() => assertProjectEnvAllowed(AGENT, { API_TOKEN: "x" })).toThrow(/Agent keys cannot change a project's env/);
    expect(() => assertProjectEnvAllowed(AGENT, null, { API_TOKEN: { type: "plain", value: "x" } })).toThrow();
    expect(() =>
      assertProjectEnvAllowed(AGENT, { API_TOKEN: "x" }, { API_TOKEN: { type: "plain", value: "x" } }),
    ).not.toThrow();
  });
});

describe("workspace command authority", () => {
  it("is instance admin (or local_trusted) only", () => {
    expect(actorMaySetHostWorkspaceCommand(INSTANCE_ADMIN)).toBe(true);
    expect(actorMaySetHostWorkspaceCommand(LOCAL)).toBe(true);
    expect(actorMaySetHostWorkspaceCommand(OWNER)).toBe(false);
    expect(actorMaySetHostWorkspaceCommand(AGENT)).toBe(false);
  });
});

describe("default Hermes command pinned at boot", () => {
  const saved = { path: process.env.PATH, command: process.env.AGENTDASH_HERMES_COMMAND };
  let scratch = "";
  let realBin = "";
  let evilBin = "";

  function makeExecutable(dir: string, name: string) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return file;
  }

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hermes-pin-")));
    realBin = path.join(scratch, "real-bin");
    evilBin = path.join(scratch, "evil-bin");
    makeExecutable(realBin, "hermes");
    makeExecutable(evilBin, "hermes");
    delete process.env.AGENTDASH_HERMES_COMMAND;
    resetDefaultAdapterCommandsForTests();
  });

  afterEach(() => {
    process.env.PATH = saved.path;
    if (saved.command === undefined) delete process.env.AGENTDASH_HERMES_COMMAND;
    else process.env.AGENTDASH_HERMES_COMMAND = saved.command;
    resetDefaultAdapterCommandsForTests();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("resolves a bare command against PATH and ignores non-executables and relative entries", () => {
    fs.writeFileSync(path.join(scratch, "hermes"), "not executable", { mode: 0o644 });
    expect(resolveCommandOnPath("hermes", ["relative/dir", scratch, realBin].join(path.delimiter))).toBe(
      path.join(realBin, "hermes"),
    );
    expect(resolveCommandOnPath("hermes", scratch)).toBeNull();
    expect(resolveCommandOnPath(path.join(evilBin, "hermes"), "")).toBe(path.join(evilBin, "hermes"));
  });

  it("keeps the binary resolved at boot when the PATH changes later", () => {
    process.env.PATH = [realBin, "/usr/bin", "/bin"].join(path.delimiter);
    initializeDefaultAdapterCommands();
    // A run env (or anything else) now puts another `hermes` first.
    process.env.PATH = [evilBin, realBin].join(path.delimiter);

    expect(defaultHermesCommand()).toBe(path.join(realBin, "hermes"));
    expect(pinDefaultHermesCommand("hermes")).toBe(path.join(realBin, "hermes"));
    expect(pinDefaultHermesCommand("/opt/custom/hermes")).toBe("/opt/custom/hermes");

    const ctx = normalizeHermesConfig({ config: {} as Record<string, unknown>, agent: { adapterConfig: { hermesCommand: "hermes" } } });
    expect((ctx.config as Record<string, unknown>).hermesCommand).toBe(path.join(realBin, "hermes"));
    expect((ctx.agent as { adapterConfig: Record<string, unknown> }).adapterConfig.hermesCommand).toBe(
      path.join(realBin, "hermes"),
    );
    // The pinned path is still the default command for the policy.
    expect(defaultAdapterCommands("hermes_local")).toContain(path.join(realBin, "hermes"));
  });

  it("falls back to the bare name when the command is not on the boot PATH", () => {
    process.env.PATH = scratch;
    initializeDefaultAdapterCommands();
    expect(defaultHermesCommand()).toBe("hermes");
  });

  it("honours AGENTDASH_HERMES_COMMAND and stops pinning when it changes", () => {
    process.env.AGENTDASH_HERMES_COMMAND = path.join(evilBin, "hermes");
    initializeDefaultAdapterCommands();
    expect(defaultHermesCommand()).toBe(path.join(evilBin, "hermes"));
    process.env.AGENTDASH_HERMES_COMMAND = "hermes-next";
    expect(defaultHermesCommand()).toBe("hermes-next");
  });
});
