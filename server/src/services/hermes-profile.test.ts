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
  };
  return { deps, runs, writes };
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
    const { deps, runs, writes } = harness({
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
    expect(runs.at(-1)).toEqual(["profile", "alias", "agentdash-agent1"]);
    // overlays a gateway-pointed .env onto the cloned base
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/profiles/agentdash-agent1/.env");
    expect(writes[0].content).toContain("https://gw/v1");
    expect(writes[0].content).toContain("sk-gw");
  });

  it("clones the template (no gateway env) and writes nothing extra", async () => {
    const { deps, runs, writes } = harness({});
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
