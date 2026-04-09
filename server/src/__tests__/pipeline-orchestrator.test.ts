import { describe, it, expect } from "vitest";
import { validatePipelineDag } from "../services/pipeline-orchestrator.js";
import {
  findEntryStages,
  findNextStages,
  buildStateEnvelope,
  applyStateMapping,
  getStageById,
  getIncomingEdges,
  isMergeReady,
  getEffectiveTimeout,
  getEffectiveMaxRetries,
} from "../services/pipeline-runner.js";
import { evaluateCondition } from "../services/pipeline-condition-evaluator.js";
import type { PipelineStageDefinition, PipelineEdgeDefinition } from "@agentdash/shared";

// ── Helper factories ────────────────────────────────────────────────────

function makeStage(overrides: Partial<PipelineStageDefinition> & { id: string }): PipelineStageDefinition {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    type: overrides.type ?? "agent_task",
    instruction: overrides.instruction ?? "Do the thing",
    ...overrides,
  } as PipelineStageDefinition;
}

function makeEdge(from: string, to: string, overrides?: Partial<PipelineEdgeDefinition>): PipelineEdgeDefinition {
  return {
    id: overrides?.id ?? `${from}->${to}`,
    fromStageId: from,
    toStageId: to,
    condition: overrides?.condition ?? undefined,
    ...overrides,
  } as PipelineEdgeDefinition;
}

// ── validatePipelineDag ─────────────────────────────────────────────────

describe("validatePipelineDag", () => {
  it("accepts a simple linear DAG", () => {
    const stages = [makeStage({ id: "a" }), makeStage({ id: "b" }), makeStage({ id: "c" })];
    const edges = [makeEdge("a", "b"), makeEdge("b", "c")];

    expect(() => validatePipelineDag(stages, edges)).not.toThrow();
  });

  it("accepts a DAG with no edges (all entry stages)", () => {
    const stages = [makeStage({ id: "a" }), makeStage({ id: "b" })];
    expect(() => validatePipelineDag(stages, [])).not.toThrow();
  });

  it("accepts a fan-out / fan-in diamond DAG", () => {
    const stages = [
      makeStage({ id: "start" }),
      makeStage({ id: "left" }),
      makeStage({ id: "right" }),
      makeStage({ id: "merge" }),
    ];
    const edges = [
      makeEdge("start", "left"),
      makeEdge("start", "right"),
      makeEdge("left", "merge"),
      makeEdge("right", "merge"),
    ];

    expect(() => validatePipelineDag(stages, edges)).not.toThrow();
  });

  it("rejects duplicate stage IDs", () => {
    const stages = [makeStage({ id: "a" }), makeStage({ id: "a" })];
    expect(() => validatePipelineDag(stages, [])).toThrow("Duplicate stage ID");
  });

  it("rejects edges referencing unknown fromStageId", () => {
    const stages = [makeStage({ id: "a" }), makeStage({ id: "b" })];
    const edges = [makeEdge("unknown", "b")];
    expect(() => validatePipelineDag(stages, edges)).toThrow("Unknown stage referenced");
  });

  it("rejects edges referencing unknown toStageId", () => {
    const stages = [makeStage({ id: "a" }), makeStage({ id: "b" })];
    const edges = [makeEdge("a", "unknown")];
    expect(() => validatePipelineDag(stages, edges)).toThrow("Unknown stage referenced");
  });

  it("detects a simple cycle (A -> B -> A)", () => {
    const stages = [makeStage({ id: "a" }), makeStage({ id: "b" })];
    const edges = [makeEdge("a", "b"), makeEdge("b", "a")];
    expect(() => validatePipelineDag(stages, edges)).toThrow("Cycle detected");
  });

  it("detects a longer cycle (A -> B -> C -> A)", () => {
    const stages = [makeStage({ id: "a" }), makeStage({ id: "b" }), makeStage({ id: "c" })];
    const edges = [makeEdge("a", "b"), makeEdge("b", "c"), makeEdge("c", "a")];
    expect(() => validatePipelineDag(stages, edges)).toThrow("Cycle detected");
  });

  it("detects cycle in subgraph of larger DAG", () => {
    const stages = [
      makeStage({ id: "entry" }),
      makeStage({ id: "a" }),
      makeStage({ id: "b" }),
      makeStage({ id: "c" }),
    ];
    const edges = [
      makeEdge("entry", "a"),
      makeEdge("a", "b"),
      makeEdge("b", "c"),
      makeEdge("c", "a"), // cycle in a-b-c
    ];
    expect(() => validatePipelineDag(stages, edges)).toThrow("Cycle detected");
  });

  it("accepts a complex multi-path DAG without cycles", () => {
    // 8-stage RFP pipeline shape
    const stages = Array.from({ length: 8 }, (_, i) => makeStage({ id: `s${i}` }));
    const edges = [
      makeEdge("s0", "s1"),
      makeEdge("s1", "s2"),
      makeEdge("s1", "s3"), // fan-out
      makeEdge("s2", "s4"),
      makeEdge("s3", "s4"), // fan-in
      makeEdge("s4", "s5"),
      makeEdge("s5", "s6"),
      makeEdge("s6", "s7"),
    ];

    expect(() => validatePipelineDag(stages, edges)).not.toThrow();
  });
});

