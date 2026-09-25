// AgentDash (#725): the Hermes provider key service. A fake `hermes` records
// every call and writes `config set` values into the profile's files the way
// Hermes does, so persistence, rollback and the agent-profile resync are
// checked against real files. Provider calls go to a mocked fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  redactKey,
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

describe("configureHermesProvider", () => {
  let tmp: string;
  let profilesDir: string;
  let calls: string[][];
  let failOn: ((args: string[]) => boolean) | null;
  let secrets: { put: ReturnType<typeof vi.fn> };

  /** Fake hermes: `profile create` makes the dir; `-p X config set K V` writes like Hermes does. */
  async function fakeHermes(args: string[]) {
    calls.push(args);
    if (failOn?.(args)) throw new Error(`Command failed: hermes ${args.join(" ")}\nboom`);
    if (args[0] === "profile" && args[1] === "create") {
      await mkdir(join(profilesDir, args[2]!), { recursive: true });
    } else if (args[0] === "profile" && args[1] === "delete") {
      await rm(join(profilesDir, args[2]!), { recursive: true, force: true });
    } else if (args[0] === "-p" && args[2] === "config" && args[3] === "set") {
      const dir = join(profilesDir, args[1]!);
      const [key, value] = [args[4]!, args[5]!];
      const file = key.includes(".") ? "config.yaml" : ".env";
      const path = join(dir, file);
      const prior = existsSync(path) ? await readFile(path, "utf8") : "";
      const lines = prior.split("\n").filter((line) => line && !line.startsWith(`${key}=`));
      await writeFile(path, [...lines, `${key}=${value}`].join("\n") + "\n");
    }
    return { stdout: "", stderr: "" };
  }

  function deps(fetchImpl: typeof fetch): HermesProviderSetupDeps {
    return {
      env: {},
      fetch: fetchImpl,
      runHermes: fakeHermes,
      profilesDir,
      secrets: secrets as never,
      now: () => new Date("2026-09-25T00:00:00Z"),
    };
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "hermes-provider-"));
    profilesDir = join(tmp, "profiles");
    await mkdir(profilesDir, { recursive: true });
    calls = [];
    failOn = null;
    secrets = { put: vi.fn(async () => undefined) };
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("verifies first, then writes provider, model and key into a new template with Hermes' CLI", async () => {
    const fetchMock = okFetch();
    const input = parseHermesProviderInput({ provider: "zai", apiKey: KEY });
    const result = await configureHermesProvider("company-1", input, "user-1", deps(fetchMock as never));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual(["profile", "create", "agentdash", "--no-alias", "--description", "AgentDash managed template"]);
    expect(calls.slice(1)).toEqual([
      ["-p", "agentdash", "config", "set", "GLM_API_KEY", KEY],
      ["-p", "agentdash", "config", "set", "model.provider", "zai"],
      ["-p", "agentdash", "config", "set", "model.default", "glm-5.3-flash"],
    ]);
    expect(await readFile(join(profilesDir, "agentdash", ".env"), "utf8")).toContain(`GLM_API_KEY=${KEY}`);

    // Encrypted, company-scoped system of record.
    expect(secrets.put).toHaveBeenCalledWith(
      "company-1",
      HERMES_PROVIDER_SECRET_NAME,
      KEY,
      "Hermes provider key (Z.AI (GLM))",
      "user-1",
    );
    // Key-free marker next to the template; the result carries no key.
    const marker = await readFile(join(profilesDir, "agentdash", HERMES_PROVIDER_MARKER), "utf8");
    expect(JSON.parse(marker)).toEqual({ provider: "zai", model: "glm-5.3-flash", configuredAt: "2026-09-25T00:00:00.000Z" });
    expect(marker).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result).toMatchObject({ provider: "zai", model: "glm-5.3-flash", profilesUpdated: 0, profilesFailed: [] });

    expect(await readHermesProviderStatus({ env: {}, profilesDir })).toMatchObject({ configured: true, provider: "zai" });
    expect(hermesProviderConfiguredSync({ HERMES_PROFILES_DIR: profilesDir })).toBe(true);
  });

  it("updates agent profiles cloned before the key was set, and only those", async () => {
    for (const name of ["agentdash", "agentdash-aaa111", "agentdash-bbb222", "someone-else"]) {
      await mkdir(join(profilesDir, name), { recursive: true });
    }
    const input = parseHermesProviderInput({ provider: "openrouter", apiKey: "sk-or-v1-abcdef", model: "z-ai/glm-5.2" });
    const result = await configureHermesProvider("company-1", input, "user-1", deps(okFetch() as never));

    expect(result.profilesUpdated).toBe(2);
    for (const profile of ["agentdash-aaa111", "agentdash-bbb222"]) {
      expect(await readFile(join(profilesDir, profile, ".env"), "utf8")).toContain("OPENROUTER_API_KEY=sk-or-v1-abcdef");
      expect(await readFile(join(profilesDir, profile, "config.yaml"), "utf8")).toContain("model.provider=openrouter");
    }
    expect(existsSync(join(profilesDir, "someone-else", ".env"))).toBe(false);
    // The template was not re-created.
    expect(calls.some((args) => args[0] === "profile")).toBe(false);
  });

  it("a wrong key returns a readable, key-free error and changes nothing", async () => {
    await mkdir(join(profilesDir, "agentdash"), { recursive: true });
    await writeFile(join(profilesDir, "agentdash", ".env"), "GLM_API_KEY=previous\n");
    const input = parseHermesProviderInput({ provider: "zai", apiKey: KEY });

    const attempt = configureHermesProvider("company-1", input, "user-1", deps(statusFetch(401) as never));
    await expect(attempt).rejects.toBeInstanceOf(HermesProviderSetupError);
    await expect(attempt).rejects.toMatchObject({ status: 422, code: "provider_key_rejected" });
    await expect(attempt).rejects.toThrow("Z.AI (GLM) rejected this API key (HTTP 401). Check the key and try again.");
    const error = (await attempt.catch((e: Error) => e)) as Error;
    expect(error.message).not.toContain(KEY);

    expect(calls).toEqual([]);
    expect(secrets.put).not.toHaveBeenCalled();
    expect(await readFile(join(profilesDir, "agentdash", ".env"), "utf8")).toBe("GLM_API_KEY=previous\n");
    expect(existsSync(join(profilesDir, "agentdash", HERMES_PROVIDER_MARKER))).toBe(false);
  });

  it("names an unknown model, an unreachable provider and a provider outage", async () => {
    const input = parseHermesProviderInput({ provider: "anthropic", apiKey: "sk-ant-x1", model: "claude-nope" });
    await expect(configureHermesProvider("c", input, null, deps(statusFetch(404) as never))).rejects.toMatchObject({
      status: 422,
      code: "provider_model_unavailable",
    });
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(configureHermesProvider("c", input, null, deps(offline as never))).rejects.toMatchObject({
      status: 502,
      code: "provider_unreachable",
    });
    await expect(configureHermesProvider("c", input, null, deps(statusFetch(503) as never))).rejects.toMatchObject({
      status: 502,
      code: "provider_error",
    });
    expect(calls).toEqual([]);
  });

  it("restores the template's previous files when Hermes fails part-way, without leaking the key", async () => {
    const templateDir = join(profilesDir, "agentdash");
    await mkdir(templateDir, { recursive: true });
    await writeFile(join(templateDir, ".env"), "GLM_API_KEY=previous\n");
    await writeFile(join(templateDir, "config.yaml"), "model.provider=zai\n");
    failOn = (args) => args[4] === "model.default";
    const input = parseHermesProviderInput({ provider: "openai", apiKey: "sk-proj-newkey123456" });

    const error = (await configureHermesProvider("c", input, null, deps(okFetch() as never)).catch((e) => e)) as HermesProviderSetupError;
    expect(error).toBeInstanceOf(HermesProviderSetupError);
    expect(error).toMatchObject({ status: 500, code: "hermes_config_failed" });
    expect(error.message).toMatch(/Nothing was changed/);
    expect(error.message).not.toContain("sk-proj-newkey123456");

    expect(await readFile(join(templateDir, ".env"), "utf8")).toBe("GLM_API_KEY=previous\n");
    expect(await readFile(join(templateDir, "config.yaml"), "utf8")).toBe("model.provider=zai\n");
    expect(secrets.put).not.toHaveBeenCalled();
    expect(existsSync(join(templateDir, HERMES_PROVIDER_MARKER))).toBe(false);
    expect(existsSync(join(profilesDir, ".agentdash.agentdash-backup"))).toBe(false);
  });

  it("removes a template it created when Hermes fails, so no half-configured template is left", async () => {
    failOn = (args) => args[4] === "GLM_API_KEY";
    const input = parseHermesProviderInput({ provider: "zai", apiKey: KEY });
    await expect(configureHermesProvider("c", input, null, deps(okFetch() as never))).rejects.toMatchObject({
      code: "hermes_config_failed",
    });
    expect(existsSync(join(profilesDir, "agentdash"))).toBe(false);
    expect(hermesProviderConfiguredSync({ HERMES_PROFILES_DIR: profilesDir })).toBe(false);
  });

  it("reports an agent profile it could not update by name, and still configures the template", async () => {
    await mkdir(join(profilesDir, "agentdash-broken1"), { recursive: true });
    failOn = (args) => args[1] === "agentdash-broken1";
    const input = parseHermesProviderInput({ provider: "zai", apiKey: KEY });
    const result = await configureHermesProvider("c", input, null, deps(okFetch() as never));
    expect(result.profilesFailed).toEqual(["agentdash-broken1"]);
    expect(result.profilesUpdated).toBe(0);
    expect(await readHermesProviderStatus({ env: {}, profilesDir })).toMatchObject({ configured: true });
  });
});
