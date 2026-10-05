import { describe, expect, it } from "vitest";
import { goalLevelLabel, GOAL_LEVEL_LABELS } from "./goal-level-label";
import { GOAL_LEVELS } from "@paperclipai/shared";

describe("goalLevelLabel", () => {
  // AgentDash (c4-polish): Goals labelled a goal "Task" — conflating a goal
  // with an issue/task. The product calls one piece of work a "job".
  it("labels the task level 'Job', not 'Task'", () => {
    expect(goalLevelLabel("task")).toBe("Job");
  });

  it("has a label for every level in the contract", () => {
    for (const level of GOAL_LEVELS) {
      expect(GOAL_LEVEL_LABELS[level]).toBeTruthy();
      expect(goalLevelLabel(level)).toBe(GOAL_LEVEL_LABELS[level]);
    }
  });

  it("falls back to the raw value for unknown levels", () => {
    expect(goalLevelLabel("custom")).toBe("custom");
    expect(goalLevelLabel(null)).toBe("");
  });
});
