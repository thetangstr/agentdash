import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression tests for the Hermes-local execution seam (registry.ts wrapper).
 *
 * Two proven defects from the installed AgentDash company:
 *  1. The run's resolved model/provider (carried on ctx.config by heartbeat's
 *     model-profile resolution) never reached the hermes-paperclip-adapter, which
 *     reads only ctx.agent.adapterConfig — so runs launched with the profile /
 *     global default (K3) instead of the configured per-agent model (GLM).
 *  2. The managed per-agent AGENTS.md bundle (adapterConfig.instructionsFilePath)
 *     was persisted but never injected into the live prompt — the adapter only
 *     renders promptTemplate, so the role contract was dropped.
 */

async function writeFakeHermesCommand(dir: string): Promise<{ hermesCommand: string; argsPath: string }> {
  const argsPath = join(dir, "args.json");
  const hermesCommand = join(dir, "hermes");
  await writeFile(
    hermesCommand,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'fs.writeFileSync(process.env.HERMES_ARGS_PATH, JSON.stringify(process.argv.slice(2)));',
      'process.stdout.write("done\\n\\nsession_id: hermes-session-1\\n");',
    ].join("\n"),
  );
  await chmod(hermesCommand, 0o755);
  return { hermesCommand, argsPath };
}

function buildCtx(overrides: {
  hermesCommand: string;
  argsPath: string;
  adapterConfig?: Record<string, unknown>;
  config?: Record<string, unknown>;
}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Priya",
      role: "pm",
      adapterType: "hermes_local",
      adapterConfig: {
        cwd: tmpdir(),
        hermesCommand: overrides.hermesCommand,
        env: { HERMES_ARGS_PATH: overrides.argsPath },
        ...(overrides.adapterConfig ?? {}),
      },
    },
    runtime: {},
    config: overrides.config ?? {},
    context: {},
    authToken: "test-run-token",
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
  };
}

describe("hermes_local execute wrapper", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.AGENTDASH_HERMES_MANAGED_PROFILES;
  });

  it("binds the run's resolved model from ctx.config so Hermes does not fall back to the global default", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agentdash-hermes-model-"));
    const { hermesCommand, argsPath } = await writeFakeHermesCommand(tempDir);

    const { getServerAdapter } = await import("../adapters/registry.js");
    await getServerAdapter("hermes_local").execute(
      buildCtx({
        hermesCommand,
        argsPath,
        // adapterConfig carries NO model — the resolved run model arrives via
        // ctx.config (heartbeat model-profile resolution), e.g. GLM 5.3 Flash.
        config: { model: "glm-5.3-flash", provider: "zai" },
      }) as never,
    );

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    const modelIndex = args.indexOf("-m");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(args[modelIndex + 1]).toBe("glm-5.3-flash");
    const providerIndex = args.indexOf("--provider");
    expect(providerIndex).toBeGreaterThanOrEqual(0);
    expect(args[providerIndex + 1]).toBe("zai");
  });

  it("still prefers an explicit adapterConfig model over the run config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agentdash-hermes-model-override-"));
    const { hermesCommand, argsPath } = await writeFakeHermesCommand(tempDir);

    const { getServerAdapter } = await import("../adapters/registry.js");
    await getServerAdapter("hermes_local").execute(
      buildCtx({
        hermesCommand,
        argsPath,
        adapterConfig: { model: "glm-5.3-pro" },
        config: { model: "glm-5.3-flash" },
      }) as never,
    );

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    const modelIndex = args.indexOf("-m");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    // The run-resolved config wins because heartbeat already folded the agent's
    // base config + model-profile + issue override into ctx.config.
    expect(args[modelIndex + 1]).toBe("glm-5.3-flash");
  });

  it("injects the managed AGENTS.md role contract into the live prompt alongside the task context", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agentdash-hermes-instructions-"));
    const { hermesCommand, argsPath } = await writeFakeHermesCommand(tempDir);
    const instructionsPath = join(tempDir, "AGENTS.md");
    const roleContract =
      "You are Priya, the Product Manager. Triage and scope every issue before any engineering work begins.";
    await writeFile(instructionsPath, `${roleContract}\n`, "utf8");

    const { getServerAdapter } = await import("../adapters/registry.js");
    await getServerAdapter("hermes_local").execute(
      buildCtx({
        hermesCommand,
        argsPath,
        adapterConfig: { instructionsFilePath: instructionsPath },
      }) as never,
    );

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    const prompt = args[args.indexOf("-q") + 1] ?? "";
    // Role contract is present ...
    expect(prompt).toContain(roleContract);
    // ... alongside the retained Paperclip API safety guard and the rendered task
    // context (template variables are substituted before spawn).
    expect(prompt).toContain("Paperclip API safety rule:");
    expect(prompt).toContain("Agent ID: agent-1");
  });

  it("falls back to the authenticated default template when no managed bundle is configured", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agentdash-hermes-no-instructions-"));
    const { hermesCommand, argsPath } = await writeFakeHermesCommand(tempDir);

    const { getServerAdapter } = await import("../adapters/registry.js");
    await getServerAdapter("hermes_local").execute(
      buildCtx({ hermesCommand, argsPath }) as never,
    );

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    const prompt = args[args.indexOf("-q") + 1] ?? "";
    expect(prompt).toContain("Paperclip API safety rule:");
    expect(prompt).toContain("Heartbeat Wake");
  });

  it("injects the bundle from the deterministic managed path when adapterConfig predates the backfill", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agentdash-hermes-backfill-"));
    const { hermesCommand, argsPath } = await writeFakeHermesCommand(tempDir);

    // AGE-8: the refresh service backfilled the bundle onto the managed root,
    // but this run's agent row still carries the pre-backfill adapterConfig
    // (no instructionsFilePath). The wrapper must fall back to the
    // deterministic instance path for this run.
    const homeDir = join(tempDir, "paperclip-home");
    const managedDir = join(
      homeDir, "instances", "age8-test", "companies", "company-1", "agents", "agent-1", "instructions",
    );
    await mkdir(managedDir, { recursive: true });
    const roleContract = "You are Priya, the Product Manager. Backfilled role contract.";
    await writeFile(join(managedDir, "AGENTS.md"), roleContract + "\n", "utf8");

    const prevHome = process.env.PAPERCLIP_HOME;
    const prevInstance = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = homeDir;
    process.env.PAPERCLIP_INSTANCE_ID = "age8-test";
    try {
      const { getServerAdapter } = await import("../adapters/registry.js");
      await getServerAdapter("hermes_local").execute(
        buildCtx({ hermesCommand, argsPath }) as never,
      );
    } finally {
      if (prevHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = prevHome;
      if (prevInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = prevInstance;
    }

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    const prompt = args[args.indexOf("-q") + 1] ?? "";
    expect(prompt).toContain(roleContract);
    expect(prompt).toContain("Agent ID: agent-1");
  });
});