// ── findEntryStages ─────────────────────────────────────────────────────

describe("findEntryStages", () => {
  it("returns stages with no incoming edges", () => {
    const stages = [makeStage({ id: "a" }), makeStage({ id: "b" }), makeStage({ id: "c" })];
    const edges = [makeEdge("a", "b"), makeEdge("a", "c")];

    expect(findEntryStages(stages, edges)).toEqual(["a"]);
  });

  it("returns all stages when no edges exist", () => {
    const stages = [makeStage({ id: "a" }), makeStage({ id: "b" })];
    expect(findEntryStages(stages, [])).toEqual(["a", "b"]);
  });

  it("returns multiple entry stages in fan-out", () => {
    const stages = [makeStage({ id: "a" }), makeStage({ id: "b" }), makeStage({ id: "c" })];
    const edges = [makeEdge("a", "c"), makeEdge("b", "c")];

    const entries = findEntryStages(stages, edges);
    expect(entries).toContain("a");
    expect(entries).toContain("b");
    expect(entries).not.toContain("c");
  });
});

// ── findNextStages ──────────────────────────────────────────────────────

describe("findNextStages", () => {
  it("returns downstream stages after completion", () => {
    const edges = [makeEdge("a", "b"), makeEdge("a", "c")];
    expect(findNextStages("a", edges, {})).toEqual(["b", "c"]);
  });

  it("returns empty when no outgoing edges", () => {
    const edges = [makeEdge("a", "b")];
    expect(findNextStages("b", edges, {})).toEqual([]);
  });

  it("filters by condition evaluation", () => {
    const edges = [
      makeEdge("a", "b", { condition: 'data.approved === true' }),
      makeEdge("a", "c", { condition: 'data.approved === false' }),
    ];

    expect(findNextStages("a", edges, { approved: true })).toEqual(["b"]);
    expect(findNextStages("a", edges, { approved: false })).toEqual(["c"]);
  });

  it("passes all edges when no conditions", () => {
    const edges = [makeEdge("a", "b"), makeEdge("a", "c")];
    expect(findNextStages("a", edges, {})).toEqual(["b", "c"]);
  });
});

// ── buildStateEnvelope ──────────────────────────────────────────────────

describe("buildStateEnvelope", () => {
  it("builds envelope with all metadata", () => {
    const envelope = buildStateEnvelope({
      pipelineRunId: "run-1",
      pipelineId: "pipe-1",
      sourceStageId: "stage-a",
      data: { key: "value" },
      stageIndex: 2,
      totalStages: 8,
      executionMode: "async",
      accumulatedCostUsd: 1.5,
    });

    expect(envelope.pipelineRunId).toBe("run-1");
    expect(envelope.sourceStageId).toBe("stage-a");
    expect(envelope.data).toEqual({ key: "value" });
    expect(envelope.metadata.pipelineId).toBe("pipe-1");
    expect(envelope.metadata.stageIndex).toBe(2);
    expect(envelope.metadata.totalStages).toBe(8);
    expect(envelope.metadata.executionMode).toBe("async");
    expect(envelope.metadata.accumulatedCostUsd).toBe(1.5);
  });

  it("allows null sourceStageId for entry stages", () => {
    const envelope = buildStateEnvelope({
      pipelineRunId: "run-1",
      pipelineId: "pipe-1",
      sourceStageId: null,
      data: {},
      stageIndex: 0,
      totalStages: 3,
      executionMode: "sync",
      accumulatedCostUsd: 0,
    });

    expect(envelope.sourceStageId).toBeNull();
  });
});

