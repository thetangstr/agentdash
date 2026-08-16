import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSandboxProfile, assertSandboxSupported } from "./seatbelt.js";
import { runChildProcess } from "./server-utils.js";

/**
 * Containment, asserted by running something and watching it be denied.
 *
 * A profile test that only inspects the generated SBPL text proves that we
 * wrote what we meant to write, not that the kernel agrees with us. Seatbelt
 * has enough sharp edges — rule order, the mDNSResponder socket, `getcwd`
 * failing from inside a denied directory — that "reads correct" and "actually
 * confines" have already come apart once in this codebase's history.
 *
 * So the load-bearing cases below spawn a real child under `sandbox-exec` and
 * check what it could and could not touch.
 */

const isDarwin = process.platform === "darwin";
const describeDarwin = isDarwin ? describe : describe.skip;

if (!isDarwin) {
  console.warn(`Skipping Seatbelt containment tests on ${process.platform}: sandbox-exec is macOS-only.`);
}

describe("buildSandboxProfile", () => {
  const base = { homeDir: "/Users/probe", workspaceDir: "/Users/probe/work", egress: "loopback" as const };

  it("denies home before allowing the workspace", () => {
    // Rule ORDER is the property, not rule presence. Later rules win in SBPL,
    // so an allow above the deny is silently dead and the workspace becomes
    // unreachable — nothing runs, and it looks like a path bug.
    const profile = buildSandboxProfile(base);
    const denyAt = profile.indexOf('(deny file-read* file-write* (subpath "/Users/probe"))');
    const allowAt = profile.indexOf('(allow file-read* file-write* (subpath "/Users/probe/work"))');
    expect(denyAt).toBeGreaterThan(-1);
    expect(allowAt).toBeGreaterThan(denyAt);
  });

  it("denies home under every egress policy", () => {
    // The home deny is not a dial. Stated in the source; asserted here so that
    // stays true of the code rather than of the comment.
    for (const egress of ["loopback", "direct"] as const) {
      expect(buildSandboxProfile({ ...base, egress })).toContain(
        '(deny file-read* file-write* (subpath "/Users/probe"))',
      );
    }
  });

  it("keeps the DNS socket open under direct egress and not under loopback", () => {
    // Without it, `(deny network*)` closes name resolution and the 443 allow
    // silently does nothing — the mode looks enabled and is useless.
    expect(buildSandboxProfile({ ...base, egress: "direct" })).toContain("mDNSResponder");
    expect(buildSandboxProfile({ ...base, egress: "loopback" })).not.toContain("mDNSResponder");
  });

  it("refuses a relative path rather than emitting a broken profile", () => {
    expect(() => buildSandboxProfile({ ...base, workspaceDir: "work" })).toThrow(/absolute path/);
  });

  it("refuses a path that cannot be represented in an SBPL literal", () => {
    // SBPL has no escape syntax worth trusting, so a quote in a path must be
    // refused rather than quoted — otherwise the profile parses as something
    // other than what was intended.
    expect(() => buildSandboxProfile({ ...base, workspaceDir: '/Users/probe/a"b' })).toThrow(/SBPL/);
    expect(() => buildSandboxProfile({ ...base, workspaceDir: "/Users/probe/a\nb" })).toThrow(/SBPL/);
  });

  it("re-opens extra runtime paths below the home deny", () => {
    const profile = buildSandboxProfile({ ...base, readWritePaths: ["/Users/probe/.agentdash"] });
    const denyAt = profile.indexOf('(deny file-read* file-write* (subpath "/Users/probe"))');
    const extraAt = profile.indexOf('(allow file-read* file-write* (subpath "/Users/probe/.agentdash"))');
    expect(extraAt).toBeGreaterThan(denyAt);
  });
});

describeDarwin("Seatbelt actually confines the child", () => {
  let home!: string;
  let workspace!: string;
  let secret!: string;
  let inWorkspace!: string;

  beforeAll(async () => {
    // A fake home under the real temp dir, so the test denies a tree it owns
    // rather than the developer's actual home.
    home = await fs.mkdtemp(path.join(os.tmpdir(), "agentdash-sbtest-home-"));
    workspace = path.join(home, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    secret = path.join(home, "private.txt");
    inWorkspace = path.join(workspace, "allowed.txt");
    await fs.writeFile(secret, "operator private data\n");
    await fs.writeFile(inWorkspace, "workspace data\n");
  });

  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  async function runCat(target: string, opts: { sandboxed: boolean }) {
    const logs: string[] = [];
    return runChildProcess("test-run", "/bin/cat", [target], {
      cwd: workspace,
      env: {},
      timeoutSec: 20,
      graceSec: 2,
      onLog: async (_stream, chunk) => { logs.push(chunk); },
      localSandbox: opts.sandboxed ? { homeDir: home, egress: "loopback" } : null,
    });
  }

  it("lets the child read inside the workspace", async () => {
    // The control. Without it, a profile that denied everything would satisfy
    // the denial assertion below while breaking every real agent.
    const result = await runCat(inWorkspace, { sandboxed: true });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("workspace data");
  }, 30_000);

  it("stops the child reading the operator's home", async () => {
    // The whole point. Same command, same run, one path outside the workspace.
    const result = await runCat(secret, { sandboxed: true });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("operator private data");
  }, 30_000);

  it("reads that same file fine WITHOUT the sandbox", async () => {
    // Proves the denial above came from the sandbox and not from a missing
    // file, a permissions problem, or a broken fixture.
    const result = await runCat(secret, { sandboxed: false });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("operator private data");
  }, 30_000);

  it("leaves no profile file behind", async () => {
    const before = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("agentdash-sbpl-"));
    await runCat(inWorkspace, { sandboxed: true });
    const after = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("agentdash-sbpl-"));
    // The profile names the workspace and every hole in the confinement. It is
    // a map, and it should not accumulate in a world-readable directory.
    expect(after.length).toBeLessThanOrEqual(before.length);
  }, 30_000);
});

describe("assertSandboxSupported", () => {
  it("refuses to proceed on a platform with no Seatbelt", () => {
    // No fallback, by design: a caller that asked for confinement and silently
    // ran without it is worse off than one that failed to start.
    expect(() => assertSandboxSupported({ platform: "linux" })).toThrow(/requires macOS/);
  });

  it("refuses when sandbox-exec is not executable", () => {
    expect(() => assertSandboxSupported({ platform: "darwin", isExecutable: () => false })).toThrow(
      /not executable/,
    );
  });

  it("accepts a host that has it", () => {
    expect(() => assertSandboxSupported({ platform: "darwin", isExecutable: () => true })).not.toThrow();
  });
});
