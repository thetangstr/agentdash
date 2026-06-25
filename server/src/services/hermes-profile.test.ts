import { describe, expect, it, vi } from "vitest";
import {
  agentProfileCommand,
  agentProfileName,
  deprovisionAgentProfile,
  provisionAgentProfile,
  type HermesProfileDeps,
} from "./hermes-profile.js";

function harness(env: NodeJS.ProcessEnv = {}) {
  const runs: string[][] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const copies: Array<{ src: string; dst: string }> = [];
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
    copyFile: vi.fn(async (src: string, dst: string) => {
      copies.push({ src, dst });
    }),
  };
  return { deps, runs, writes, copies };
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
  it("gateway-points the provider when AGENTDASH_GATEWAY_* is set", async () => {
    const { deps, runs, writes, copies } = harness({
      AGENTDASH_GATEWAY_BASE_URL: "https://gw/v1",
      AGENTDASH_GATEWAY_API_KEY: "sk-gw",
    });
    const res = await provisionAgentProfile("agent-1", {}, deps);

    expect(res.profileName).toBe("agentdash-agent1");
    expect(res.providerSource).toBe("gateway");
    expect(res.command).toBe("/bin/agentdash-agent1");
    // create + alias were run
    expect(runs[0].slice(0, 3)).toEqual(["profile", "create", "agentdash-agent1"]);
    expect(runs.at(-1)).toEqual(["profile", "alias", "agentdash-agent1"]);
    // wrote a gateway-pointed .env into the profile dir, no template copy
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/profiles/agentdash-agent1/.env");
    expect(writes[0].content).toContain("https://gw/v1");
    expect(writes[0].content).toContain("sk-gw");
    expect(copies).toHaveLength(0);
  });

  it("copies managed provider config from the template when no gateway env", async () => {
    const { deps, writes, copies } = harness({});
    const res = await provisionAgentProfile("agent-2", { template: "agentdash" }, deps);

    expect(res.providerSource).toBe("template");
    expect(writes).toHaveLength(0);
    // copies .env/config.yaml/auth.json from the template into the profile
    expect(copies.map((c) => c.src)).toEqual([
      "/profiles/agentdash/.env",
      "/profiles/agentdash/config.yaml",
      "/profiles/agentdash/auth.json",
    ]);
    expect(copies.every((c) => c.dst.startsWith("/profiles/agentdash-agent2/"))).toBe(true);
  });
});

describe("deprovisionAgentProfile", () => {
  it("removes the alias and deletes the profile", async () => {
    const { deps, runs } = harness({});
    await deprovisionAgentProfile("agent-3", deps);
    expect(runs).toEqual([
      ["profile", "alias", "agentdash-agent3", "--remove"],
      ["profile", "delete", "agentdash-agent3", "-y"],
    ]);
  });

  it("never throws when hermes errors (best-effort cleanup)", async () => {
    const deps: HermesProfileDeps = {
      binDir: "/bin",
      profilesDir: "/profiles",
      env: {},
      run: vi.fn(async () => {
        throw new Error("profile not found");
      }),
    };
    await expect(deprovisionAgentProfile("agent-4", deps)).resolves.toBeUndefined();
  });
});
