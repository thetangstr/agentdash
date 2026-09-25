// AgentDash (#725): `POST /api/onboarding/setup-adapter` with the hermes preset
// and a provider. Real handler, real error middleware, real authz; Hermes, the
// provider call, the secret store and the activity log are faked so the test
// can assert that no key material reaches a response, a log line or an
// activity entry.
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorHandler } from "../middleware/error-handler.js";
import { logger } from "../middleware/logger.js";
import { createHermesProviderSetupHandler } from "../routes/hermes-provider-setup.js";

const KEY = "sk-or-v1-routetestkey0123456789";

const admin = {
  type: "board",
  userId: "founder-1",
  source: "session",
  isInstanceAdmin: true,
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", status: "active", membershipRole: "owner" }],
};

describe("POST /api/onboarding/setup-adapter (hermes provider)", () => {
  let tmp: string;
  let profilesDir: string;
  let hermesCalls: string[][];
  let secretPuts: unknown[][];
  let activity: ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let logSpies: Array<ReturnType<typeof vi.spyOn>>;
  const savedEnv: Record<string, string | undefined> = {};

  function buildApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.actor = actor;
      next();
    });
    const handler = createHermesProviderSetupHandler({} as never, {
      setup: {
        env: {},
        profilesDir,
        fetch: fetchMock as never,
        runHermes: async (args) => {
          hermesCalls.push(args);
          if (args[0] === "profile" && args[1] === "create") await mkdir(join(profilesDir, args[2]!), { recursive: true });
          return { stdout: "", stderr: "" };
        },
        secrets: {
          put: async (...args: unknown[]) => {
            secretPuts.push(args);
            return { restore: async () => undefined };
          },
          get: async () => null,
        },
        lock: (_key, fn) => fn(),
      },
      logActivity: activity as never,
      listAgentIds: async () => [],
    });
    app.post("/api/onboarding/setup-adapter", handler);
    app.use(errorHandler);
    return app;
  }

  /** Everything a caller or an operator can see, as one string. */
  function observable(res: request.Response): string {
    return [
      JSON.stringify(res.body),
      JSON.stringify(activity.mock.calls),
      ...logSpies.map((spy) => JSON.stringify(spy.mock.calls)),
    ].join("\n");
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "hermes-provider-route-"));
    profilesDir = join(tmp, "profiles");
    await mkdir(profilesDir, { recursive: true });
    hermesCalls = [];
    secretPuts = [];
    activity = vi.fn(async () => undefined);
    fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    logSpies = (["info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(logger, level));
    for (const key of ["AGENTDASH_DEFAULT_ADAPTER", "PAPERCLIP_E2E_SKIP_LLM"]) savedEnv[key] = process.env[key];
  });

  afterEach(async () => {
    for (const spy of logSpies) spy.mockRestore();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("saves a verified key into Hermes and the company's secrets, and never returns or logs it", async () => {
    const res = await request(buildApp(admin))
      .post("/api/onboarding/setup-adapter")
      .send({ preset: "hermes", provider: "openrouter", apiKey: KEY, companyId: "company-1" });

    expect(res.status).toBe(201);
    expect(res.body.hermesProvider).toEqual({
      configured: true,
      provider: "openrouter",
      label: "OpenRouter",
      model: "z-ai/glm-5.2",
    });
    expect(res.body.applied).toEqual(["OPENROUTER_API_KEY", "model.provider", "model.default"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Persisted where Hermes and every profile read it.
    expect(await readFile(join(profilesDir, "agentdash", ".env"), "utf8")).toBe(`OPENROUTER_API_KEY=${KEY}\n`);
    // Company-scoped secret.
    expect(secretPuts).toEqual([
      ["company-1", "hermes-provider-api-key", KEY, "Hermes provider key (OpenRouter)", "founder-1"],
    ]);
    // Activity names the provider, never the key.
    expect(activity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "hermes_provider.configured",
        details: { provider: "openrouter", model: "z-ai/glm-5.2", profilesUpdated: 0 },
      }),
    );
    // No process-wide settings change at runtime.
    expect(process.env.AGENTDASH_DEFAULT_ADAPTER).toBe(savedEnv.AGENTDASH_DEFAULT_ADAPTER);
    expect(process.env.PAPERCLIP_E2E_SKIP_LLM).toBe(savedEnv.PAPERCLIP_E2E_SKIP_LLM);
    // The key reached no Hermes command line.
    expect(JSON.stringify(hermesCalls)).not.toContain(KEY);
    expect(observable(res)).not.toContain(KEY);
  });

  it("returns a readable error for a wrong key, leaks nothing, and leaves no template behind", async () => {
    fetchMock.mockImplementation(async () => new Response(`{"error":{"message":"bad key ${KEY}"}}`, { status: 401 }));
    const res = await request(buildApp(admin))
      .post("/api/onboarding/setup-adapter")
      .send({ preset: "hermes", provider: "openrouter", apiKey: KEY, companyId: "company-1" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("OpenRouter rejected this API key (HTTP 401). Check the key and try again.");
    expect(res.body.details).toEqual({ code: "provider_key_rejected" });
    expect(hermesCalls).toEqual([]);
    expect(secretPuts).toEqual([]);
    expect(activity).not.toHaveBeenCalled();
    expect(existsSync(join(profilesDir, "agentdash"))).toBe(false);
    expect(observable(res)).not.toContain(KEY);
  });

  it("403s a signed-in user who is not the instance admin", async () => {
    const res = await request(buildApp({ ...admin, isInstanceAdmin: false }))
      .post("/api/onboarding/setup-adapter")
      .send({ preset: "hermes", provider: "zai", apiKey: KEY, companyId: "company-1" });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hermesCalls).toEqual([]);
  });

  it("403s an admin naming a company they do not belong to", async () => {
    const res = await request(buildApp(admin))
      .post("/api/onboarding/setup-adapter")
      .send({ preset: "hermes", provider: "zai", apiKey: KEY, companyId: "company-2" });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("401s an agent and 400s bad input before any provider call", async () => {
    const agentRes = await request(buildApp({ type: "agent", agentId: "a1", companyId: "company-1" }))
      .post("/api/onboarding/setup-adapter")
      .send({ preset: "hermes", provider: "zai", apiKey: KEY, companyId: "company-1" });
    expect([401, 403]).toContain(agentRes.status);

    const app = buildApp(admin);
    for (const body of [
      { preset: "hermes", provider: "zai", apiKey: KEY },
      { preset: "hermes", provider: "minimax", apiKey: KEY, companyId: "company-1" },
      { preset: "hermes", provider: "zai", apiKey: "", companyId: "company-1" },
      { preset: "hermes", provider: "zai", apiKey: "a\nB=1", companyId: "company-1" },
    ]) {
      const res = await request(app).post("/api/onboarding/setup-adapter").send(body);
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
