// AgentDash (#721): a hosted box runs every agent on its own managed Hermes
// profile, meters it from that profile's ledger, and never falls back to the
// shared root profile.
//
// Drives the real hermes_local adapter (registry.ts → hermes-paperclip-adapter)
// against a fake `hermes` binary. The fake materialises a profile directory on
// `profile create` and, on a chat run, writes a `session_model_usage` row into
// `<profilesDir>/<profile>/state.db` — where a real `hermes -p <profile>` run
// keeps its ledger. A decoy row for the same session sits in the root ledger,
// so a run metered from the wrong ledger reports the wrong numbers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { agentProfileName } from "../services/hermes-profile.js";

const ENV_KEYS = [
  "AGENTDASH_DEPLOYMENT_KIND",
  "AGENTDASH_HERMES_MANAGED_PROFILES",
  "AGENTDASH_HERMES_COMMAND",
  "AGENTDASH_HERMES_ROOT",
  "AGENTDASH_HERMES_BIN_DIR",
  "AGENTDASH_HERMES_STATE_DB",
  "AGENTDASH_GATEWAY_BASE_URL",
  "AGENTDASH_GATEWAY_API_KEY",
  "HERMES_HOME",
  "HERMES_PROFILES_DIR",
  "HERMES_FAKE_CALL_LOG",
  "HERMES_FAKE_FAIL_CREATE",
];

const USAGE_TABLE = `CREATE TABLE IF NOT EXISTS session_model_usage (
  session_id TEXT, model TEXT, billing_provider TEXT, api_call_count INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  estimated_cost_usd REAL, actual_cost_usd REAL
)`;

