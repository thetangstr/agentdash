import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { inspectClients, renderCheck, runCheck } from "./check.mjs";
import { DESKTOP_INSTRUCTIONS_FILE, setupInboxClients } from "./clients.mjs";

const SERVER = "http://agentdash.example.test:3100";
const SKILL = "---\nname: agentdash-coworker\ndescription: x\n---\n<!-- agentdash-coworker-skill-version: 3 -->\n# Rules\n";
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "check-test-"));

function machine({ token = true, clients = { claude: true, codex: true, desktop: true }, scaffold = true } = {}) {
  const dir = tmp();
  const paths = {
    claudeConfig: path.join(dir, ".claude.json"),
    codexConfig: path.join(dir, ".codex", "config.toml"),
    desktopConfig: path.join(dir, "Claude", "claude_desktop_config.json"),
    inboxDir: path.join(dir, "agentdash-inbox"),
    tokenPath: path.join(dir, ".agentdash", "bridge-token"),
    ownerPath: path.join(dir, ".agentdash", "bridge-owner.json"),
  };
  mkdirSync(path.dirname(paths.desktopConfig), { recursive: true });
  if (token) {
    mkdirSync(path.dirname(paths.tokenPath), { recursive: true });
    writeFileSync(paths.tokenPath, "bridge-token-abc");
  }
  if (scaffold) {
    mkdirSync(path.join(paths.inboxDir, ".claude", "skills", "agentdash-coworker"), { recursive: true });
    writeFileSync(path.join(paths.inboxDir, ".claude", "skills", "agentdash-coworker", "SKILL.md"), SKILL);
    writeFileSync(path.join(paths.inboxDir, "AGENTS.md"), "rules");
  }
  setupInboxClients({ serverName: "agentdash", instanceUrl: SERVER, clients, paths, platform: "darwin", nodeDir: "/n", skillText: SKILL });
  return paths;
}

function whoami(json, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(json), { status });
  };
  return { fetchImpl, calls };
}

const installed = { claude: true, codex: true, desktop: true };
const agentOk = async () => ({ configured: true, endpoint: `${SERVER}/api/mcp`, claudeServer: {}, codexServer: { envVar: "AGENTDASH_KEY_AGENTDASH" }, verified: { toolCount: 12 } });

describe("which clients have the inbox tools", () => {
  it("reads each client's own config", () => {
    const paths = machine({ clients: { claude: true, codex: false, desktop: true } });
    const clients = inspectClients({ serverName: "agentdash", paths, installed });
    expect(clients.claude).toMatchObject({ installed: true, connected: true, server: SERVER });
    expect(clients.desktop).toMatchObject({ installed: true, connected: true, server: SERVER, instructions: true });
    expect(clients.codex).toMatchObject({ installed: true, connected: false });
    expect(clients.rules).toEqual({ skill: true, agentsMd: true, dir: paths.inboxDir });
  });
});

