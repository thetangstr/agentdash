// Integration coverage for the run-healer's adapter_switch fix against a real
// embedded Postgres, rewritten for the AGE-113 invariant:
//
//  - automatic recovery may retry, pause, block, or escalate, but it may NOT
//    change `agents.adapterType` or `adapterConfig.model`. The `adapter_switch`
//    diagnosis is executed as a bounded retry on the agent's OWN configuration
//    plus an escalation, never a switch;
//  - the agent row must be byte-identical before and after the heal — this is
//    the regression HAL (the MKThink Chief-of-Staff silently moved off
//    hermes_local) exists to prevent;
//  - an operator-configured AGENTDASH_FALLBACK_CHAIN is inert here: no hop is
//    ever applied, whatever it says.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describeEmbeddedPostgres("run-healer adapter_switch under the AGE-113 invariant", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalChain = process.env.AGENTDASH_FALLBACK_CHAIN;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-healer-fixer-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
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

  it("refuses the switch: agent stays exactly as configured, run re-enqueued on its own config", async () => {
    process.env.AGENTDASH_FALLBACK_CHAIN = "hermes_local:k3,hermes_local:glm-5.3";
    const { agentId, run } = await plantAgentWithFailedRun("codex_local", { model: "gpt-5.6-terra" });
    const before = await readAgent(agentId);

    const result = await executeHealFix(db, run, switchDiagnosis);

    // The heal "succeeds" in the recovery sense — a bounded retry is queued —
    // but the action taken must say the switch was refused, not performed.
    expect(result.succeeded).toBe(true);
    expect(result.actionTaken).toContain("adapter_switch_refused");
    expect(result.actionTaken).toContain("retry_on_codex_local:gpt-5.6-terra");

    // THE INVARIANT: the agent row is unchanged.
    const after = await readAgent(agentId);
    expect(after).toEqual(before);
    expect(after.adapterType).toBe("codex_local");
    expect(after.config.model).toBe("gpt-5.6-terra");
  });

  it("an agent already on a chain hop is not advanced — the chain cannot move it", async () => {
    process.env.AGENTDASH_FALLBACK_CHAIN = "hermes_local:k3,hermes_local:glm-5.3";
    const { agentId, run } = await plantAgentWithFailedRun("hermes_local", { model: "k3" });
    const before = await readAgent(agentId);

    const result = await executeHealFix(db, run, switchDiagnosis);

    expect(result.actionTaken).toContain("adapter_switch_refused");
    const after = await readAgent(agentId);
    expect(after).toEqual(before);
    expect(after.config.model).toBe("k3");
  });

  it("an exhausted chain changes nothing either — refusal, not no-op switch", async () => {
    process.env.AGENTDASH_FALLBACK_CHAIN = "hermes_local:k3,hermes_local:glm-5.3";
    const { agentId, run } = await plantAgentWithFailedRun("hermes_local", { model: "glm-5.3" });
    const before = await readAgent(agentId);

    const result = await executeHealFix(db, run, switchDiagnosis);

    expect(result.actionTaken).toContain("adapter_switch_refused");
    const after = await readAgent(agentId);
    expect(after).toEqual(before);
  });

  it("legacy built-in table is inert too — model and adapter both survive", async () => {
    delete process.env.AGENTDASH_FALLBACK_CHAIN;
    // Built-in table would have said codex_local -> opencode_local.
    const { agentId, run } = await plantAgentWithFailedRun("codex_local", {
      model: "gpt-5.6-terra",
      env: { CODEX_HOME: "/tmp/codex" },
    });
    const before = await readAgent(agentId);

    const result = await executeHealFix(db, run, switchDiagnosis);

    expect(result.actionTaken).toContain("adapter_switch_refused");
    const after = await readAgent(agentId);
    expect(after).toEqual(before);
    expect(after.adapterType).toBe("codex_local");
    expect(after.config.model).toBe("gpt-5.6-terra");
    expect(after.config.env).toEqual({ CODEX_HOME: "/tmp/codex" });
  });
});
