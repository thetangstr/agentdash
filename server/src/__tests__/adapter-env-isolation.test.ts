import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runChildProcess } from "../adapters/utils.js";

/**
 * What a spawned agent harness may read out of the server's environment.
 *
 * This spawns a real child and asks it what it can see, because that is the
 * only question that matters and the only one a mocked env cannot answer. The
 * previous rule stripped `PAPERCLIP_*` and inherited everything else, so a real
 * deployment handed every agent `DATABASE_URL`, `BETTER_AUTH_SECRET`, the
 * provider key and the license key — to a process built from untrusted input.
 *
 * The two halves are equally load-bearing. Secrets must not cross; PATH and
 * HOME must, or nothing runs at all. A test for only the first would pass
 * against an allowlist so tight it broke every agent.
 */

const SECRETS = {
  DATABASE_URL: "postgres://paperclip:test-secret@127.0.0.1:5432/db",
  BETTER_AUTH_SECRET: "better-auth-secret-value",
  PAPERCLIP_AGENT_JWT_SECRET: "agent-jwt-secret-value",
  MINIMAX_API_KEY: "sk-minimax-test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  OPENAI_API_KEY: "sk-openai-test",
  AGENTDASH_LICENSE_KEY: "license-key-value",
} as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const [key, value] of Object.entries(SECRETS)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

/** Spawns a child that reports the values of `keys` as it sees them. */
async function childEnvFor(
  keys: string[],
  adapterEnv: Record<string, string> = {},
): Promise<Record<string, string>> {
  const script = `const out={};for(const k of ${JSON.stringify(keys)})out[k]=process.env[k]??"";console.log(JSON.stringify(out))`;
  let stdout = "";
  const result = await runChildProcess("env-isolation-test", process.execPath, ["-e", script], {
    cwd: process.cwd(),
    env: adapterEnv,
    timeoutSec: 30,
    graceSec: 5,
    onLog: async (stream, chunk) => {
      if (stream === "stdout") stdout += chunk;
    },
  });
  expect(result.exitCode).toBe(0);
  return JSON.parse(stdout.trim());
}

describe("adapter env isolation", () => {
  it("does not hand server secrets to a spawned adapter", async () => {
    const keys = Object.keys(SECRETS);
    const seen = await childEnvFor(keys);

    for (const key of keys) {
      expect(seen[key], `${key} must not cross into the adapter child`).toBe("");
    }
  });

  it("still passes through what an adapter needs to run", async () => {
    const seen = await childEnvFor(["PATH", "HOME"]);

    // Without these nothing resolves or runs, so an over-tight allowlist fails
    // here rather than silently breaking every agent in production.
    expect(seen.PATH).toBeTruthy();
    expect(seen.HOME).toBeTruthy();
  });

  it("lets an agent's own adapterConfig.env through as the explicit escape hatch", async () => {
    const seen = await childEnvFor(["MY_ADAPTER_VAR", "DATABASE_URL"], {
      MY_ADAPTER_VAR: "configured-per-agent",
    });

    expect(seen.MY_ADAPTER_VAR).toBe("configured-per-agent");
    // The escape hatch is additive: it does not reopen the inherited channel.
    expect(seen.DATABASE_URL).toBe("");
  });

  it("carries HERMES_* harness configuration but not secrets that merely look adjacent", async () => {
    process.env.HERMES_PROFILE = "mkboard";
    try {
      const seen = await childEnvFor(["HERMES_PROFILE", "MINIMAX_API_KEY"]);
      expect(seen.HERMES_PROFILE).toBe("mkboard");
      expect(seen.MINIMAX_API_KEY).toBe("");
    } finally {
      delete process.env.HERMES_PROFILE;
    }
  });
});
