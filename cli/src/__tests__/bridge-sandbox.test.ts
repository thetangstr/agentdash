import { EventEmitter, once } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => hoisted.spawnMock(...args),
}));

import {
  MDNSRESPONDER_SOCKET,
  SANDBOX_EXEC_PATH,
  assertSandboxSupported,
  buildSandboxProfile,
  defaultExecutor,
  parseEgressPolicy,
} from "../bridge/sandbox.js";

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = vi.fn();
  return child;
}

/**
 * Node emits ChildProcess 'close' only after the stdio streams have closed, so
 * a fixture that fires it earlier would be testing a process that cannot exist.
 * Close the streams, wait for them to drain, then emit.
 */
async function finishChild(child: FakeChild, code: number, out?: string, err?: string): Promise<void> {
  if (out !== undefined) child.stdout.push(out);
  if (err !== undefined) child.stderr.push(err);
  child.stdout.push(null);
  child.stderr.push(null);
  await Promise.all([once(child.stdout, "end"), once(child.stderr, "end")]);
  child.emit("close", code, null);
}

const task = {
  id: "task-1",
  taskClass: "read" as const,
  instruction: "summarise the notes",
  leaseExpiresAt: null,
};

beforeEach(() => {
  hoisted.spawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseEgressPolicy", () => {
  it("refuses to pick an egress policy by omission", () => {
    expect(() => parseEgressPolicy(undefined)).toThrow(/--egress/);
    expect(() => parseEgressPolicy("")).toThrow(/--egress/);
  });

  it("refuses an unknown policy", () => {
    expect(() => parseEgressPolicy("wide-open")).toThrow(/loopback/);
  });

  it("accepts the two supported policies", () => {
    expect(parseEgressPolicy("loopback")).toBe("loopback");
    expect(parseEgressPolicy("direct")).toBe("direct");
  });
});

describe("assertSandboxSupported", () => {
  it("refuses to run anywhere but macOS", () => {
    expect(() =>
      assertSandboxSupported({ platform: "linux", isExecutable: () => true }),
    ).toThrow(/darwin|macOS/i);
  });

  it("refuses when sandbox-exec is not executable", () => {
    const isExecutable = vi.fn(() => false);
    expect(() => assertSandboxSupported({ platform: "darwin", isExecutable })).toThrow(
      /sandbox-exec/,
    );
    expect(isExecutable).toHaveBeenCalledWith(SANDBOX_EXEC_PATH);
  });

  it("passes on macOS with sandbox-exec present", () => {
    expect(() =>
      assertSandboxSupported({ platform: "darwin", isExecutable: () => true }),
    ).not.toThrow();
  });
});

describe("buildSandboxProfile", () => {
  const base = { homeDir: "/Users/operator", workspaceDir: "/var/tmp/ws-1" };

  it("denies the home directory BEFORE re-opening the workspace", () => {
    // Order is load-bearing: later rules win in SBPL. If the workspace allow
    // came first the home deny would swallow it and nothing would run.
    for (const egress of ["loopback", "direct"] as const) {
      const profile = buildSandboxProfile({ ...base, egress });
      const denyIndex = profile.indexOf('(deny file-read* file-write* (subpath "/Users/operator"))');
      const allowIndex = profile.indexOf('(allow file-read* file-write* (subpath "/var/tmp/ws-1"))');
      expect(denyIndex, `home deny missing under ${egress}`).toBeGreaterThanOrEqual(0);
      expect(allowIndex, `workspace allow missing under ${egress}`).toBeGreaterThanOrEqual(0);
      expect(denyIndex).toBeLessThan(allowIndex);
    }
  });

  it("keeps the validated preamble", () => {
    const profile = buildSandboxProfile({ ...base, egress: "loopback" });
    expect(profile.startsWith("(version 1)\n(allow default)")).toBe(true);
    // Whole-filesystem deny-by-default killed the process before main().
    expect(profile).not.toContain("(deny default)");
  });

  it("emits the loopback-only egress lines under the loopback policy", () => {
    const profile = buildSandboxProfile({ ...base, egress: "loopback" });
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
    expect(profile).toContain('(allow network-bind    (local  ip "localhost:*"))');
    expect(profile).not.toContain("443");
  });

  it("emits the 443 allow under the direct policy and drops the loopback lines", () => {
    const profile = buildSandboxProfile({ ...base, egress: "direct" });
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain('(allow network-outbound (remote ip "*:443"))');
    expect(profile).not.toContain('(remote ip "localhost:*")');
  });

  it("allows DNS under the direct policy, without which the 443 allow does nothing", () => {
    // Verified live: `(deny network*)` closes the mDNSResponder socket, so a
    // profile with the 443 allow but no DNS reaches raw IPs and resolves no
    // hostname at all — `direct` would look configured and be inert. Loopback
    // does not need it: the proxy resolves on the task's behalf.
    const direct = buildSandboxProfile({ ...base, egress: "direct" });
    expect(direct).toContain(`(allow network-outbound (literal "${MDNSRESPONDER_SOCKET}"))`);

    const loopback = buildSandboxProfile({ ...base, egress: "loopback" });
    expect(loopback).not.toContain(MDNSRESPONDER_SOCKET);
  });

  it("refuses paths that would break out of the SBPL string literal", () => {
    expect(() =>
      buildSandboxProfile({ homeDir: '/Users/o"peratr', workspaceDir: "/var/tmp/ws", egress: "loopback" }),
    ).toThrow();
    expect(() =>
      buildSandboxProfile({ homeDir: "/Users/o", workspaceDir: "relative/ws", egress: "loopback" }),
    ).toThrow();
  });
});

