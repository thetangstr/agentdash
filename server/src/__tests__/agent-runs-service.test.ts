/**
 * AgentDash (AGE-119): Tests for agent-run metering service.
 *
 * Tests cover:
 * - Complexity classification (simple/medium/complex)
 * - Recording runs and querying monthly counts
 * - Idempotent recording (duplicate heartbeat_run_id)
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { classifyComplexity } from "../services/agent-runs.ts";

// ---------------------------------------------------------------------------
// Unit tests — classifyComplexity (pure function, no DB)
// ---------------------------------------------------------------------------

describe("classifyComplexity", () => {
  it("returns 'simple' for low token count and short duration", () => {
    expect(classifyComplexity(500, 5_000)).toBe("simple");
  });

  it("returns 'simple' for zero tokens and null duration", () => {
    expect(classifyComplexity(0, null)).toBe("simple");
  });

  it("returns 'medium' when token count exceeds medium threshold", () => {
    expect(classifyComplexity(10_000, 1_000)).toBe("medium");
  });

  it("returns 'medium' when duration exceeds medium threshold", () => {
    expect(classifyComplexity(100, 60_000)).toBe("medium");
  });

  it("returns 'complex' when token count exceeds complex threshold", () => {
    expect(classifyComplexity(100_000, 1_000)).toBe("complex");
  });

  it("returns 'complex' when duration exceeds complex threshold", () => {
    expect(classifyComplexity(100, 600_000)).toBe("complex");
  });

  it("returns 'complex' when both token and duration exceed complex thresholds", () => {
    expect(classifyComplexity(200_000, 1_200_000)).toBe("complex");
  });

  it("returns 'medium' just below complex thresholds", () => {
    expect(classifyComplexity(99_999, 599_999)).toBe("medium");
  });

  it("returns 'simple' just below medium thresholds", () => {
    expect(classifyComplexity(9_999, 59_999)).toBe("simple");
  });

  it("treats null duration as 0", () => {
    // 50k tokens → medium, regardless of null duration
    expect(classifyComplexity(50_000, null)).toBe("medium");
  });

  it("treats undefined duration as 0", () => {
    expect(classifyComplexity(50_000, undefined)).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// Integration tests — agentRunService (requires embedded PG)
// ---------------------------------------------------------------------------

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createDb, companies, agents, heartbeatRuns, costEvents } from "@paperclipai/db";
import { agentRunService } from "../services/agent-runs.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-runs tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentRunService (integration)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-vitest-agent-runs-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    // Create a company and agent for each test.
    companyId = randomUUID();
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      issuePrefix: `T${Date.now().toString(36).slice(-4).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Test Agent",
      adapterType: "process",
      role: "engineer",
    });
  });

  async function createHeartbeatRun(overrides: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const runId = randomUUID();
    const now = new Date();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      startedAt: new Date(now.getTime() - 30_000),
      finishedAt: now,
      ...overrides,
    });
    return runId;
  }

  async function createCostEvent(heartbeatRunId: string, costCents: number, tokens: number) {
    await db.insert(costEvents).values({
      companyId,
      agentId,
      heartbeatRunId,
      provider: "test",
      model: "test-model",
      inputTokens: tokens,
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents,
      occurredAt: new Date(),
    });
  }

  it("records a run and returns it", async () => {
    const svc = agentRunService(db);
    const runId = await createHeartbeatRun();

    const result = await svc.recordRun({
      companyId,
      agentId,
      heartbeatRunId: runId,
      finishedAt: new Date(),
    });

    expect(result).not.toBeNull();
    expect(result!.companyId).toBe(companyId);
    expect(result!.agentId).toBe(agentId);
    expect(result!.heartbeatRunId).toBe(runId);
    expect(result!.complexityTier).toBe("simple");
  });

  it("is idempotent — duplicate heartbeatRunId returns null", async () => {
    const svc = agentRunService(db);
    const runId = await createHeartbeatRun();

    const first = await svc.recordRun({
      companyId,
      agentId,
      heartbeatRunId: runId,
      finishedAt: new Date(),
    });
    expect(first).not.toBeNull();

    const second = await svc.recordRun({
      companyId,
      agentId,
      heartbeatRunId: runId,
      finishedAt: new Date(),
    });
    expect(second).toBeNull();
  });

  it("aggregates tokens and cost from cost_events", async () => {
    const svc = agentRunService(db);
    const runId = await createHeartbeatRun();

    await createCostEvent(runId, 50, 5_000);
    await createCostEvent(runId, 100, 8_000);

    const result = await svc.recordRun({
      companyId,
      agentId,
      heartbeatRunId: runId,
      finishedAt: new Date(),
    });

    expect(result).not.toBeNull();
    expect(result!.tokenCount).toBe(13_000);
    expect(result!.costCents).toBe(150);
    expect(result!.complexityTier).toBe("medium"); // 13k tokens > 10k medium threshold
  });

  it("computes durationMs from startedAt and finishedAt", async () => {
    const svc = agentRunService(db);
    const finishedAt = new Date();
    const startedAt = new Date(finishedAt.getTime() - 120_000); // 2 minutes

    const runId = await createHeartbeatRun({
      startedAt,
      finishedAt,
    });

    const result = await svc.recordRun({
      companyId,
      agentId,
      heartbeatRunId: runId,
      startedAt,
      finishedAt,
    });

    expect(result).not.toBeNull();
    expect(result!.durationMs).toBe(120_000);
    expect(result!.complexityTier).toBe("medium"); // 120s > 60s medium threshold
  });

  it("monthlyCount returns correct totals", async () => {
    const svc = agentRunService(db);

    // Record three runs with different complexities.
    const run1 = await createHeartbeatRun();
    await svc.recordRun({
      companyId,
      agentId,
      heartbeatRunId: run1,
      finishedAt: new Date(),
    });

    const run2 = await createHeartbeatRun();
    await createCostEvent(run2, 100, 15_000); // medium
    await svc.recordRun({
      companyId,
      agentId,
      heartbeatRunId: run2,
      finishedAt: new Date(),
    });

    const run3 = await createHeartbeatRun();
    await createCostEvent(run3, 500, 150_000); // complex
    await svc.recordRun({
      companyId,
      agentId,
      heartbeatRunId: run3,
      finishedAt: new Date(),
    });

    const count = await svc.monthlyCount(companyId);
    expect(count.total).toBe(3);
    expect(count.simple).toBe(1);
    expect(count.medium).toBe(1);
    expect(count.complex).toBe(1);
  });

  it("monthlyCount filters by agentId", async () => {
    const svc = agentRunService(db);

    // Create a second agent.
    const agent2Id = randomUUID();
    await db.insert(agents).values({
      id: agent2Id,
      companyId,
      name: "Agent 2",
      adapterType: "process",
      role: "engineer",
    });

    const run1 = await createHeartbeatRun();
    await svc.recordRun({ companyId, agentId, heartbeatRunId: run1, finishedAt: new Date() });

    const run2 = await createHeartbeatRun({ agentId: agent2Id });
    await svc.recordRun({ companyId, agentId: agent2Id, heartbeatRunId: run2, finishedAt: new Date() });

    const agent1Count = await svc.monthlyCount(companyId, { agentId });
    expect(agent1Count.total).toBe(1);

    const agent2Count = await svc.monthlyCount(companyId, { agentId: agent2Id });
    expect(agent2Count.total).toBe(1);

    const allCount = await svc.monthlyCount(companyId);
    expect(allCount.total).toBe(2);
  });

  it("monthlyCountByAgent returns per-agent breakdown", async () => {
    const svc = agentRunService(db);

    const agent2Id = randomUUID();
    await db.insert(agents).values({
      id: agent2Id,
      companyId,
      name: "Agent 2",
      adapterType: "process",
      role: "engineer",
    });

    // Agent 1: 2 runs. Agent 2: 1 run.
    const run1 = await createHeartbeatRun();
    await svc.recordRun({ companyId, agentId, heartbeatRunId: run1, finishedAt: new Date() });
    const run2 = await createHeartbeatRun();
    await svc.recordRun({ companyId, agentId, heartbeatRunId: run2, finishedAt: new Date() });
    const run3 = await createHeartbeatRun({ agentId: agent2Id });
    await svc.recordRun({ companyId, agentId: agent2Id, heartbeatRunId: run3, finishedAt: new Date() });

    const rows = await svc.monthlyCountByAgent(companyId);
    expect(rows.length).toBe(2);

    const agent1Row = rows.find((r) => r.agentId === agentId);
    expect(agent1Row?.total).toBe(2);

    const agent2Row = rows.find((r) => r.agentId === agent2Id);
    expect(agent2Row?.total).toBe(1);
  });
});