// ── applyStateMapping ───────────────────────────────────────────────────

describe("applyStateMapping", () => {
  it("maps source keys to target keys", () => {
    const source = { foo: "bar", baz: 42 };
    const mapping = { newFoo: "foo", newBaz: "baz" };

    expect(applyStateMapping(source, mapping)).toEqual({ newFoo: "bar", newBaz: 42 });
  });

  it("returns shallow copy when no mapping", () => {
    const source = { foo: "bar" };
    const result = applyStateMapping(source, undefined);

    expect(result).toEqual(source);
    expect(result).not.toBe(source);
  });

  it("returns undefined for missing source keys", () => {
    const source = { foo: "bar" };
    const mapping = { target: "nonexistent" };

    expect(applyStateMapping(source, mapping)).toEqual({ target: undefined });
  });
});

// ── getStageById ────────────────────────────────────────────────────────

describe("getStageById", () => {
  const stages = [makeStage({ id: "a" }), makeStage({ id: "b" }), makeStage({ id: "c" })];

  it("finds stage by id", () => {
    expect(getStageById(stages, "b")?.id).toBe("b");
  });

  it("returns undefined for unknown id", () => {
    expect(getStageById(stages, "z")).toBeUndefined();
  });
});

// ── getIncomingEdges ────────────────────────────────────────────────────

describe("getIncomingEdges", () => {
  const edges = [makeEdge("a", "c"), makeEdge("b", "c"), makeEdge("c", "d")];

  it("returns edges pointing to target stage", () => {
    const incoming = getIncomingEdges("c", edges);
    expect(incoming).toHaveLength(2);
    expect(incoming.map((e) => e.fromStageId)).toEqual(["a", "b"]);
  });

  it("returns empty for entry stages", () => {
    expect(getIncomingEdges("a", edges)).toHaveLength(0);
  });
});

// ── isMergeReady ────────────────────────────────────────────────────────

describe("isMergeReady", () => {
  const edges = [makeEdge("a", "merge"), makeEdge("b", "merge"), makeEdge("c", "merge")];

  it("wait-all: requires all incoming stages completed", () => {
    expect(isMergeReady("merge", edges, new Set(["a", "b"]), "all")).toBe(false);
    expect(isMergeReady("merge", edges, new Set(["a", "b", "c"]), "all")).toBe(true);
  });

  it("first-wins: requires any incoming stage completed", () => {
    expect(isMergeReady("merge", edges, new Set([]), "any")).toBe(false);
    expect(isMergeReady("merge", edges, new Set(["a"]), "any")).toBe(true);
  });

  it("returns true when no incoming edges", () => {
    expect(isMergeReady("orphan", [], new Set(), "all")).toBe(true);
  });
});

// ── getEffectiveTimeout ─────────────────────────────────────────────────

describe("getEffectiveTimeout", () => {
  it("uses stage-level timeout when set", () => {
    const stage = makeStage({ id: "a", timeoutMinutes: 60 });
    expect(getEffectiveTimeout(stage, null)).toBe(60);
  });

  it("falls back to pipeline defaults", () => {
    const stage = makeStage({ id: "a" });
    expect(getEffectiveTimeout(stage, { stageTimeoutMinutes: 45 } as any)).toBe(45);
  });

  it("falls back to 30 minutes when nothing set", () => {
    const stage = makeStage({ id: "a" });
    expect(getEffectiveTimeout(stage, null)).toBe(30);
  });

  it("uses hours for HITL gates", () => {
    const stage = makeStage({ id: "hitl", type: "hitl_gate", hitlTimeoutHours: 48 } as any);
    expect(getEffectiveTimeout(stage, null)).toBe(48 * 60);
  });

  it("HITL gate defaults to 72 hours", () => {
    const stage = makeStage({ id: "hitl", type: "hitl_gate" } as any);
    expect(getEffectiveTimeout(stage, null)).toBe(72 * 60);
  });
});

