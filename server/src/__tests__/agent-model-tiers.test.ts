// AgentDash (batch 4, c4-model-tiers + review-1028): the agentService.create
// funnel is the one path every hire flow shares — the CoS proposal creator,
// onboarding /confirm-plan, the CoS single-agent hire card, and
// workforce-template hires all insert through it. A hermes_local agent
// created without an explicit model gets its role's tier — only while the
// instance opted in (AGENTDASH_HERMES_MODEL_TIERS=on) and no BYOK marker
// sits on the box. An explicit model a person set always wins.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const ENV_KEYS = [
  "AGENTDASH_HERMES_MODEL_TIERS",
  "HERMES_PROFILES_DIR",
  "AGENTDASH_HERMES_ROOT",
  "AGENTDASH_HERMES_PROFILE_TEMPLATE",
] as const;

describeEmbeddedPostgres("agentService.create applies hermes model tiers", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let profilesDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("agent-model-tiers-");
    db = createDb(temp.connectionString);
  }, 600_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(profilesDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await temp?.cleanup();
  });

  async function company() {
    const [row] = await db
      .insert(companies)
      .values({ name: "Tier test", issuePrefix: randomUUID().slice(0, 8).toUpperCase() })
      .returning();
    return row!;
  }

  function storedConfig(agentId: string) {
    return db
      .select({ adapterConfig: agents.adapterConfig, metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
  }

  // Opt the instance in and point the BYOK marker check at an empty temp
  // dir — a dev box's real ~/.hermes could hold a marker and make every
  // tier case environment-dependent.
  function tiersOn() {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    profilesDir = mkdtempSync(join(tmpdir(), "hermes-tiers-create-"));
    process.env.HERMES_PROFILES_DIR = profilesDir;
    delete process.env.AGENTDASH_HERMES_ROOT;
    delete process.env.AGENTDASH_HERMES_PROFILE_TEMPLATE;
    process.env.AGENTDASH_HERMES_MODEL_TIERS = "on";
  }

  function writeByokMarker(provider = "zai") {
    mkdirSync(join(profilesDir, "agentdash"), { recursive: true });
    writeFileSync(
      join(profilesDir, "agentdash", "agentdash-provider.json"),
      JSON.stringify({ provider, model: "glm-5.3-flash" }),
    );
  }

  it("stamps the high tier on a modelless hermes_local leadership hire", async () => {
    tiersOn();
    const c = await company();
    const created = await agentService(db).create(c.id, {
      name: "Ava",
      role: "chief_of_staff",
      title: "Chief of Staff",
      adapterType: "hermes_local",
      adapterConfig: {},
    });
    expect(created.adapterConfig).toMatchObject({
      model: "qwen3.8-max-0902",
      provider: "alibaba-token-plan-cn",
    });
    expect(await storedConfig(created.id)).toMatchObject({
      adapterConfig: { model: "qwen3.8-max-0902", provider: "alibaba-token-plan-cn" },
      metadata: { modelTier: "high" },
    });
  });

  it("stamps the low tier on a modelless hermes_local ops hire", async () => {
    tiersOn();
    const c = await company();
    const created = await agentService(db).create(c.id, {
      name: "Bex",
      role: "engineer",
      title: "Backend Engineer",
      adapterType: "hermes_local",
      adapterConfig: {},
    });
    expect(created.adapterConfig).toMatchObject({
      model: "deepseek-v4-flash",
      provider: "alibaba-token-plan-cn",
    });
    expect(await storedConfig(created.id)).toMatchObject({ metadata: { modelTier: "low" } });
  });

  it("maps a lead-engineer title to high even under a general role enum", async () => {
    tiersOn();
    const c = await company();
    const created = await agentService(db).create(c.id, {
      name: "Cid",
      role: "general",
      title: "Head of Engineering",
      adapterType: "hermes_local",
      adapterConfig: {},
    });
    expect(created.adapterConfig).toMatchObject({ model: "qwen3.8-max-0902" });
    expect(await storedConfig(created.id)).toMatchObject({ metadata: { modelTier: "high" } });
  });

  it("never overwrites an explicit model, and records no tier for it", async () => {
    tiersOn();
    const c = await company();
    const created = await agentService(db).create(c.id, {
      name: "Dee",
      role: "ceo",
      adapterType: "hermes_local",
      adapterConfig: { model: "glm-5.3-flash", provider: "zai" },
    });
    expect(created.adapterConfig).toEqual({ model: "glm-5.3-flash", provider: "zai" });
    const stored = await storedConfig(created.id);
    expect(stored.metadata ?? {}).not.toHaveProperty("modelTier");
  });

  it("leaves non-hermes adapters alone", async () => {
    tiersOn();
    const c = await company();
    const created = await agentService(db).create(c.id, {
      name: "Eli",
      role: "ceo",
      adapterType: "claude_local",
      adapterConfig: {},
    });
    expect(created.adapterConfig).toEqual({});
    const stored = await storedConfig(created.id);
    expect(stored.metadata ?? {}).not.toHaveProperty("modelTier");
  });

  it("merges the tier stamp with caller metadata instead of replacing it", async () => {
    tiersOn();
    const c = await company();
    const created = await agentService(db).create(c.id, {
      name: "Fay",
      role: "pm",
      adapterType: "hermes_local",
      adapterConfig: {},
      metadata: { source: "workforce-template" },
    });
    expect(await storedConfig(created.id)).toMatchObject({
      metadata: { source: "workforce-template", modelTier: "high" },
    });
  });

  it("applies nothing with the switch off — the pre-tier behaviour (review-1028)", async () => {
    tiersOn();
    process.env.AGENTDASH_HERMES_MODEL_TIERS = "off";
    const c = await company();
    const created = await agentService(db).create(c.id, {
      name: "Gil",
      role: "chief_of_staff",
      adapterType: "hermes_local",
      adapterConfig: {},
    });
    expect(created.adapterConfig ?? {}).not.toHaveProperty("model");
    const stored = await storedConfig(created.id);
    expect(stored.adapterConfig ?? {}).not.toHaveProperty("model");
    expect(stored.metadata ?? {}).not.toHaveProperty("modelTier");
  });

  it("applies nothing on a BYOK box even with the switch on (review-1028)", async () => {
    tiersOn();
    writeByokMarker("zai");
    const c = await company();
    const created = await agentService(db).create(c.id, {
      name: "Hal",
      role: "ceo",
      adapterType: "hermes_local",
      adapterConfig: {},
    });
    expect(created.adapterConfig ?? {}).not.toHaveProperty("model");
    const stored = await storedConfig(created.id);
    expect(stored.adapterConfig ?? {}).not.toHaveProperty("model");
    expect(stored.metadata ?? {}).not.toHaveProperty("modelTier");
  });
});
