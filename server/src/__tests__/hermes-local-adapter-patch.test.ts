import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("patched hermes-paperclip-adapter behavior", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("does not fail the environment check when Hermes itself reports Python 3.10+", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agentdash-hermes-env-"));
    const hermesCommand = join(tempDir, "hermes");
    const fakePython = join(tempDir, "python3");
    await writeFile(
      hermesCommand,
      [
        "#!/usr/bin/env node",
        'if (process.argv[2] === "--version") {',
        '  process.stdout.write("Hermes Agent v0.14.0 (2026.5.16) Project: /Users/example/.hermes/hermes-agent Python: 3.11.15 OpenAI SDK: 2.24.0\\n");',
        "  process.exit(0);",
        "}",
        "process.exit(1);",
      ].join("\n"),
    );
    await writeFile(fakePython, '#!/usr/bin/env node\nprocess.stdout.write("Python 3.9.6\\n");\n');
    await chmod(hermesCommand, 0o755);
    await chmod(fakePython, 0o755);

    const { testEnvironment } = await import("hermes-paperclip-adapter/server");

    const originalPath = process.env.PATH ?? "";
    process.env.PATH = `${tempDir}:${originalPath}`;
    let result;
    try {
      result = await testEnvironment({ config: { hermesCommand } });
    } finally {
      process.env.PATH = originalPath;
    }

    expect(result.status).not.toBe("fail");
    expect(result.checks).not.toContainEqual(expect.objectContaining({ code: "hermes_python_old" }));
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        code: "hermes_no_api_keys",
        level: "warn",
        message: "No LLM API keys found in AgentDash environment",
      }),
    );
  });

  it("lets Hermes use its configured default model when no adapter model is set", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agentdash-hermes-adapter-"));
    const argsPath = join(tempDir, "args.json");
    const hermesCommand = join(tempDir, "hermes");
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

    const { execute } = await import("hermes-paperclip-adapter/server");

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes Agent",
        role: "engineer",
        adapterType: "hermes_local",
        adapterConfig: {
          cwd: tempDir,
          env: {
            HERMES_ARGS_PATH: argsPath,
          },
          hermesCommand,
        },
      },
      runtime: {},
      config: {},
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
    });

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    expect(args).not.toContain("-m");
  });
});
