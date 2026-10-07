import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HERMES_SSH_ALLOWLIST_ENV,
  HERMES_SSH_ENABLED_ENV,
  assertHermesSshLaunchReady,
  evaluateHermesSshEnvironment,
  hermesSshConnectionFor,
  hermesSshEnabled,
  readHermesSshAllowlist,
} from "../services/hermes-ssh-policy.js";

const FOUNDER_COMPANY = "0008870a-4a07-4e09-9a3e-1998f4c7d640";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const KEY = "/etc/agentdash/ssh/ac-provider_ed25519";
const KNOWN_HOSTS = "/etc/agentdash/ssh/known_hosts";

function entry(companies: string[], extra: Record<string, unknown> = {}) {
  return { companies, identityFile: KEY, knownHostsFile: KNOWN_HOSTS, ...extra };
}

function envWith(allowlist: unknown, enabled = "true"): NodeJS.ProcessEnv {
  return {
    [HERMES_SSH_ENABLED_ENV]: enabled,
    [HERMES_SSH_ALLOWLIST_ENV]: typeof allowlist === "string" ? allowlist : JSON.stringify(allowlist),
  };
}

// A company's SSH environment only NAMES the target; it carries no key paths.
const environmentConfig = {
  host: "127.0.0.1",
  port: 22,
  username: "ac-provider",
  remoteWorkspacePath: "/Users/ac-provider/agentdash",
  strictHostKeyChecking: true,
};

