// AgentDash (#725): the Hermes provider key service. A fake `hermes` records
// every call and writes `config set` values into the profile's files the way
// Hermes does, so persistence, rollback and the agent-profile resync are
// checked against real files. Provider calls go to a mocked fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProviderProbe,
  configureHermesProvider,
  HERMES_PROVIDER_MARKER,
  HERMES_PROVIDER_SECRET_NAME,
  HermesProviderSetupError,
  hermesProviderConfiguredSync,
  parseHermesProviderInput,
  readHermesProviderStatus,
  reconcileHermesProviderFromSecret,
  redactKey,
  withLocalLock,
  writeProfileEnvValue,
  type HermesProviderSetupDeps,
} from "./hermes-provider-setup.js";

const KEY = "zai-test-key-0123456789abcdef.ABCDEFGH";

function okFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }));
}

function statusFetch(status: number, body = `{"error":"Incorrect API key provided: ${KEY}"}`) {
  return vi.fn(async () => new Response(body, { status }));
}

describe("parseHermesProviderInput", () => {
  it("accepts the four providers and fills the default model", () => {
    expect(parseHermesProviderInput({ provider: "zai", apiKey: ` ${KEY} ` })).toEqual({
      provider: "zai",
      apiKey: KEY,
      model: "glm-5.3-flash",
    });
    for (const provider of ["openrouter", "anthropic", "openai"]) {
      expect(parseHermesProviderInput({ provider, apiKey: "k-1" }).provider).toBe(provider);
    }
    expect(parseHermesProviderInput({ provider: "openai", apiKey: "k", model: "gpt-4o" }).model).toBe("gpt-4o");
  });

  it("refuses other providers, a missing key, and characters that could break Hermes' .env", () => {
    expect(() => parseHermesProviderInput({ provider: "minimax", apiKey: "k" })).toThrow(/provider must be one of/);
    expect(() => parseHermesProviderInput({ provider: "zai", apiKey: "  " })).toThrow(/apiKey required/);
    expect(() => parseHermesProviderInput({ provider: "zai", apiKey: "abc\nEVIL=1" })).toThrow(/not allowed/);
    expect(() => parseHermesProviderInput({ provider: "zai", apiKey: "a b" })).toThrow(/not allowed/);
    expect(() => parseHermesProviderInput({ provider: "zai", apiKey: "k", model: "x;rm -rf" })).toThrow(/model/);
    expect(() => parseHermesProviderInput({ provider: "zai", apiKey: "k".repeat(1025) })).toThrow(/too long/);
  });
});

