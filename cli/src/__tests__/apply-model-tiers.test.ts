// AgentDash (batch 4, c4-model-tiers): `doctor apply-model-tiers` backfills
// pre-tier hermes_local agents onto the role high/low tiers. The dry run only
// lists; --apply fills agents without an explicit model, audits each change,
// and leaves explicit configs — and non-hermes adapters — alone.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  applyModelTiers,
  MODEL_TIERS_ACTOR_ID,
  planModelTiers,
} from "../commands/apply-model-tiers.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("doctor apply-model-tiers", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-apply-model-tiers-");
    db = createDb(tempDb.connectionString);
  }, 600_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function company() {
    const [row] = await db
      .insert(companies)
      .values({ name: "Tier co", issuePrefix: randomUUID().slice(0, 6).toUpperCase() })
      .returning();
    return row!;
  }

  async function agent(companyId: string, input: {
    name: string;
    role?: string;
    title?: string;
    adapterType?: string;
    adapterConfig?: Record<string, unknown>;
    status?: string;
  }) {
    const [row] = await db
      .insert(agents)
      .values({
        companyId,
        name: input.name,
        role: input.role ?? "general",
        title: input.title ?? null,
        adapterType: input.adapterType ?? "hermes_local",
        adapterConfig: input.adapterConfig ?? {},
        status: input.status ?? "idle",
      })
      .returning();
    return row!;
  }

  it("dry-run plan lists every hermes_local agent with current → proposed", async () => {
    const c = await company();
    const modelless = await agent(c.id, { name: "CoS", role: "chief_of_staff", title: "Chief of Staff" });
    const ops = await agent(c.id, { name: "Ops", role: "engineer" });
    const explicit = await agent(c.id, {
      name: "Custom",
      role: "engineer",
      adapterConfig: { model: "glm-5.3-flash", provider: "zai" },
    });
    await agent(c.id, { name: "NotHermes", adapterType: "claude_local" });

    const plan = await planModelTiers(db, c.id);
    expect(plan).toHaveLength(3);

    const cos = plan.find((item) => item.agentId === modelless.id)!;
    expect(cos.action).toBe("fill");
    expect(cos.tier).toBe("high");
    expect(cos.current).toEqual({ model: null, provider: null });
    expect(cos.proposed).toEqual({ model: "qwen3.8-max", provider: "alibaba-token-plan-cn" });

    const opsPlan = plan.find((item) => item.agentId === ops.id)!;
    expect(opsPlan.action).toBe("fill");
    expect(opsPlan.tier).toBe("low");
    expect(opsPlan.proposed.model).toBe("deepseek-v4.1-flash");

    const explicitPlan = plan.find((item) => item.agentId === explicit.id)!;
    expect(explicitPlan.action).toBe("explicit_kept");
  });

  it("--apply fills only modelless hermes_local agents and logs activity", async () => {
    const c = await company();
    const leader = await agent(c.id, { name: "Lead", role: "general", title: "Lead Engineer" });
    const ops = await agent(c.id, { name: "Ops", role: "engineer" });
    const explicit = await agent(c.id, {
      name: "Custom",
      role: "pm",
      adapterConfig: { model: "glm-5.3-flash", provider: "zai" },
    });
    const notHermes = await agent(c.id, { name: "Claude", adapterType: "claude_local" });

    const { applied, skipped } = await applyModelTiers(db, { companyId: c.id });
    expect(applied.map((item) => item.agentId).sort()).toEqual([leader.id, ops.id].sort());
    expect(skipped.map((item) => item.agentId)).toContain(explicit.id);

    const rows = await db.select().from(agents).where(eq(agents.companyId, c.id));
    const leaderRow = rows.find((row) => row.id === leader.id)!;
    expect(leaderRow.adapterConfig).toMatchObject({
      model: "qwen3.8-max",
      provider: "alibaba-token-plan-cn",
    });
    expect(leaderRow.metadata).toMatchObject({ modelTier: "high" });

    const opsRow = rows.find((row) => row.id === ops.id)!;
    expect(opsRow.adapterConfig).toMatchObject({ model: "deepseek-v4.1-flash" });
    expect(opsRow.metadata).toMatchObject({ modelTier: "low" });

    const explicitRow = rows.find((row) => row.id === explicit.id)!;
    expect(explicitRow.adapterConfig).toEqual({ model: "glm-5.3-flash", provider: "zai" });
    expect(explicitRow.metadata ?? {}).not.toHaveProperty("modelTier");

    const notHermesRow = rows.find((row) => row.id === notHermes.id)!;
    expect(notHermesRow.adapterConfig).toEqual({});

    const log = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.companyId, c.id), eq(activityLog.action, "agent.model_tier_applied")));
    expect(log).toHaveLength(2);
    for (const row of log) {
      expect(row.actorType).toBe("system");
      expect(row.actorId).toBe(MODEL_TIERS_ACTOR_ID);
      expect(row.entityType).toBe("agent");
      expect(row.details).toMatchObject({ reason: expect.stringContaining("apply-model-tiers") });
    }
    const leaderLog = log.find((row) => row.entityId === leader.id)!;
    expect(leaderLog.details).toMatchObject({
      tier: "high",
      to: { model: "qwen3.8-max", provider: "alibaba-token-plan-cn" },
    });
  });

  it("skips terminated agents and agents already on their tier", async () => {
    const c = await company();
    const dead = await agent(c.id, { name: "Dead", role: "ceo", status: "terminated" });
    const already = await agent(c.id, {
      name: "Already",
      role: "cto",
      adapterConfig: { model: "qwen3.8-max", provider: "alibaba-token-plan-cn" },
    });

    const plan = await planModelTiers(db, c.id);
    expect(plan.find((item) => item.agentId === dead.id)?.action).toBe("terminated");
    expect(plan.find((item) => item.agentId === already.id)?.action).toBe("already_on_tier");

    const { applied } = await applyModelTiers(db, { companyId: c.id });
    expect(applied).toHaveLength(0);
  });
});