const FAKE_HERMES = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.HERMES_FAKE_CALL_LOG, JSON.stringify(argv) + "\n");
const profilesDir = process.env.HERMES_PROFILES_DIR;
if (argv[0] === "profile" && argv[1] === "create") {
  if (process.env.HERMES_FAKE_FAIL_CREATE === "1") {
    process.stderr.write("Error: template profile 'agentdash' does not exist\n");
    process.exit(1);
  }
  fs.mkdirSync(path.join(profilesDir, argv[2]), { recursive: true });
  process.exit(0);
}
const pIndex = argv.indexOf("-p");
const profile = pIndex >= 0 ? argv[pIndex + 1] : null;
const sessionId = "hosted-session-1";
if (profile) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(profilesDir, profile, "state.db"));
  db.exec(${JSON.stringify(USAGE_TABLE)});
  db.prepare("INSERT INTO session_model_usage VALUES (?, 'glm-5.3-flash', 'zai', 3, 1200, 340, 0, 0, 0)").run(sessionId);
  db.close();
}
process.stdout.write("done\n\nsession_id: " + sessionId + "\n");
`;

/** Each fake invocation, one argv per line, joined with spaces for matching. */
async function readCalls(callLog: string): Promise<string[]> {
  return (await readFile(callLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as string[]).join(" "));
}

function buildCtx(agentId: string) {
  return {
    runId: "run-hosted-1",
    agent: {
      id: agentId,
      companyId: "company-1",
      name: "Casey",
      role: "general",
      adapterType: "hermes_local",
      adapterConfig: { cwd: tmpdir() },
    },
    runtime: {},
    config: {},
    context: {},
    authToken: "test-run-token",
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
  };
}

describe("hosted hermes_local run (managed profile on the Volume)", () => {
  let tmp: string;
  let root: string;
  let profilesDir: string;
  let binDir: string;
  let callLog: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    vi.resetModules();
    tmp = await mkdtemp(join(tmpdir(), "hermes-hosted-"));
    root = join(tmp, "paperclip", ".hermes");
    profilesDir = join(root, "profiles");
    binDir = join(root, "bin");
    callLog = join(tmp, "calls.log");
    await mkdir(profilesDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(callLog, "");
    const fake = join(tmp, "hermes");
    await writeFile(fake, FAKE_HERMES);
    await chmod(fake, 0o755);

    // Decoy: the same session id in the shared root ledger with other numbers.
    const rootDb = new DatabaseSync(join(root, "state.db"));
    rootDb.exec(USAGE_TABLE);
    rootDb
      .prepare("INSERT INTO session_model_usage VALUES (?, 'root-model', 'root', 1, 9, 9, 0, 0, 0)")
      .run("hosted-session-1");
    rootDb.close();

    for (const key of ENV_KEYS) saved[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    // Hosted implies managed profiles; AGENTDASH_HERMES_MANAGED_PROFILES stays unset on purpose.
    process.env.AGENTDASH_DEPLOYMENT_KIND = "hosted";
    // The image sets AGENTDASH_HERMES_COMMAND; the run config then carries the
    // root command, which must not win the ledger lookup over the profile wrapper.
    process.env.AGENTDASH_HERMES_COMMAND = fake;
    process.env.AGENTDASH_HERMES_ROOT = root;
    process.env.HERMES_PROFILES_DIR = profilesDir;
    process.env.AGENTDASH_HERMES_BIN_DIR = binDir;
    process.env.HERMES_FAKE_CALL_LOG = callLog;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("provisions the agent's own profile and meters the run from that profile's ledger", async () => {
    const agentId = "7f1c2a9e-0b1d-4c3e-9a55-2d6f8e4b1a07";
    const profile = agentProfileName(agentId);
    const { getServerAdapter } = await import("../adapters/registry.js");

    const result = await getServerAdapter("hermes_local").execute(buildCtx(agentId) as never);

    expect(result.errorCode ?? null).toBeNull();
    expect(existsSync(join(profilesDir, profile))).toBe(true);
    expect(existsSync(join(binDir, profile))).toBe(true);
    const calls = await readCalls(callLog);
    expect(calls.some((line) => line.startsWith(`profile create ${profile} --clone-from agentdash`))).toBe(true);
    // Every chat invocation went through the wrapper's explicit -p.
    const chatCalls = calls.filter((line) => !line.startsWith("profile "));
    expect(chatCalls.length).toBeGreaterThan(0);
    for (const line of chatCalls) expect(line.startsWith(`-p ${profile} `)).toBe(true);

    const resultJson = result.resultJson as Record<string, unknown>;
    expect(resultJson.meteringStatus).toBe("metered");
    expect(resultJson.meteringLedger).toMatchObject({
      path: join(profilesDir, profile, "state.db"),
      certainty: "certain",
      profile,
    });
    // The profile ledger's numbers, not the root decoy's.
    expect(result.usage).toMatchObject({ inputTokens: 1200, outputTokens: 340 });
  });

  it("fails the run with a named error when the profile cannot be provisioned, without spawning Hermes", async () => {
    process.env.HERMES_FAKE_FAIL_CREATE = "1";
    const agentId = "0c9d8e7f-6a5b-4c3d-2e1f-0a9b8c7d6e5f";
    const profile = agentProfileName(agentId);
    const logs: string[] = [];
    const ctx = { ...buildCtx(agentId), onLog: async (_stream: string, chunk: string) => void logs.push(chunk) };
    const { getServerAdapter } = await import("../adapters/registry.js");

    const result = await getServerAdapter("hermes_local").execute(ctx as never);

    expect(result.errorCode).toBe("hermes_profile_provision_failed");
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain(profile);
    expect(result.errorMessage).toContain("not started on the shared root profile");
    expect(result.errorMeta).toMatchObject({ agentId, hermesProfile: profile });
    expect(logs.join("")).toContain("Hermes profile provisioning failed");
    // Only the failed `profile create` ran: no chat on the root command.
    const calls = await readCalls(callLog);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^profile create /);
  });

  it("reports the failure from the environment check too (harness preflight)", async () => {
    process.env.HERMES_FAKE_FAIL_CREATE = "1";
    const { getServerAdapter } = await import("../adapters/registry.js");
    const check = await getServerAdapter("hermes_local").testEnvironment({
      companyId: "company-1",
      adapterType: "hermes_local",
      config: {},
      agent: { id: "agent-env-1" },
    } as never);
    expect(check.status).toBe("fail");
    expect(check.checks[0]).toMatchObject({ code: "hermes_profile_provision_failed", level: "error" });
  });

  it("on-prem is unchanged: without the hosted flag a failed provision falls back to the default command", async () => {
    delete process.env.AGENTDASH_DEPLOYMENT_KIND;
    process.env.AGENTDASH_HERMES_MANAGED_PROFILES = "true";
    process.env.HERMES_FAKE_FAIL_CREATE = "1";
    const { getServerAdapter } = await import("../adapters/registry.js");

    const result = await getServerAdapter("hermes_local").execute(buildCtx("agent-onprem-1") as never);

    expect(result.errorCode ?? null).not.toBe("hermes_profile_provision_failed");
    const calls = await readCalls(callLog);
    expect(calls.some((line) => !line.startsWith("profile ") && !line.startsWith("-p "))).toBe(true);
  });
});
