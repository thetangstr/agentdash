import { describe, it, expect } from "vitest";
import {
  findEntryStages,
  findNextStages,
  buildStateEnvelope,
  applyStateMapping,
} from "../pipeline-runner.js";
import type { PipelineStageDefinition, PipelineEdgeDefinition } from "@agentdash/shared";

const linearStages: PipelineStageDefinition[] = [
  { id: "s1", name: "Scrape", type: "agent", scopedInstruction: "scrape" },
  { id: "s2", name: "Enrich", type: "agent", scopedInstruction: "enrich" },
  { id: "s3", name: "Score", type: "agent", scopedInstruction: "score" },
];

const linearEdges: PipelineEdgeDefinition[] = [
  { id: "e1", fromStageId: "s1", toStageId: "s2" },
  { id: "e2", fromStageId: "s2", toStageId: "s3" },
];

describe("findEntryStages", () => {
  it("finds stages with no incoming edges", () => {
    const result = findEntryStages(linearStages, linearEdges);
    expect(result).toEqual(["s1"]);
  });

  it("finds multiple entry stages for fan-out", () => {
    const stages: PipelineStageDefinition[] = [
      { id: "a", name: "A", type: "agent", scopedInstruction: "a" },
      { id: "b", name: "B", type: "agent", scopedInstruction: "b" },
    ];
    const result = findEntryStages(stages, []);
    expect(result).toHaveLength(2);
    expect(result).toContain("a");
    expect(result).toContain("b");
  });
});

describe("findNextStages", () => {
  it("finds the next stage in a linear pipeline", () => {
    const data = { result: "scraped data" };
    const result = findNextStages("s1", linearEdges, data);
    expect(result).toEqual(["s2"]);
  });

  it("returns empty for the last stage", () => {
    const result = findNextStages("s3", linearEdges, {});
    expect(result).toEqual([]);
  });

  it("evaluates conditional edges", () => {
    const edges: PipelineEdgeDefinition[] = [
      { id: "e1", fromStageId: "s1", toStageId: "s2", condition: "data.score > 0.7" },
      { id: "e2", fromStageId: "s1", toStageId: "s3", condition: "data.score <= 0.7" },
    ];
    const highScore = findNextStages("s1", edges, { score: 0.9 });
    expect(highScore).toEqual(["s2"]);

    const lowScore = findNextStages("s1", edges, { score: 0.3 });
    expect(lowScore).toEqual(["s3"]);
  });

  it("follows unconditional edges alongside conditional", () => {
    const edges: PipelineEdgeDefinition[] = [
      { id: "e1", fromStageId: "s1", toStageId: "s2" },
      { id: "e2", fromStageId: "s1", toStageId: "s3", condition: "data.flag === true" },
    ];
    const result = findNextStages("s1", edges, { flag: true });
    expect(result).toEqual(["s2", "s3"]);
  });
});

describe("buildStateEnvelope", () => {
  it("wraps output data with metadata", () => {
    const env = buildStateEnvelope({
      pipelineRunId: "run-1",
      pipelineId: "pipe-1",
      sourceStageId: "s1",
      data: { leads: [1, 2, 3] },
      stageIndex: 1,
      totalStages: 3,
      executionMode: "sync",
      accumulatedCostUsd: 0.5,
    });
    expect(env.pipelineRunId).toBe("run-1");
    expect(env.sourceStageId).toBe("s1");
    expect(env.data.leads).toEqual([1, 2, 3]);
    expect(env.metadata.stageIndex).toBe(1);
    expect(env.metadata.executionMode).toBe("sync");
  });
});

describe("applyStateMapping", () => {
  it("maps fields from source to target keys", () => {
    const source = { score: 0.85, name: "Acme", extra: "ignored" };
    const mapping = { rating: "score", company: "name" };
    const result = applyStateMapping(source, mapping);
    expect(result).toEqual({ rating: 0.85, company: "Acme" });
  });

  it("passes through all data when no mapping defined", () => {
    const source = { a: 1, b: 2 };
    const result = applyStateMapping(source, undefined);
    expect(result).toEqual({ a: 1, b: 2 });
  });
});
