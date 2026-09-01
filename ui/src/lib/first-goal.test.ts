import { describe, expect, it } from "vitest";
import {
  buildFirstGoalPayload,
  buildFirstGoalTaskPayloads,
  defaultFirstGoal,
  firstGoalExamples,
} from "./first-goal";

describe("firstGoalExamples", () => {
  it("names the owner in every example, so the goal reads as theirs", () => {
    for (const example of firstGoalExamples("Titus")) {
      expect(example.description).toContain("Titus");
    }
  });

  it("falls back to a neutral subject when the owner is unknown", () => {
    for (const example of firstGoalExamples("   ")) {
      expect(example.description).not.toContain("  ");
      expect(example.description.length).toBeGreaterThan(20);
    }
  });

  /**
   * A goal with one obvious task teaches nothing about why an agent workforce
   * exists. Each example has to be the multi-contributor shape, because that is
   * what the handoff brief later reassigns across the agents it creates.
   */
  it("gives every example an assembly task plus contributions to collect", () => {
    for (const example of firstGoalExamples("Titus")) {
      expect(example.tasks.length).toBeGreaterThanOrEqual(3);
      expect(example.key).toBeTruthy();
      expect(example.label).toBeTruthy();
    }
  });

  it("keeps example keys unique, since the picker stores the key", () => {
    const keys = firstGoalExamples("Titus").map((example) => example.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("defaultFirstGoal", () => {
  it("pre-fills the first example so the step can simply be accepted", () => {
    const draft = defaultFirstGoal("Titus");
    const [first] = firstGoalExamples("Titus");
    expect(draft.title).toBe(first.title);
    expect(draft.tasks).toEqual(first.tasks);
  });

  it("copies the task list rather than sharing it", () => {
    // Editing the draft must not mutate the catalogue behind it, or a second
    // visit to the step would show the previous edits as the "example".
    const draft = defaultFirstGoal("Titus");
    draft.tasks.push("something the owner typed");
    expect(firstGoalExamples("Titus")[0].tasks).not.toContain("something the owner typed");
  });
});

describe("buildFirstGoalPayload", () => {
  it("makes the Chief of Staff the owner of the goal", () => {
    // The CoS is what drives goals forward unprompted. A goal owned by nobody is
    // one that only moves when a person remembers it.
    expect(
      buildFirstGoalPayload({ title: " Weekly pack ", description: " why ", ownerAgentId: "cos-1" }),
    ).toEqual({
      title: "Weekly pack",
      description: "why",
      level: "company",
      status: "active",
      ownerAgentId: "cos-1",
    });
  });

  it("omits an empty description rather than sending a blank string", () => {
    const payload = buildFirstGoalPayload({
      title: "Weekly pack",
      description: "   ",
      ownerAgentId: "cos-1",
    });
    expect(payload).not.toHaveProperty("description");
  });
});

describe("buildFirstGoalTaskPayloads", () => {
  /**
   * The bug this exists to prevent. The scripted version of this flow created
   * the same four tasks with no `goalId`, so they sat outside the goal while the
   * output announced they were under it. A goal that looks populated and is
   * empty is worse than an obviously empty one — nobody goes looking.
   */
  it("links every task to the goal", () => {
    const payloads = buildFirstGoalTaskPayloads({
      goalId: "goal-1",
      assigneeAgentId: "cos-1",
      tasks: ["Assemble the pack", "Collect delivery status"],
    });

    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(payload.goalId).toBe("goal-1");
      expect(payload.assigneeAgentId).toBe("cos-1");
      expect(payload.status).toBe("todo");
    }
  });

  it("drops blank rows the owner left behind while editing", () => {
    const payloads = buildFirstGoalTaskPayloads({
      goalId: "goal-1",
      assigneeAgentId: "cos-1",
      tasks: ["Assemble the pack", "   ", "", "Collect hiring"],
    });

    expect(payloads.map((payload) => payload.title)).toEqual([
      "Assemble the pack",
      "Collect hiring",
    ]);
  });

  it("creates the first task idle, like every other onboarding task", () => {
    // Same promise the task step makes: nothing runs until the owner says so.
    const [payload] = buildFirstGoalTaskPayloads({
      goalId: "goal-1",
      assigneeAgentId: "cos-1",
      tasks: ["Assemble the pack"],
    });
    expect(payload.status).toBe("todo");
  });
});
