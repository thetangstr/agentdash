import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execute } from "./execute.js";
import type { AdapterExecutionContext } from "../types.js";

const cleanup: string[] = [];

afterEach(async () => {
  while (cleanup.length) {
    const dir = cleanup.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function makeCtx(
  overrides: Record<string, unknown> = {},
): AdapterExecutionContext {
  const logs: { stream: string; chunk: string }[] = [];
  return {
    runId: "test-run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "TestAgent",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    config: {},
    context: {},
    executionTarget: "local",
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    },
    onSpawn: async () => {},
    ...overrides,
    _logs: logs,
  } as unknown as AdapterExecutionContext;
}

async function makeScript(content: string): Promise<{ script: string; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "process-adapter-"));
  cleanup.push(dir);
  const scriptPath = path.join(dir, "script.sh");
  await writeFile(scriptPath, content, "utf8");
  await chmod(scriptPath, 0o755);
  return { script: scriptPath, dir };
}

describe("process adapter execute", () => {
  it("captures stdout and returns exitCode 0 on success", async () => {
    const { script, dir } = await makeScript("#!/bin/bash\necho 'hello world'\n");
    const ctx = makeCtx({ config: { command: script, cwd: dir } });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.errorMessage).toBeUndefined();
    expect(result.resultJson).toMatchObject({ stdout: expect.stringContaining("hello world") });
  });

  it("returns errorMessage with stderr on non-zero exit", async () => {
    const { script, dir } = await makeScript("#!/bin/bash\necho 'fail' >&2\nexit 3\n");
    const ctx = makeCtx({ config: { command: script, cwd: dir } });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(3);
    expect(result.errorMessage).toContain("3");
    expect(result.timedOut).toBe(false);
    expect(result.resultJson).toMatchObject({
      stderr: expect.stringContaining("fail"),
    });
  });

  it("throws when command is missing", async () => {
    const ctx = makeCtx({ config: { command: "" } });
    await expect(execute(ctx)).rejects.toThrow("missing command");
  });

  it("returns timedOut when the process exceeds timeoutSec", async () => {
    const { script, dir } = await makeScript("#!/bin/bash\nsleep 10\n");
    const ctx = makeCtx({
      config: { command: script, cwd: dir, timeoutSec: 1, graceSec: 1 },
    });
    const result = await execute(ctx);

    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toContain("1s");
  });

  it("passes configured env vars to the child process", async () => {
    const { script, dir } = await makeScript(
      '#!/bin/bash\necho "FOO=$FOO BAR=$BAR BAZ=$BAZ"\n',
    );
    const ctx = makeCtx({
      config: {
        command: script,
        cwd: dir,
        env: { FOO: "alpha", BAR: "bravo" },
      },
    });
    const result = await execute(ctx);

    expect(result.resultJson).toMatchObject({
      stdout: expect.stringContaining("FOO=alpha BAR=bravo"),
    });
  });

  it("streams stdout/stderr to onLog", async () => {
    const { script, dir } = await makeScript(
      "#!/bin/bash\necho 'out line'\necho 'err line' >&2\n",
    );
    const ctx = makeCtx({ config: { command: script, cwd: dir } });
    await execute(ctx);

    const logs = (ctx as unknown as { _logs: { stream: string; chunk: string }[] })._logs;
    const allOutput = logs.map((l) => l.chunk).join("");
    expect(allOutput).toContain("out line");
    expect(allOutput).toContain("err line");
  });
});
