// AgentDash (batch 4, c4-model-tiers): the agentService.create funnel is the
// one path every hire flow shares — the CoS proposal creator, onboarding
// /confirm-plan, the CoS single-agent hire card, and workforce-template hires
// all insert through it. A hermes_local agent created without an explicit
// model gets its role's tier; an explicit model a person set always wins.
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

describeEmbeddedPostgres("agentService.create applies hermes model tiers", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("agent-model-tiers-");
    db = createDb(temp.connectionString);
  }, 600_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
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

  it("stamps the high tier on a modelless hermes_local leadership hire", async () => {
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
});
