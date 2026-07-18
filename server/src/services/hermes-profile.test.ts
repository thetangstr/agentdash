import { describe, expect, it, vi } from "vitest";
import {
  agentProfileCommand,
  agentProfileName,
  deprovisionAgentProfile,
  ensureAgentProfileCommand,
  provisionAgentProfile,
  type HermesProfileDeps,
} from "./hermes-profile.js";

function harness(env: NodeJS.ProcessEnv = {}) {
  const runs: string[][] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const wrappers: Array<{ path: string; content: string }> = [];
  const removed: string[] = [];
  // models the real filesystem: writing a wrapper makes it exist; removing clears it.
  const existing = new Set<string>();
  const deps: HermesProfileDeps = {
    hermesBin: "hermes",
    profilesDir: "/profiles",
    binDir: "/bin",
    env,
    run: vi.fn(async (args: string[]) => {
      runs.push(args);
      return { stdout: "", stderr: "" };
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      writes.push({ path, content });
    }),
    writeWrapper: vi.fn(async (path: string, content: string) => {
      wrappers.push({ path, content });
      existing.add(path);
    }),
    removeFile: vi.fn(async (path: string) => {
      removed.push(path);
      existing.delete(path);
    }),
    exists: (path: string) => existing.has(path),
  };
  return { deps, runs, writes, wrappers, removed, existing };
}

describe("agentProfileName", () => {
  it("namespaces + sanitizes to lowercase alphanumeric", () => {
    expect(agentProfileName("5405F956-9187-443C")).toBe("agentdash-5405f9569187443c");
    expect(agentProfileName("Tara_42")).toBe("agentdash-tara42");
  });
});

describe("agentProfileCommand", () => {
  it("is the alias wrapper path under binDir", () => {
    expect(agentProfileCommand("abc", { binDir: "/bin" })).toBe("/bin/agentdash-abc");
  });
});

describe("provisionAgentProfile", () => {
  it("clones the template via --clone-from, then overlays the gateway .env", async () => {
    const { deps, runs, writes, wrappers } = harness({
      AGENTDASH_GATEWAY_BASE_URL: "https://gw/v1",
      AGENTDASH_GATEWAY_API_KEY: "sk-gw",
    });
    const res = await provisionAgentProfile("agent-1", {}, deps);

    expect(res.profileName).toBe("agentdash-agent1");
    expect(res.providerSource).toBe("gateway");
    expect(res.command).toBe("/bin/agentdash-agent1");
    // create CLONES from the template (the cp approach yields HTTP 401)
    expect(runs[0]).toEqual([
      "profile",
      "create",
      "agentdash-agent1",
      "--clone-from",
      "agentdash",
      "--no-alias",
      "--description",
      "AgentDash agent agent-1",
    ]);
    // no `profile alias` run — the wrapper is written directly (bare-hermes alias
    // fails with exit 127 under the adapter PATH)
    expect(runs).not.toContainEqual(["profile", "alias", "agentdash-agent1"]);
    expect(wrappers).toHaveLength(1);
    expect(wrappers[0].path).toBe("/bin/agentdash-agent1");
    expect(wrappers[0].content).toContain("exec hermes -p agentdash-agent1");
    expect(wrappers[0].content).toContain("PATH=");
    // overlays a gateway-pointed .env onto the cloned base
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/profiles/agentdash-agent1/.env");
    expect(writes[0].content).toContain("https://gw/v1");
    expect(writes[0].content).toContain("sk-gw");
  });

  it("clones the template (no gateway env) and writes the wrapper", async () => {
    const { deps, runs, writes, wrappers } = harness({});
    const res = await provisionAgentProfile("agent-2", { template: "agentdash" }, deps);

    expect(res.providerSource).toBe("template");
    expect(runs[0]).toEqual([
      "profile",
      "create",
      "agentdash-agent2",
      "--clone-from",
      "agentdash",
      "--no-alias",
      "--description",
      "AgentDash agent agent-2",
    ]);
    expect(writes).toHaveLength(0);
    expect(wrappers).toHaveLength(1);
    expect(wrappers[0].path).toBe("/bin/agentdash-agent2");
    expect(wrappers[0].content).toContain("exec hermes -p agentdash-agent2");
  });
});

describe("ensureAgentProfileCommand", () => {
  it("provisions the profile when missing and returns the wrapper command", async () => {
    const { deps, runs, wrappers } = harness({});
    const cmd = await ensureAgentProfileCommand("agent-9", deps);
    expect(cmd).toBe("/bin/agentdash-agent9");
    // it ran a clone-from create and wrote the wrapper
    expect(runs[0].slice(0, 5)).toEqual([
      "profile",
      "create",
      "agentdash-agent9",
      "--clone-from",
      "agentdash",
    ]);
    expect(wrappers).toHaveLength(1);
    expect(wrappers[0].path).toBe("/bin/agentdash-agent9");
  });

  it("does not re-provision when the wrapper already exists", async () => {
    const { deps, runs } = harness({});
    await ensureAgentProfileCommand("agent-9", deps);
    const callsAfterFirst = runs.length;
    const cmd = await ensureAgentProfileCommand("agent-9", deps);
    expect(cmd).toBe("/bin/agentdash-agent9");
    expect(runs.length).toBe(callsAfterFirst); // no new hermes calls
  });

  it("returns undefined when there is no agentId", async () => {
    const { deps, runs } = harness({});
    expect(await ensureAgentProfileCommand(undefined, deps)).toBeUndefined();
    expect(await ensureAgentProfileCommand(null, deps)).toBeUndefined();
    expect(runs).toHaveLength(0);
  });

  it("is non-fatal: returns undefined when provisioning fails", async () => {
    const { deps } = harness({});
    deps.run = vi.fn(async () => {
      throw new Error("hermes not found");
    });
    expect(await ensureAgentProfileCommand("agent-9", deps)).toBeUndefined();
  });
});

describe("deprovisionAgentProfile", () => {
  it("removes the wrapper file and deletes the profile", async () => {
    const { deps, runs, removed } = harness({});
    await deprovisionAgentProfile("agent-3", deps);
    expect(removed).toEqual(["/bin/agentdash-agent3"]);
    expect(runs).toEqual([["profile", "delete", "agentdash-agent3", "-y"]]);
  });

  it("never throws when hermes/fs errors (best-effort cleanup)", async () => {
    const deps: HermesProfileDeps = {
      binDir: "/bin",
      profilesDir: "/profiles",
      env: {},
      run: vi.fn(async () => {
        throw new Error("profile not found");
      }),
      removeFile: vi.fn(async () => {
        throw new Error("wrapper missing");
      }),
    };
    await expect(deprovisionAgentProfile("agent-4", deps)).resolves.toBeUndefined();
  });
});
