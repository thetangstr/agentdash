// Integration coverage for the run-healer's adapter_switch fix against a real
// embedded Postgres, focused on AGENTDASH_FALLBACK_CHAIN:
//
//  - a chain hop can be "same adapter, different model", which the built-in
//    ADAPTER_FALLBACK_CHAIN table cannot express;
//  - the switch must rewrite adapterConfig.model, because the previous
//    adapter's model name is meaningless to the new adapter — before this
//    feature, a codex agent switched to hermes kept model "gpt-5.6-terra";
//  - an exhausted chain reports no_fallback_available instead of cycling.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { executeHealFix } from "../services/run-healer/fixer.js";
import type { HealDiagnosis } from "../services/run-healer/diagnosis.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

const switchDiagnosis: HealDiagnosis = {
  category: "RATE_LIMIT",
  confidence: "high",
  diagnosis: "Upstream provider quota exhausted",
  suggestedFix: "Switch to the fallback adapter",
  fixType: "adapter_switch",
};

describeEmbeddedPostgres("run-healer adapter_switch with AGENTDASH_FALLBACK_CHAIN", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalChain = process.env.AGENTDASH_FALLBACK_CHAIN;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-healer-fixer-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(() => {
    if (originalChain === undefined) delete process.env.AGENTDASH_FALLBACK_CHAIN;
    else process.env.AGENTDASH_FALLBACK_CHAIN = originalChain;
  });

  async function plantAgentWithFailedRun(adapterType: string, adapterConfig: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Fixer Co",
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Fixer Target",
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig,
      runtimeConfig: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      errorCode: "rate_limited",
      error: "429 from provider",
    });
    return { agentId, run: { id: runId, agentId, status: "failed", errorCode: "rate_limited" } };
  }

  async function readAgent(agentId: string) {
    const [row] = await db
      .select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, agentId));
    return { adapterType: row.adapterType, config: (row.adapterConfig ?? {}) as Record<string, unknown> };
  }

  it("moves a primary agent to the first hop, replacing the model", async () => {
    process.env.AGENTDASH_FALLBACK_CHAIN = "hermes_local:k3,hermes_local:glm-5.3";
    const { agentId, run } = await plantAgentWithFailedRun("codex_local", { model: "gpt-5.6-terra" });

    const result = await executeHealFix(db, run, switchDiagnosis);

    expect(result.succeeded).toBe(true);
    expect(result.actionTaken).toBe("adapter_switch_codex_local_to_hermes_local:k3");
    const after = await readAgent(agentId);
    expect(after.adapterType).toBe("hermes_local");
    expect(after.config.model).toBe("k3");
  });

  it("advances an agent already on hop one to hop two — same adapter, new model", async () => {
    process.env.AGENTDASH_FALLBACK_CHAIN = "hermes_local:k3,hermes_local:glm-5.3";
    const { agentId, run } = await plantAgentWithFailedRun("hermes_local", { model: "k3" });

    const result = await executeHealFix(db, run, switchDiagnosis);

    expect(result.succeeded).toBe(true);
    const after = await readAgent(agentId);
    expect(after.adapterType).toBe("hermes_local");
    expect(after.config.model).toBe("glm-5.3");
  });

  it("reports no_fallback_available once the chain is exhausted", async () => {
    process.env.AGENTDASH_FALLBACK_CHAIN = "hermes_local:k3,hermes_local:glm-5.3";
    const { agentId, run } = await plantAgentWithFailedRun("hermes_local", { model: "glm-5.3" });

    const result = await executeHealFix(db, run, switchDiagnosis);

    expect(result.succeeded).toBe(false);
    expect(result.actionTaken).toBe("no_fallback_available");
    const after = await readAgent(agentId);
    expect(after.adapterType).toBe("hermes_local");
    expect(after.config.model).toBe("glm-5.3");
  });

  it("legacy built-in table still applies without a chain — and now strips the stale model", async () => {
    delete process.env.AGENTDASH_FALLBACK_CHAIN;
    // Built-in table: codex_local -> opencode_local.
    const { agentId, run } = await plantAgentWithFailedRun("codex_local", {
      model: "gpt-5.6-terra",
      env: { CODEX_HOME: "/tmp/codex" },
    });

    const result = await executeHealFix(db, run, switchDiagnosis);

    expect(result.succeeded).toBe(true);
    expect(result.actionTaken).toBe("adapter_switch_codex_local_to_opencode_local");
    const after = await readAgent(agentId);
    expect(after.adapterType).toBe("opencode_local");
    // The old adapter's model must not survive; unrelated config keys do.
    expect(after.config.model).toBeUndefined();
    expect(after.config.env).toEqual({ CODEX_HOME: "/tmp/codex" });
  });
});