describe("buildProviderProbe", () => {
  it("makes one small model call per provider with the key in the auth header only", () => {
    const zai = buildProviderProbe({ provider: "zai", apiKey: KEY, model: "glm-5.3-flash" });
    expect(zai.url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect(zai.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(zai.body).toMatchObject({ model: "glm-5.3-flash", max_tokens: 8 });

    expect(buildProviderProbe({ provider: "openrouter", apiKey: "k", model: "m" }).url).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    const anthropic = buildProviderProbe({ provider: "anthropic", apiKey: "k", model: "claude-sonnet-5" });
    expect(anthropic.url).toBe("https://api.anthropic.com/v1/messages");
    expect(anthropic.headers).toMatchObject({ "x-api-key": "k", "anthropic-version": "2023-06-01" });
    const openai = buildProviderProbe({ provider: "openai", apiKey: "k", model: "gpt-5.4-mini" });
    expect(openai.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(openai.body).toMatchObject({ max_completion_tokens: 16 });
    for (const probe of [zai, anthropic, openai]) expect(JSON.stringify(probe.body)).not.toContain(KEY);
  });
});

describe("redactKey", () => {
  it("removes the key and key-shaped tokens", () => {
    expect(redactKey(`hermes config set GLM_API_KEY ${KEY} failed`, KEY)).toBe(
      "hermes config set GLM_API_KEY [redacted] failed",
    );
    expect(redactKey("bad sk-abcdef123456 here", "other")).toBe("bad [redacted] here");
  });
});


const AGENT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const AGENT_B = "bbbbbbbb-0000-4000-8000-000000000002";
const OTHER_COMPANY_AGENT = "cccccccc-0000-4000-8000-000000000003";
const profileOf = (id: string) => `agentdash-${id.replace(/-/g, "")}`;

describe("writeProfileEnvValue", () => {
  it("replaces one variable atomically, keeps the rest, and leaves the file 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hermes-env-"));
    try {
      await writeFile(join(dir, ".env"), "OTHER=1\nGLM_API_KEY=old\n", { mode: 0o644 });
      await writeProfileEnvValue(dir, "GLM_API_KEY", KEY);
      expect(await readFile(join(dir, ".env"), "utf8")).toBe(`OTHER=1\nGLM_API_KEY=${KEY}\n`);
      expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
      // No temp file left behind.
      expect((await readdir(dir)).filter((f) => f.includes(".tmp"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("configureHermesProvider", () => {
  let tmp: string;
  let profilesDir: string;
  let calls: string[][];
  let failOn: ((args: string[]) => boolean) | null;
  let secretState: Map<string, string>;
  let secretEvents: string[];

  /** Fake hermes: profile create/delete, `config set` into config.yaml, `auth list` no-op. */
  async function fakeHermes(args: string[]) {
    calls.push(args);
    if (failOn?.(args)) throw new Error(`Command failed: hermes ${args.join(" ")}\nboom`);
    if (args[0] === "profile" && args[1] === "create") {
      await mkdir(join(profilesDir, args[2]!), { recursive: true });
    } else if (args[0] === "profile" && args[1] === "delete") {
      await rm(join(profilesDir, args[2]!), { recursive: true, force: true });
    } else if (args[0] === "-p" && args[2] === "config" && args[3] === "set") {
      const path = join(profilesDir, args[1]!, "config.yaml");
      const prior = existsSync(path) ? await readFile(path, "utf8") : "";
      const lines = prior.split("\n").filter((line) => line && !line.startsWith(`${args[4]}=`));
      await writeFile(path, [...lines, `${args[4]}=${args[5]}`].join("\n") + "\n");
    }
    return { stdout: "", stderr: "" };
  }

  const secrets = {
    put: vi.fn(async (companyId: string, _name: string, value: string) => {
      const previous = secretState.get(companyId);
      secretState.set(companyId, value);
      secretEvents.push(`put:${companyId}`);
      return {
        restore: async () => {
          secretEvents.push(`restore:${companyId}`);
          if (previous === undefined) secretState.delete(companyId);
          else secretState.set(companyId, previous);
        },
      };
    }),
    get: vi.fn(async (companyId: string) => secretState.get(companyId) ?? null),
  };

  function deps(fetchImpl: typeof fetch = okFetch() as never): HermesProviderSetupDeps {
    return {
      env: {},
      fetch: fetchImpl,
      runHermes: fakeHermes,
      profilesDir,
      secrets,
      now: () => new Date("2026-09-25T00:00:00Z"),
    };
  }

  const envOf = (profile: string) => readFile(join(profilesDir, profile, ".env"), "utf8");

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "hermes-provider-"));
    profilesDir = join(tmp, "profiles");
    await mkdir(profilesDir, { recursive: true });
    calls = [];
    failOn = null;
    secretState = new Map();
    secretEvents = [];
    secrets.put.mockClear();
    secrets.get.mockClear();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("stores the secret first, then writes the key to .env directly (never argv), 0600", async () => {
    const input = parseHermesProviderInput({ provider: "zai", apiKey: KEY });
    const result = await configureHermesProvider("company-1", input, "user-1", { agentIds: [] }, deps());

    expect(secrets.put).toHaveBeenCalledWith(
      "company-1",
      HERMES_PROVIDER_SECRET_NAME,
      KEY,
      "Hermes provider key (Z.AI (GLM))",
      "user-1",
    );
    expect(calls[0]).toEqual(["profile", "create", "agentdash", "--no-alias", "--description", "AgentDash managed template"]);
    expect(calls.slice(1)).toEqual([
      ["-p", "agentdash", "config", "set", "model.provider", "zai"],
      ["-p", "agentdash", "config", "set", "model.default", "glm-5.3-flash"],
      ["-p", "agentdash", "auth", "list"],
    ]);
    // The key reached no Hermes command line.
    expect(JSON.stringify(calls)).not.toContain(KEY);
    expect(await envOf("agentdash")).toBe(`GLM_API_KEY=${KEY}\n`);
    expect(statSync(join(profilesDir, "agentdash", ".env")).mode & 0o777).toBe(0o600);

    const marker = await readFile(join(profilesDir, "agentdash", HERMES_PROVIDER_MARKER), "utf8");
    expect(JSON.parse(marker)).toEqual({
      companyId: "company-1",
      provider: "zai",
      model: "glm-5.3-flash",
      configuredAt: "2026-09-25T00:00:00.000Z",
    });
    expect(marker).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result).toMatchObject({ provider: "zai", model: "glm-5.3-flash", profilesUpdated: 0 });
    expect(await readHermesProviderStatus({ env: {}, profilesDir })).toMatchObject({ configured: true, provider: "zai" });
    expect(hermesProviderConfiguredSync({ HERMES_PROFILES_DIR: profilesDir })).toBe(true);
  });

  it("updates only the calling company's agent profiles", async () => {
    for (const id of [AGENT_A, AGENT_B, OTHER_COMPANY_AGENT]) {
      await mkdir(join(profilesDir, profileOf(id)), { recursive: true });
    }
    await mkdir(join(profilesDir, "agentdash"), { recursive: true });
    const input = parseHermesProviderInput({ provider: "openrouter", apiKey: "sk-or-v1-abcdef", model: "z-ai/glm-5.2" });
    const result = await configureHermesProvider("company-1", input, "u", { agentIds: [AGENT_A, AGENT_B] }, deps());

    expect(result.profilesUpdated).toBe(2);
    for (const id of [AGENT_A, AGENT_B]) {
      expect(await envOf(profileOf(id))).toContain("OPENROUTER_API_KEY=sk-or-v1-abcdef");
      expect(statSync(join(profilesDir, profileOf(id), ".env")).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(join(profilesDir, profileOf(OTHER_COMPANY_AGENT), ".env"))).toBe(false);
    expect(calls.some((args) => args[1] === profileOf(OTHER_COMPANY_AGENT))).toBe(false);
  });

  it("refuses when the template belongs to another company", async () => {
    await mkdir(join(profilesDir, "agentdash"), { recursive: true });
    await writeFile(
      join(profilesDir, "agentdash", HERMES_PROVIDER_MARKER),
      JSON.stringify({ companyId: "company-0", provider: "zai", model: "glm-5.3-flash" }),
    );
    const input = parseHermesProviderInput({ provider: "zai", apiKey: KEY });
    await expect(configureHermesProvider("company-1", input, "u", { agentIds: [] }, deps())).rejects.toMatchObject({
      status: 409,
      code: "provider_owned_by_other_company",
    });
    expect(secrets.put).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("a wrong key returns a readable, key-free error and changes nothing", async () => {
    await mkdir(join(profilesDir, "agentdash"), { recursive: true });
    await writeFile(join(profilesDir, "agentdash", ".env"), "GLM_API_KEY=previous\n");
    const input = parseHermesProviderInput({ provider: "zai", apiKey: KEY });

    const attempt = configureHermesProvider("company-1", input, "u", { agentIds: [] }, deps(statusFetch(401) as never));
    await expect(attempt).rejects.toBeInstanceOf(HermesProviderSetupError);
    await expect(attempt).rejects.toMatchObject({ status: 422, code: "provider_key_rejected" });
    await expect(attempt).rejects.toThrow("Z.AI (GLM) rejected this API key (HTTP 401). Check the key and try again.");
    const error = (await attempt.catch((e: Error) => e)) as Error;
    expect(error.message).not.toContain(KEY);
    expect(calls).toEqual([]);
    expect(secrets.put).not.toHaveBeenCalled();
    expect(await envOf("agentdash")).toBe("GLM_API_KEY=previous\n");
  });

  it("names an unknown model, an unreachable provider and a provider outage", async () => {
    const input = parseHermesProviderInput({ provider: "anthropic", apiKey: "sk-ant-x1", model: "claude-nope" });
    const none = { agentIds: [] };
    await expect(configureHermesProvider("c", input, null, none, deps(statusFetch(404) as never))).rejects.toMatchObject({
      status: 422,
      code: "provider_model_unavailable",
    });
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(configureHermesProvider("c", input, null, none, deps(offline as never))).rejects.toMatchObject({
      status: 502,
      code: "provider_unreachable",
    });
    await expect(configureHermesProvider("c", input, null, none, deps(statusFetch(503) as never))).rejects.toMatchObject({
      status: 502,
      code: "provider_error",
    });
    expect(calls).toEqual([]);
  });

  it("a failing agent profile rolls back every profile and the secret, and returns an error", async () => {
    const templateDir = join(profilesDir, "agentdash");
    await mkdir(templateDir, { recursive: true });
    await writeFile(join(templateDir, ".env"), "GLM_API_KEY=previous\n");
    await writeFile(join(templateDir, "config.yaml"), "model.provider=zai\n");
    await mkdir(join(profilesDir, profileOf(AGENT_A)), { recursive: true });
    await writeFile(join(profilesDir, profileOf(AGENT_A), ".env"), "GLM_API_KEY=previous\n");
    await mkdir(join(profilesDir, profileOf(AGENT_B)), { recursive: true });
    secretState.set("company-1", "previous");
    failOn = (args) => args[1] === profileOf(AGENT_B) && args[4] === "model.default";
    const input = parseHermesProviderInput({ provider: "openai", apiKey: "sk-proj-newkey123456" });

    const error = (await configureHermesProvider(
      "company-1",
      input,
      null,
      { agentIds: [AGENT_A, AGENT_B] },
      deps(),
    ).catch((e) => e)) as HermesProviderSetupError;
    expect(error).toBeInstanceOf(HermesProviderSetupError);
    expect(error).toMatchObject({ status: 500, code: "hermes_config_failed" });
    expect(error.message).toContain(profileOf(AGENT_B));
    expect(error.message).toMatch(/Nothing was changed/);
    expect(error.message).not.toContain("sk-proj-newkey123456");

    expect(await envOf("agentdash")).toBe("GLM_API_KEY=previous\n");
    expect(await readFile(join(templateDir, "config.yaml"), "utf8")).toBe("model.provider=zai\n");
    expect(await envOf(profileOf(AGENT_A))).toBe("GLM_API_KEY=previous\n");
    expect(existsSync(join(profilesDir, profileOf(AGENT_B), ".env"))).toBe(false);
    expect(secretEvents).toEqual(["put:company-1", "restore:company-1"]);
    expect(secretState.get("company-1")).toBe("previous");
    expect(existsSync(join(templateDir, HERMES_PROVIDER_MARKER))).toBe(false);
    expect((await readdir(profilesDir)).filter((name) => name.startsWith(".agentdash-provider-backup"))).toEqual([]);
  });

  it("removes a template it created when Hermes fails, and deletes a secret it created", async () => {
    failOn = (args) => args[4] === "model.provider";
    const input = parseHermesProviderInput({ provider: "zai", apiKey: KEY });
    await expect(configureHermesProvider("c", input, null, { agentIds: [] }, deps())).rejects.toMatchObject({
      code: "hermes_config_failed",
    });
    expect(existsSync(join(profilesDir, "agentdash"))).toBe(false);
    expect(secretState.has("c")).toBe(false);
    expect(hermesProviderConfiguredSync({ HERMES_PROFILES_DIR: profilesDir })).toBe(false);
  });

  it("serialises concurrent setups", async () => {
    const order: string[] = [];
    const lock = <T,>(key: string, fn: () => Promise<T>) =>
      withLocalLock(key, async () => {
        order.push("start");
        const value = await fn();
        order.push("end");
        return value;
      });
    const input = parseHermesProviderInput({ provider: "zai", apiKey: KEY });
    await Promise.all([
      configureHermesProvider("company-1", input, null, { agentIds: [] }, { ...deps(), lock }),
      configureHermesProvider("company-1", input, null, { agentIds: [] }, { ...deps(), lock }),
    ]);
    expect(order).toEqual(["start", "end", "start", "end"]);
  });

  describe("reconcileHermesProviderFromSecret", () => {
    it("re-materialises the key from the secret into profiles that lost it, and only the company's", async () => {
      const input = parseHermesProviderInput({ provider: "zai", apiKey: KEY });
      await configureHermesProvider("company-1", input, null, { agentIds: [] }, deps());
      // A profile provisioned later (or restored without its .env), and one of another company.
      await mkdir(join(profilesDir, profileOf(AGENT_A)), { recursive: true });
      await mkdir(join(profilesDir, profileOf(OTHER_COMPANY_AGENT)), { recursive: true });
      calls = [];

      const result = await reconcileHermesProviderFromSecret("company-1", { agentIds: [AGENT_A] }, deps());
      expect(result).toEqual({ status: "ok", updated: [profileOf(AGENT_A)], failed: [] });
      expect(await envOf(profileOf(AGENT_A))).toBe(`GLM_API_KEY=${KEY}\n`);
      expect(statSync(join(profilesDir, profileOf(AGENT_A), ".env")).mode & 0o777).toBe(0o600);
      expect(existsSync(join(profilesDir, profileOf(OTHER_COMPANY_AGENT), ".env"))).toBe(false);
      expect(JSON.stringify(calls)).not.toContain(KEY);

      // The secret rotated elsewhere: the template follows it.
      secretState.set("company-1", "zai-rotated-key-9876543210");
      const again = await reconcileHermesProviderFromSecret("company-1", { agentIds: [AGENT_A] }, deps());
      expect(again.updated).toEqual(["agentdash", profileOf(AGENT_A)]);
      expect(await envOf("agentdash")).toBe("GLM_API_KEY=zai-rotated-key-9876543210\n");
    });

    it("does nothing for a company that does not own the template, or without a secret", async () => {
      const input = parseHermesProviderInput({ provider: "zai", apiKey: KEY });
      await configureHermesProvider("company-1", input, null, { agentIds: [] }, deps());
      expect((await reconcileHermesProviderFromSecret("company-2", { agentIds: [] }, deps())).status).toBe(
        "not_configured",
      );
      secretState.delete("company-1");
      expect((await reconcileHermesProviderFromSecret("company-1", { agentIds: [] }, deps())).status).toBe("no_secret");
    });
  });
});
