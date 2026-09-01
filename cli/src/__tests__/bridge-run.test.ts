import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => hoisted.spawnMock(...args),
}));

import { bridgeRun, registerBridgeCommands } from "../commands/bridge-run.js";
import type { ExecutorContext } from "../bridge/sandbox.js";

let scratch: string;

interface RecordedCall {
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

type PollReply = { task: null } | { task: Record<string, unknown>; resultToken: string };

function makeFetch(polls: PollReply[]) {
  const calls: RecordedCall[] = [];
  let pollIndex = 0;
  const impl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path: url.pathname, body, headers });

    if (url.pathname === "/api/bridge/poll") {
      const reply = polls[Math.min(pollIndex, polls.length - 1)] ?? { task: null };
      pollIndex += 1;
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ taskId: body.taskId, outcome: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { impl, calls, pathsOf: () => calls.map((call) => call.path) };
}

/** Stops the worker once it has polled `n` times. */
function stopAfterPolls(n: number, calls: RecordedCall[], controller: AbortController) {
  return async () => {
    if (calls.filter((call) => call.path === "/api/bridge/poll").length >= n) controller.abort();
  };
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    platform: "darwin" as NodeJS.Platform,
    isExecutable: () => true,
    env: {} as NodeJS.ProcessEnv,
    log: vi.fn(),
    errorLog: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "bridge-run-test-"));
  hoisted.spawnMock.mockReset();
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("agentdash bridge run — refusals (nothing may execute)", () => {
  it("refuses to start off macOS and executes nothing", async () => {
    const fetchImpl = vi.fn();
    const executor = vi.fn();
    await expect(
      bridgeRun(
        { server: "http://localhost:3100", egress: "loopback" },
        baseDeps({
          platform: "linux" as NodeJS.Platform,
          env: { AGENTDASH_BRIDGE_TOKEN: "tok" },
          fetchImpl,
          executor,
        }),
      ),
    ).rejects.toThrow(/darwin|macOS/i);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
    expect(hoisted.spawnMock).not.toHaveBeenCalled();
  });

  it("refuses to start when sandbox-exec is unavailable and executes nothing", async () => {
    const fetchImpl = vi.fn();
    const executor = vi.fn();
    await expect(
      bridgeRun(
        { server: "http://localhost:3100", egress: "loopback" },
        baseDeps({
          isExecutable: () => false,
          env: { AGENTDASH_BRIDGE_TOKEN: "tok" },
          fetchImpl,
          executor,
        }),
      ),
    ).rejects.toThrow(/sandbox-exec/);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
    expect(hoisted.spawnMock).not.toHaveBeenCalled();
  });

  it("refuses to start with no egress policy chosen", async () => {
    const fetchImpl = vi.fn();
    await expect(
      bridgeRun(
        { server: "http://localhost:3100" },
        baseDeps({ env: { AGENTDASH_BRIDGE_TOKEN: "tok" }, fetchImpl }),
      ),
    ).rejects.toThrow(/--egress/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a token supplied on the command line, through the real command", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const program = new Command();
    program.exitOverride();
    registerBridgeCommands(program);

    await expect(
      program.parseAsync(
        ["bridge", "run", "--egress", "loopback", "--server", "http://localhost:3100", "--token", "s3cret"],
        { from: "user" },
      ),
    ).rejects.toThrow(/AGENTDASH_BRIDGE_TOKEN|--token-file/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hoisted.spawnMock).not.toHaveBeenCalled();
  });

  it("does not advertise a --token option that takes a usable value", () => {
    const program = new Command();
    registerBridgeCommands(program);
    const bridge = program.commands.find((command) => command.name() === "bridge");
    const run = bridge?.commands.find((command) => command.name() === "run");
    expect(run).toBeDefined();
    expect(run?.options.some((option) => option.long === "--token-file")).toBe(true);
    expect(run?.options.some((option) => option.long === "--egress")).toBe(true);
  });

  it("refuses to start with no token available at all", async () => {
    const fetchImpl = vi.fn();
    await expect(
      bridgeRun(
        { server: "http://localhost:3100", egress: "loopback" },
        baseDeps({ env: {}, fetchImpl }),
      ),
    ).rejects.toThrow(/AGENTDASH_BRIDGE_TOKEN|--token-file/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to start with no server URL", async () => {
    const fetchImpl = vi.fn();
    await expect(
      bridgeRun(
        { egress: "loopback" },
        baseDeps({ env: { AGENTDASH_BRIDGE_TOKEN: "tok" }, fetchImpl }),
      ),
    ).rejects.toThrow(/AGENTDASH_BRIDGE_SERVER|--server/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("agentdash bridge run — startup posture", () => {
  it("reads the token from a file and logs the weaker posture under --egress direct", async () => {
    const tokenFile = path.join(scratch, "token");
    writeFileSync(tokenFile, "file-token\n", { mode: 0o600 });

    const controller = new AbortController();
    const { impl, calls } = makeFetch([{ task: null }]);
    const log = vi.fn();

    await bridgeRun(
      {
        server: "http://localhost:3100",
        egress: "direct",
        tokenFile,
        workspaceRoot: scratch,
      },
      baseDeps({
        log,
        fetchImpl: impl,
        stopSignal: controller.signal,
        sleep: stopAfterPolls(1, calls, controller),
      }),
    );

    const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toMatch(/weaker/i);
    expect(logged).toMatch(/direct/);
    expect(calls[0]?.headers.Authorization).toBe("Bearer file-token");
  });
});

describe("agentdash bridge run — poll loop", () => {
  const taskReply = {
    task: {
      id: "task-1",
      taskClass: "read",
      instruction: "summarise the notes",
      leaseExpiresAt: null,
    },
    resultToken: "rt-1",
  };

  it("keeps polling when the server is idle and submits nothing", async () => {
    const controller = new AbortController();
    const { impl, calls, pathsOf } = makeFetch([{ task: null }]);
    const executor = vi.fn();

    await bridgeRun(
      { server: "http://localhost:3100", egress: "loopback", workspaceRoot: scratch },
      baseDeps({
        env: { AGENTDASH_BRIDGE_TOKEN: "tok" },
        fetchImpl: impl,
        executor,
        stopSignal: controller.signal,
        sleep: stopAfterPolls(3, calls, controller),
      }),
    );

    expect(pathsOf().filter((p) => p === "/api/bridge/poll").length).toBeGreaterThanOrEqual(3);
    expect(pathsOf()).not.toContain("/api/bridge/result");
    expect(pathsOf()).not.toContain("/api/bridge/decline");
    expect(executor).not.toHaveBeenCalled();
  });

  it("runs a task in a fresh sandboxed workspace and submits the result", async () => {
    const controller = new AbortController();
    const { impl, calls, pathsOf } = makeFetch([taskReply, { task: null }]);

    let seen: ExecutorContext | null = null;
    let profileDuringRun = "";
    let instructionDuringRun = "";
    const executor = vi.fn(async (ctx: ExecutorContext) => {
      seen = ctx;
      profileDuringRun = readFileSync(ctx.profilePath, "utf8");
      instructionDuringRun = readFileSync(path.join(ctx.workspaceDir, "INSTRUCTION.md"), "utf8");
      return "the summary";
    });

    await bridgeRun(
      { server: "http://localhost:3100", egress: "loopback", workspaceRoot: scratch },
      baseDeps({
        env: { AGENTDASH_BRIDGE_TOKEN: "tok" },
        fetchImpl: impl,
        executor,
        homeDir: "/Users/operator",
        stopSignal: controller.signal,
        sleep: stopAfterPolls(2, calls, controller),
      }),
    );

    expect(executor).toHaveBeenCalledTimes(1);
    const result = calls.find((call) => call.path === "/api/bridge/result");
    expect(result).toBeDefined();
    expect(result?.body).toMatchObject({
      taskId: "task-1",
      resultToken: "rt-1",
      result: "the summary",
    });
    expect(result?.headers.Authorization).toBe("Bearer tok");
    expect(pathsOf()).not.toContain("/api/bridge/decline");

    // The instruction reached the workspace, and the profile the worker actually
    // wrote has the home deny above the workspace allow.
    expect(instructionDuringRun).toContain("summarise the notes");
    const denyIndex = profileDuringRun.indexOf('(deny file-read* file-write* (subpath "/Users/operator"))');
    const allowIndex = profileDuringRun.indexOf(
      `(allow file-read* file-write* (subpath "${seen!.workspaceDir}"))`,
    );
    expect(denyIndex).toBeGreaterThanOrEqual(0);
    expect(allowIndex).toBeGreaterThan(denyIndex);

    // Workspace is gone once the task is done.
    expect(existsSync(seen!.workspaceDir)).toBe(false);
  });

  it("declines instead of submitting when the executor fails, and still cleans up", async () => {
    const controller = new AbortController();
    const { impl, calls, pathsOf } = makeFetch([taskReply, { task: null }]);

    let workspaceDir = "";
    const executor = vi.fn(async (ctx: ExecutorContext) => {
      workspaceDir = ctx.workspaceDir;
      expect(existsSync(workspaceDir)).toBe(true);
      throw new Error("claude exited with code 1: boom");
    });

    await bridgeRun(
      { server: "http://localhost:3100", egress: "loopback", workspaceRoot: scratch },
      baseDeps({
        env: { AGENTDASH_BRIDGE_TOKEN: "tok" },
        fetchImpl: impl,
        executor,
        stopSignal: controller.signal,
        sleep: stopAfterPolls(2, calls, controller),
      }),
    );

    expect(pathsOf()).not.toContain("/api/bridge/result");
    const decline = calls.find((call) => call.path === "/api/bridge/decline");
    expect(decline).toBeDefined();
    expect(decline?.body).toMatchObject({ taskId: "task-1", resultToken: "rt-1" });
    expect(String(decline?.body.reason)).toContain("boom");
    expect(existsSync(workspaceDir)).toBe(false);
  });

  it("truncates an oversized result with a visible marker", async () => {
    const controller = new AbortController();
    const { impl, calls } = makeFetch([taskReply, { task: null }]);
    const executor = vi.fn(async () => "y".repeat(400 * 1024));

    await bridgeRun(
      { server: "http://localhost:3100", egress: "loopback", workspaceRoot: scratch },
      baseDeps({
        env: { AGENTDASH_BRIDGE_TOKEN: "tok" },
        fetchImpl: impl,
        executor,
        stopSignal: controller.signal,
        sleep: stopAfterPolls(2, calls, controller),
      }),
    );

    const result = calls.find((call) => call.path === "/api/bridge/result");
    const submitted = String(result?.body.result);
    expect(submitted).toMatch(/truncated/i);
    expect(Buffer.byteLength(submitted, "utf8")).toBeLessThan(300 * 1024);
  });

  it("gives the executor headroom above the submit cap so a cut is never silent", async () => {
    // If the executor buffered exactly the cap, an oversized result would land
    // on exactly the cap and be submitted unmarked.
    const controller = new AbortController();
    const { impl, calls } = makeFetch([taskReply, { task: null }]);
    let budget = 0;
    const executor = vi.fn(async (ctx: ExecutorContext) => {
      budget = ctx.maxOutputBytes;
      return "ok";
    });

    await bridgeRun(
      { server: "http://localhost:3100", egress: "loopback", workspaceRoot: scratch },
      baseDeps({
        env: { AGENTDASH_BRIDGE_TOKEN: "tok" },
        fetchImpl: impl,
        executor,
        stopSignal: controller.signal,
        sleep: stopAfterPolls(2, calls, controller),
      }),
    );

    expect(budget).toBeGreaterThan(256 * 1024);
  });

  it("uses the real sandbox-exec spawn path when no executor is injected", async () => {
    const controller = new AbortController();
    const { impl, calls } = makeFetch([taskReply, { task: null }]);

    hoisted.spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
      };
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });
      queueMicrotask(async () => {
        child.stdout.push("spawned output");
        child.stdout.push(null);
        child.stderr.push(null);
        // 'close' only after the stdio streams drain, as Node guarantees.
        await Promise.all([once(child.stdout, "end"), once(child.stderr, "end")]);
        child.emit("close", 0, null);
      });
      return child;
    });

    await bridgeRun(
      {
        server: "http://localhost:3100",
        egress: "loopback",
        workspaceRoot: scratch,
        claudeBin: "/usr/local/bin/claude",
      },
      baseDeps({
        env: { AGENTDASH_BRIDGE_TOKEN: "tok" },
        fetchImpl: impl,
        stopSignal: controller.signal,
        sleep: stopAfterPolls(2, calls, controller),
      }),
    );

    expect(hoisted.spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, options] = hoisted.spawnMock.mock.calls[0] as [
      string,
      string[],
      { cwd?: string },
    ];
    expect(bin).toBe("/usr/bin/sandbox-exec");
    expect(args[0]).toBe("-f");
    expect(args[2]).toBe("/usr/local/bin/claude");
    expect(args[3]).toBe("-p");
    expect(args[4]).toBe("summarise the notes");
    expect(options.cwd).toBe(path.dirname(args[1]));

    const result = calls.find((call) => call.path === "/api/bridge/result");
    expect(result?.body.result).toBe("spawned output");
  });
});