// ── getEffectiveMaxRetries ──────────────────────────────────────────────

describe("getEffectiveMaxRetries", () => {
  it("uses stage-level maxRetries when set", () => {
    const stage = makeStage({ id: "a", maxRetries: 5 } as any);
    expect(getEffectiveMaxRetries(stage, null)).toBe(5);
  });

  it("falls back to pipeline defaults", () => {
    const stage = makeStage({ id: "a" });
    expect(getEffectiveMaxRetries(stage, { maxSelfHealRetries: 2 } as any)).toBe(2);
  });

  it("defaults to 3 when nothing set", () => {
    const stage = makeStage({ id: "a" });
    expect(getEffectiveMaxRetries(stage, null)).toBe(3);
  });
});

// ── evaluateCondition ───────────────────────────────────────────────────

describe("evaluateCondition", () => {
  it("returns true for empty/null condition", () => {
    expect(evaluateCondition(null, {})).toBe(true);
    expect(evaluateCondition(undefined, {})).toBe(true);
    expect(evaluateCondition("", {})).toBe(true);
    expect(evaluateCondition("   ", {})).toBe(true);
  });

  it("evaluates simple equality", () => {
    expect(evaluateCondition('data.status === "approved"', { status: "approved" })).toBe(true);
    expect(evaluateCondition('data.status === "approved"', { status: "rejected" })).toBe(false);
  });

  it("evaluates inequality", () => {
    expect(evaluateCondition('data.status !== "failed"', { status: "ok" })).toBe(true);
    expect(evaluateCondition('data.status !== "failed"', { status: "failed" })).toBe(false);
  });

  it("evaluates numeric comparisons", () => {
    expect(evaluateCondition("data.score > 80", { score: 90 })).toBe(true);
    expect(evaluateCondition("data.score > 80", { score: 70 })).toBe(false);
    expect(evaluateCondition("data.score >= 80", { score: 80 })).toBe(true);
    expect(evaluateCondition("data.score < 50", { score: 30 })).toBe(true);
    expect(evaluateCondition("data.score <= 50", { score: 50 })).toBe(true);
  });

  it("evaluates boolean values", () => {
    expect(evaluateCondition("data.approved === true", { approved: true })).toBe(true);
    expect(evaluateCondition("data.approved === false", { approved: false })).toBe(true);
  });

  it("supports && (AND) operator", () => {
    expect(evaluateCondition('data.a === true && data.b === "ok"', { a: true, b: "ok" })).toBe(true);
    expect(evaluateCondition('data.a === true && data.b === "ok"', { a: true, b: "bad" })).toBe(false);
  });

  it("supports || (OR) operator", () => {
    expect(evaluateCondition('data.x === 1 || data.x === 2', { x: 2 })).toBe(true);
    expect(evaluateCondition('data.x === 1 || data.x === 2', { x: 3 })).toBe(false);
  });

  it("resolves nested properties", () => {
    expect(evaluateCondition('data.result.status === "done"', { result: { status: "done" } })).toBe(true);
  });

  it("returns false for missing data properties (truthy check)", () => {
    expect(evaluateCondition("data.missing", {})).toBe(false);
  });

  it("throws on forbidden patterns (eval)", () => {
    expect(() => evaluateCondition("eval('alert(1)')", {})).toThrow("Unsafe condition");
  });

  it("throws on forbidden patterns (require)", () => {
    expect(() => evaluateCondition("require('fs')", {})).toThrow("Unsafe condition");
  });

  it("throws on forbidden patterns (process)", () => {
    expect(() => evaluateCondition("process.env.SECRET", {})).toThrow("Unsafe condition");
  });

  it("throws on forbidden patterns (constructor/__proto__)", () => {
    expect(() => evaluateCondition("data.__proto__", {})).toThrow("Unsafe condition");
    expect(() => evaluateCondition("data.constructor", {})).toThrow("Unsafe condition");
  });

  it("throws on brackets and semicolons", () => {
    expect(() => evaluateCondition("data.x; delete data.y", {})).toThrow("Unsafe condition");
    expect(() => evaluateCondition("data[0]", {})).toThrow("Unsafe condition");
  });
});
