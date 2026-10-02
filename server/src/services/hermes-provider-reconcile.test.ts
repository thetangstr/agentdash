// AgentDash (#725): boot and provision-time reconcile from the company secret.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermesProviderReconciler, resetRepinRateLimit } from "./hermes-provider-reconcile.js";
import { HERMES_PROVIDER_MARKER } from "./hermes-provider-setup.js";

const KEY = "zai-reconcile-key-0123456789";
const AGENT = "aaaaaaaa-0000-4000-8000-000000000001";
const PROFILE = `agentdash-${AGENT.replace(/-/g, "")}`;

describe("hermesProviderReconciler", () => {
  let tmp: string;
  let profilesDir: string;
  let failOn: string | null;

  function reconciler(companyOfAgent: string | null = "company-1") {
    return hermesProviderReconciler({} as never, {
      setup: {
        env: {},
        // Any probe is a rate limit: inconclusive, changes nothing, never leaves the machine.
        fetch: (async () => new Response("{}", { status: 429 })) as never,
        profilesDir,
        runHermes: async (args) => {
          if (failOn && args[1] === failOn) throw new Error("boom");
          return { stdout: "", stderr: "" };
        },
        secrets: { put: vi.fn(), get: async (companyId) => (companyId === "company-1" ? KEY : null) },
        lock: (_key, fn) => fn(),
      },
      listAgentIds: async () => [AGENT],
      companyOfAgent: async () => companyOfAgent,
    });
  }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "hermes-reconcile-"));
    profilesDir = join(tmp, "profiles");
    failOn = null;
    await mkdir(join(profilesDir, "agentdash"), { recursive: true });
    await mkdir(join(profilesDir, PROFILE), { recursive: true });
    await writeFile(
      join(profilesDir, "agentdash", HERMES_PROVIDER_MARKER),
      JSON.stringify({ companyId: "company-1", provider: "zai", model: "glm-5.3-flash" }),
    );
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("at boot, writes the secret's key into the template and the owner's agent profiles", async () => {
    const result = await reconciler().reconcileAll();
    expect(result).toMatchObject({ status: "ok", updated: ["agentdash", PROFILE], failed: [], repinned: false });
    expect(await readFile(join(profilesDir, PROFILE, ".env"), "utf8")).toBe(`GLM_API_KEY=${KEY}\n`);
  });

  it("does nothing at boot when no company owns the template", async () => {
    await rm(join(profilesDir, "agentdash", HERMES_PROVIDER_MARKER));
    expect(await reconciler().reconcileAll()).toBeNull();
    expect(existsSync(join(profilesDir, PROFILE, ".env"))).toBe(false);
  });

  it("on provision, fills the new profile and throws when it cannot", async () => {
    expect((await reconciler().reconcileAgent(AGENT))?.updated).toContain(PROFILE);
    await rm(join(profilesDir, PROFILE, ".env"));
    failOn = PROFILE;
    await expect(reconciler().reconcileAgent(AGENT)).rejects.toThrow(/could not write the provider key/);
  });

  it("on provision, skips an agent whose company does not own the key", async () => {
    const result = await reconciler("company-2").reconcileAgent(AGENT);
    expect(result?.status).toBe("not_configured");
    expect(existsSync(join(profilesDir, PROFILE, ".env"))).toBe(false);
  });

  it("repinEndpoint only acts for the company that owns the template, and at most once per interval", async () => {
    resetRepinRateLimit();
    expect(await reconciler().repinEndpoint("company-2")).toEqual({ repinned: false, skipped: "not_configured" });
    // The skipped call did not spend the rate limit.
    expect(await reconciler().repinEndpoint("company-1")).toEqual({ repinned: false });
    expect(await reconciler().repinEndpoint("company-1")).toEqual({ repinned: false, skipped: "rate_limited" });
    resetRepinRateLimit();
  });
});