describe("hermes SSH policy", () => {
  it("is off unless AGENTDASH_HERMES_SSH_ENABLED is exactly true", () => {
    expect(hermesSshEnabled({})).toBe(false);
    expect(hermesSshEnabled({ [HERMES_SSH_ENABLED_ENV]: "1" })).toBe(false);
    expect(hermesSshEnabled({ [HERMES_SSH_ENABLED_ENV]: "yes" })).toBe(false);
    expect(hermesSshEnabled({ [HERMES_SSH_ENABLED_ENV]: "true" })).toBe(true);
  });

  it("parses operator entries (key paths and port included) and rejects malformed ones instead of guessing", () => {
    const parsed = readHermesSshAllowlist(envWith({
      "ac-provider@127.0.0.1": entry([FOUNDER_COMPANY]),
      "ac-prov-b@mini.local": entry([FOUNDER_COMPANY, OTHER_COMPANY], { port: 2222 }),
      "root;rm -rf /@127.0.0.1": entry([FOUNDER_COMPANY]),
      "-oProxyCommand=evil@127.0.0.1": entry([FOUNDER_COMPANY]),
      "ac-provider@-oProxyCommand=x": entry([FOUNDER_COMPANY]),
      "ac-provider@127.0.0.1:22": entry([FOUNDER_COMPANY]),
      "ac-prov-c@127.0.0.1": entry(["not-a-uuid"]),
      "ac-prov-d@127.0.0.1": [FOUNDER_COMPANY],
      "ac-prov-e@127.0.0.1": entry([FOUNDER_COMPANY], { identityFile: "keys/id_ed25519" }),
      "ac-prov-f@127.0.0.1": entry([FOUNDER_COMPANY], { knownHostsFile: undefined }),
      "ac-prov-g@127.0.0.1": entry([FOUNDER_COMPANY], { port: 70000 }),
      "ac-prov-h@127.0.0.1": entry([FOUNDER_COMPANY], { port: "22" }),
    }));
    expect(parsed.entries.map((e) => `${e.target}:${e.port}`)).toEqual([
      "ac-provider@127.0.0.1:22",
      "ac-prov-b@mini.local:2222",
    ]);
    expect(parsed.entries[1]?.companyIds).toEqual([FOUNDER_COMPANY, OTHER_COMPANY]);
    expect(parsed.entries[0]).toMatchObject({ identityFile: KEY, knownHostsFile: KNOWN_HOSTS });
    expect(parsed.problems.length).toBe(10);
  });

  it("treats unparseable allowlist JSON as an empty list", () => {
    const parsed = readHermesSshAllowlist(envWith("{not json"));
    expect(parsed.entries).toEqual([]);
    expect(parsed.problems).toHaveLength(1);
    expect(readHermesSshAllowlist({}).entries).toEqual([]);
  });

  it("allows an allowlisted target for its company and connects only with operator values", () => {
    const decision = evaluateHermesSshEnvironment(
      // Even if a stored config somehow carried paths, they are never read.
      { companyId: FOUNDER_COMPANY, config: { ...environmentConfig, identityFile: "/tmp/evil", knownHostsFile: "/tmp/evil" } },
      envWith({ "ac-provider@127.0.0.1": entry([FOUNDER_COMPANY]) }),
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.target).toBe("ac-provider@127.0.0.1");
    expect(hermesSshConnectionFor(decision.entry)).toEqual({
      host: "127.0.0.1",
      port: 22,
      username: "ac-provider",
      privateKey: null,
      knownHosts: null,
      strictHostKeyChecking: true,
      identityFile: KEY,
      knownHostsFile: KNOWN_HOSTS,
    });
  });

  it("pins the port: an environment on another port is refused with 403", () => {
    const allow = envWith({ "ac-provider@127.0.0.1": entry([FOUNDER_COMPANY], { port: 2222 }) });
    expect(evaluateHermesSshEnvironment({ companyId: FOUNDER_COMPANY, config: environmentConfig }, allow))
      .toMatchObject({ ok: false, status: 403 });
    const decision = evaluateHermesSshEnvironment(
      { companyId: FOUNDER_COMPANY, config: { ...environmentConfig, port: 2222 } },
      allow,
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(hermesSshConnectionFor(decision.entry).port).toBe(2222);
  });

  it("refuses an allowlisted target for a different company with 403", () => {
    const decision = evaluateHermesSshEnvironment(
      { companyId: OTHER_COMPANY, config: environmentConfig },
      envWith({ "ac-provider@127.0.0.1": entry([FOUNDER_COMPANY]) }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.status).toBe(403);
    expect(decision.message).toContain("ac-provider@127.0.0.1");
    expect(decision.message).toContain("this company");
  });

  it("refuses a target that is not on the list with 403", () => {
    const decision = evaluateHermesSshEnvironment(
      { companyId: FOUNDER_COMPANY, config: { ...environmentConfig, username: "ac-buyer" } },
      envWith({ "ac-provider@127.0.0.1": entry([FOUNDER_COMPANY]) }),
    );
    expect(decision).toMatchObject({ ok: false, status: 403 });
    if (decision.ok) return;
    expect(decision.message).toContain("ac-buyer@127.0.0.1");
    expect(decision.message).toContain("allowed list");
  });

  it("refuses everything while the flag is off", () => {
    const decision = evaluateHermesSshEnvironment(
      { companyId: FOUNDER_COMPANY, config: environmentConfig },
      envWith({ "ac-provider@127.0.0.1": entry([FOUNDER_COMPANY]) }, "false"),
    );
    expect(decision).toMatchObject({ ok: false, status: 422 });
    if (!decision.ok) expect(decision.message).toContain("turned off");
  });

  it("refuses malformed user or host with 422", () => {
    for (const patch of [
      { username: "-oProxyCommand=evil" },
      { username: "Ac Provider" },
      { host: "-oProxyCommand=x" },
      { host: "127.0.0.1;id" },
    ]) {
      const decision = evaluateHermesSshEnvironment(
        { companyId: FOUNDER_COMPANY, config: { ...environmentConfig, ...patch } },
        envWith({ "ac-provider@127.0.0.1": entry([FOUNDER_COMPANY]) }),
      );
      expect(decision, JSON.stringify(patch)).toMatchObject({ ok: false, status: 422 });
    }
  });

  it("checks the operator's identity is ed25519 and its known_hosts pins a key before launch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hermes-ssh-policy-"));
    const identityFile = join(dir, "id_ed25519");
    const knownHostsFile = join(dir, "known_hosts");
    await writeFile(identityFile, "placeholder", { mode: 0o600 });
    await writeFile(`${identityFile}.pub`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBogus agentdash\n");
    await writeFile(knownHostsFile, "# pinned\n127.0.0.1 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHost\n");

    await expect(assertHermesSshLaunchReady({ identityFile, knownHostsFile })).resolves.toBeUndefined();

    await writeFile(`${identityFile}.pub`, "ssh-rsa AAAAB3Nza agentdash\n");
    await expect(assertHermesSshLaunchReady({ identityFile, knownHostsFile })).rejects.toThrow(/ed25519/);

    await writeFile(`${identityFile}.pub`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBogus agentdash\n");
    await writeFile(knownHostsFile, "# nothing pinned\n");
    await expect(assertHermesSshLaunchReady({ identityFile, knownHostsFile })).rejects.toThrow(/known_hosts/);

    await expect(
      assertHermesSshLaunchReady({ identityFile: join(dir, "missing"), knownHostsFile }),
    ).rejects.toThrow(/key file/);
  });
});
