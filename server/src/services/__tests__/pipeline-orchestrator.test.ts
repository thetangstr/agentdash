import { describe, it, expect } from "vitest";
import { validatePipelineDag } from "../pipeline-orchestrator.js";

describe("validatePipelineDag", () => {
  it("accepts a valid linear pipeline", () => {
    const stages = [
      { id: "s1", name: "A", type: "agent" as const, scopedInstruction: "do A" },
      { id: "s2", name: "B", type: "agent" as const, scopedInstruction: "do B" },
    ];
    const edges = [{ id: "e1", fromStageId: "s1", toStageId: "s2" }];
    expect(() => validatePipelineDag(stages, edges)).not.toThrow();
  });

  it("rejects edges referencing non-existent stages", () => {
    const stages = [
      { id: "s1", name: "A", type: "agent" as const, scopedInstruction: "do A" },
    ];
    const edges = [{ id: "e1", fromStageId: "s1", toStageId: "s999" }];
    expect(() => validatePipelineDag(stages, edges)).toThrow(/unknown stage/i);
  });

  it("rejects cycles in the DAG", () => {
    const stages = [
      { id: "s1", name: "A", type: "agent" as const, scopedInstruction: "do A" },
      { id: "s2", name: "B", type: "agent" as const, scopedInstruction: "do B" },
    ];
    const edges = [
      { id: "e1", fromStageId: "s1", toStageId: "s2" },
      { id: "e2", fromStageId: "s2", toStageId: "s1" },
    ];
    expect(() => validatePipelineDag(stages, edges)).toThrow(/cycle/i);
  });

  it("accepts fan-out with merge", () => {
    const stages = [
      { id: "s1", name: "Start", type: "agent" as const, scopedInstruction: "start" },
      { id: "s2a", name: "Branch A", type: "agent" as const, scopedInstruction: "branch a" },
      { id: "s2b", name: "Branch B", type: "agent" as const, scopedInstruction: "branch b" },
      { id: "s3", name: "Merge", type: "merge" as const, scopedInstruction: "merge", mergeStrategy: "all" as const },
    ];
    const edges = [
      { id: "e1", fromStageId: "s1", toStageId: "s2a" },
      { id: "e2", fromStageId: "s1", toStageId: "s2b" },
      { id: "e3", fromStageId: "s2a", toStageId: "s3" },
      { id: "e4", fromStageId: "s2b", toStageId: "s3" },
    ];
    expect(() => validatePipelineDag(stages, edges)).not.toThrow();
  });

  it("rejects duplicate stage IDs", () => {
    const stages = [
      { id: "s1", name: "A", type: "agent" as const, scopedInstruction: "do A" },
      { id: "s1", name: "B", type: "agent" as const, scopedInstruction: "do B" },
    ];
    expect(() => validatePipelineDag(stages, [])).toThrow(/duplicate/i);
  });
});

describe("pipelineOrchestratorService module", () => {
  it("exports pipelineOrchestratorService function", async () => {
    const mod = await import("../pipeline-orchestrator.js");
    expect(typeof mod.pipelineOrchestratorService).toBe("function");
  });

  it("exports validatePipelineDag function", async () => {
    const mod = await import("../pipeline-orchestrator.js");
    expect(typeof mod.validatePipelineDag).toBe("function");
  });
});