describe("agentdash-connect check", () => {
  it("reports every client, the owner, and that review is ready", async () => {
    const paths = machine();
    const { fetchImpl, calls } = whoami({
      owner: { name: "Person A", email: "a@example.test" },
      endpoint: { label: "laptop-a (darwin)", capabilities: ["bridge:read", "bridge:inbox", "bridge:work"] },
      coworkerBridgeEnabled: true,
    });
    const lines = [];
    const code = await runCheck(
      { serverName: "agentdash" },
      { paths, installed, fetchImpl, checkAgent: agentOk, log: (l) => lines.push(l), errorLog: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    expect(calls[0].url).toBe(`${SERVER}/api/bridge/whoami`);
    expect(calls[0].init.headers.authorization).toBe("Bearer bridge-token-abc");
    const text = lines.join("\n");
    expect(text).toMatch(/Claude Code\s+connected/);
    expect(text).toMatch(/Claude Desktop\s+connected/);
    expect(text).toMatch(/Codex\s+connected/);
    expect(text).toContain("Person A (a@example.test)");
    expect(text).toContain("laptop-a (darwin)");
    expect(text).toMatch(/bridge:work\s+present/);
    expect(text).toMatch(/Review\s+ready/);
    // Desktop has no hook: the one manual step is always said.
    expect(text).toContain(DESKTOP_INSTRUCTIONS_FILE);
    // Never prints the credential.
    expect(text).not.toContain("bridge-token-abc");
  });

  it("says review is not enabled and to reconnect when bridge:work is missing", async () => {
    const paths = machine();
    const { fetchImpl } = whoami({
      owner: { name: "Person A", email: null },
      endpoint: { label: "laptop-a", capabilities: ["bridge:read", "bridge:inbox"] },
      coworkerBridgeEnabled: true,
    });
    const lines = [];
    const code = await runCheck(
      { serverName: "agentdash" },
      { paths, installed, fetchImpl, checkAgent: agentOk, log: (l) => lines.push(l), errorLog: (l) => lines.push(l) },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/bridge:work\s+missing — review not enabled; reconnect with a new connect code/);
  });

  it("separates a company that has not turned review on from a machine that lacks it", async () => {
    const report = {
      agent: await agentOk(),
      clients: inspectClients({ serverName: "agentdash", paths: machine(), installed }),
      token: { present: true, path: "/x" },
      server: SERVER,
      remote: { status: "ok", owner: { name: "Person A" }, label: "l", capabilities: ["bridge:inbox", "bridge:work"], coworkerBridgeEnabled: false },
    };
    const { lines, ok } = renderCheck(report);
    expect(ok).toBe(true);
    expect(lines.join("\n")).toMatch(/Review\s+not turned on for your company yet/);
  });

  it("names an installed client that is missing the inbox tools, and how to fix it", async () => {
    const paths = machine({ clients: { claude: true, codex: false, desktop: false } });
    const { fetchImpl } = whoami({
      owner: { name: "Person A" },
      endpoint: { label: "l", capabilities: ["bridge:inbox", "bridge:work"] },
      coworkerBridgeEnabled: true,
    });
    const lines = [];
    const code = await runCheck(
      { serverName: "agentdash" },
      { paths, installed, fetchImpl, checkAgent: agentOk, log: (l) => lines.push(l), errorLog: (l) => lines.push(l) },
    );
    expect(code).toBe(1);
    const text = lines.join("\n");
    expect(text).toMatch(/Claude Desktop\s+not connected/);
    expect(text).toMatch(/Codex\s+not connected/);
    expect(text).toContain("npx agentdash-connect clients");
  });

  it("reports a missing credential, a refused one, and an instance too old to say", async () => {
    const lines = [];
    const deps = { installed, checkAgent: agentOk, log: (l) => lines.push(l), errorLog: (l) => lines.push(l) };

    expect(await runCheck({ serverName: "agentdash" }, { ...deps, paths: machine({ token: false }), fetchImpl: async () => { throw new Error("must not call"); } })).toBe(1);
    expect(lines.join("\n")).toMatch(/Credential\s+missing/);

    lines.length = 0;
    expect(await runCheck({ serverName: "agentdash" }, { ...deps, paths: machine(), fetchImpl: whoami({ error: "no" }, 401).fetchImpl })).toBe(1);
    expect(lines.join("\n")).toMatch(/not accepted/);

    lines.length = 0;
    expect(await runCheck({ serverName: "agentdash" }, { ...deps, paths: machine(), fetchImpl: whoami({ error: "Not found" }, 404).fetchImpl })).toBe(1);
    expect(lines.join("\n")).toMatch(/older than this check/);

    lines.length = 0;
    const down = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    expect(await runCheck({ serverName: "agentdash" }, { ...deps, paths: machine(), fetchImpl: down })).toBe(1);
    expect(lines.join("\n")).toMatch(/unreachable.*ECONNREFUSED/);
  });

  it("reports a machine with no inbox at all without calling anything", async () => {
    const paths = machine({ token: false, clients: { claude: false, codex: false, desktop: false }, scaffold: false });
    const lines = [];
    const code = await runCheck(
      { serverName: "agentdash" },
      {
        paths,
        installed: { claude: false, codex: false, desktop: false },
        fetchImpl: async () => {
          throw new Error("must not call");
        },
        checkAgent: async () => ({ configured: false }),
        log: (l) => lines.push(l),
        errorLog: (l) => lines.push(l),
      },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/Agent tools\s+not configured/);
  });
});
