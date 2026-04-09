import { beforeEach, describe, expect, it, vi } from "vitest";
import { pipelineSelfHealService } from "../services/pipeline-self-heal.js";

// Mock drizzle-orm so eq() doesn't need a real DB connection
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual };
});

function makeStageExec(overrides: Record<string, unknown> = {}) {
  return {
    id: "stage-exec-1",
    selfHealAttempts: 0,
    selfHealLog: [],
    status: "failed",
    ...overrides,
  };
}

function makeDb(stageExec: ReturnType<typeof makeStageExec> | null = makeStageExec()) {
  const selectResult = stageExec ? [stageExec] : [];
  const updateChain = { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(undefined) };
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(selectResult),
      }),
    }),
    update: vi.fn().mockReturnValue(updateChain),
    _updateChain: updateChain,
  };
}

describe("pipelineSelfHealService", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
  });

  it("exports a service factory function", () => {
    expect(typeof pipelineSelfHealService).toBe("function");
  });

  it("returns a service object with attemptHeal", () => {
    const svc = pipelineSelfHealService(db as any);
    expect(svc).toBeDefined();
    expect(typeof svc.attemptHeal).toBe("function");
  });

  it("throws when stage execution is not found", async () => {
    db = makeDb(null);
    const svc = pipelineSelfHealService(db as any);

    await expect(
      svc.attemptHeal("missing-id", "do the thing", {}, "some error", 3),
    ).rejects.toThrow("Stage execution not found");
  });

  it("returns shouldRetry=false and original instruction when maxRetries exceeded", async () => {
    db = makeDb(makeStageExec({ selfHealAttempts: 3 }));
    const svc = pipelineSelfHealService(db as any);

    const result = await svc.attemptHeal(
      "stage-exec-1",
      "original instruction",
      {},
      "timeout error",
      3,
    );

    expect(result.shouldRetry).toBe(false);
    expect(result.adjustedInstruction).toBe("original instruction");
    // No DB update should happen when maxRetries already reached
    expect(db.update).not.toHaveBeenCalled();
  });

  it("returns shouldRetry=true and adjusted instruction for first failure", async () => {
    const svc = pipelineSelfHealService(db as any);

    const result = await svc.attemptHeal(
      "stage-exec-1",
      "fetch the data",
      { url: "https://example.com" },
      "connection refused",
      3,
    );

    expect(result.shouldRetry).toBe(true);
    expect(result.adjustedInstruction).toContain("fetch the data");
    expect(result.adjustedInstruction).toContain("connection refused");
  });

  it("updates the stage execution with incremented attempt count on retry", async () => {
    const svc = pipelineSelfHealService(db as any);

    await svc.attemptHeal(
      "stage-exec-1",
      "run the pipeline",
      {},
      "execution failed",
      3,
    );

    expect(db.update).toHaveBeenCalledOnce();
    const setCall = db._updateChain.set.mock.calls[0]?.[0];
    expect(setCall).toMatchObject({
      selfHealAttempts: 1,
      status: "pending",
    });
    expect(Array.isArray(setCall?.selfHealLog)).toBe(true);
    expect(setCall?.selfHealLog).toHaveLength(1);
    expect(setCall?.selfHealLog[0]).toMatchObject({
      attempt: 1,
      outcome: "retried",
    });
  });

  it("sets status to failed and shouldRetry=false when previous attempts exhaust diagnose limit", async () => {
    // diagnoseStageFailure returns shouldRetry: previousAttempts.length < 3
    // so with 3 entries in healLog it returns false — but maxRetries gate fires first.
    // Use maxRetries=10 and selfHealAttempts=2 with a healLog of 3 prior entries
    // so the diagnose function's own guard (previousAttempts.length < 3) flips to false.
    const healLog = [
      { attempt: 1, diagnosis: "d1", adjustedInstruction: "i1", outcome: "retried", timestamp: "t1" },
      { attempt: 2, diagnosis: "d2", adjustedInstruction: "i2", outcome: "retried", timestamp: "t2" },
      { attempt: 3, diagnosis: "d3", adjustedInstruction: "i3", outcome: "retried", timestamp: "t3" },
    ];
    db = makeDb(makeStageExec({ selfHealAttempts: 3, selfHealLog: healLog }));
    const svc = pipelineSelfHealService(db as any);

    const result = await svc.attemptHeal(
      "stage-exec-1",
      "process the batch",
      {},
      "still failing",
      10,
    );

    expect(result.shouldRetry).toBe(false);
    const setCall = db._updateChain.set.mock.calls[0]?.[0];
    expect(setCall?.status).toBe("failed");
    expect(setCall?.selfHealLog[setCall.selfHealLog.length - 1]).toMatchObject({
      outcome: "failed",
    });
  });

  it("includes input data keys and attempt history in adjusted instruction", async () => {
    const healLog = [
      { attempt: 1, diagnosis: "prev diag", adjustedInstruction: "prev instr", outcome: "retried", timestamp: "t1" },
    ];
    db = makeDb(makeStageExec({ selfHealAttempts: 1, selfHealLog: healLog }));
    const svc = pipelineSelfHealService(db as any);

    const result = await svc.attemptHeal(
      "stage-exec-1",
      "transform records",
      { recordId: "abc", batchSize: 100 },
      "invalid schema",
      3,
    );

    expect(result.adjustedInstruction).toContain("transform records");
    expect(result.adjustedInstruction).toContain("invalid schema");
    expect(result.adjustedInstruction).toContain("retry attempt 2");
  });
});