describe("defaultExecutor", () => {
  it("spawns sandbox-exec with the profile, the claude binary, and the workspace as cwd", async () => {
    const child = fakeChild();
    hoisted.spawnMock.mockReturnValue(child);

    const promise = defaultExecutor({
      task,
      workspaceDir: "/var/tmp/ws-1",
      profilePath: "/var/tmp/ws-1/sandbox.sb",
      claudeBin: "/usr/local/bin/claude",
      maxOutputBytes: 1024,
    });

    await finishChild(child, 0, "the summary");

    await expect(promise).resolves.toBe("the summary");

    expect(hoisted.spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, options] = hoisted.spawnMock.mock.calls[0] as [
      string,
      string[],
      { cwd?: string; env?: NodeJS.ProcessEnv },
    ];
    expect(bin).toBe(SANDBOX_EXEC_PATH);
    expect(args).toEqual([
      "-f",
      "/var/tmp/ws-1/sandbox.sb",
      "/usr/local/bin/claude",
      "-p",
      "summarise the notes",
    ]);
    // chdir happens as part of the spawn — with home denied, getcwd fails from
    // anywhere inside it and relative path resolution breaks.
    expect(options.cwd).toBe("/var/tmp/ws-1");
  });

  it("never hands the bridge credential to the sandboxed task", async () => {
    const child = fakeChild();
    hoisted.spawnMock.mockReturnValue(child);
    vi.stubEnv("AGENTDASH_BRIDGE_TOKEN", "super-secret");

    const promise = defaultExecutor({
      task,
      workspaceDir: "/var/tmp/ws-1",
      profilePath: "/var/tmp/ws-1/sandbox.sb",
      claudeBin: "claude",
      maxOutputBytes: 1024,
    });
    await finishChild(child, 0);
    await promise;

    const [, , options] = hoisted.spawnMock.mock.calls[0] as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv },
    ];
    expect(options.env).toBeDefined();
    expect(options.env?.AGENTDASH_BRIDGE_TOKEN).toBeUndefined();
  });

  it("rejects on a non-zero exit with the stderr tail in the reason", async () => {
    const child = fakeChild();
    hoisted.spawnMock.mockReturnValue(child);

    const promise = defaultExecutor({
      task,
      workspaceDir: "/var/tmp/ws-1",
      profilePath: "/var/tmp/ws-1/sandbox.sb",
      claudeBin: "claude",
      maxOutputBytes: 1024,
    });

    await finishChild(child, 3, undefined, "sandbox denied something");

    await expect(promise).rejects.toThrow(/exit(ed)? (code )?3|code 3/);
    await promise.catch((err: Error) => {
      expect(err.message).toContain("sandbox denied something");
    });
  });

  it("rejects when the process cannot be spawned at all", async () => {
    const child = fakeChild();
    hoisted.spawnMock.mockReturnValue(child);

    const promise = defaultExecutor({
      task,
      workspaceDir: "/var/tmp/ws-1",
      profilePath: "/var/tmp/ws-1/sandbox.sb",
      claudeBin: "claude",
      maxOutputBytes: 1024,
    });
    child.emit("error", new Error("ENOENT"));

    await expect(promise).rejects.toThrow(/ENOENT/);
  });

  it("bounds how much output it buffers", async () => {
    const child = fakeChild();
    hoisted.spawnMock.mockReturnValue(child);

    const promise = defaultExecutor({
      task,
      workspaceDir: "/var/tmp/ws-1",
      profilePath: "/var/tmp/ws-1/sandbox.sb",
      claudeBin: "claude",
      maxOutputBytes: 32,
    });

    await finishChild(child, 0, "x".repeat(4096));

    const output = await promise;
    expect(output.length).toBeLessThanOrEqual(32);
  });
});
