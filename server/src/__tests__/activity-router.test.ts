import { describe, it, expect } from "vitest";
import { activityRouter } from "../services/activity-router.js";

describe("activityRouter.classify", () => {
  it("returns chat-worthy for task_completed", () => {
    const r = activityRouter().classify({ kind: "task_completed", agentId: "a1", payload: { title: "Drafted email" } });
    expect(r).toMatchObject({ chatWorthy: true, summary: expect.stringContaining("Drafted email"), severity: "info" });
  });
  it("returns chat-worthy for blocker_raised with severity blocked", () => {
    expect(activityRouter().classify({ kind: "blocker_raised", agentId: "a1", payload: { reason: "API down" } })).toMatchObject({ chatWorthy: true, severity: "blocked" });
  });
  it("returns chat-worthy for agent_paused with severity warn", () => {
    expect(activityRouter().classify({ kind: "agent_paused", agentId: "a1" })).toMatchObject({ chatWorthy: true, severity: "warn" });
  });
  it("drops heartbeat ticks", () => {
    expect(activityRouter().classify({ kind: "heartbeat_tick", agentId: "a1" }).chatWorthy).toBe(false);
  });
  it("drops noisy log lines", () => {
    expect(activityRouter().classify({ kind: "log", agentId: "a1" }).chatWorthy).toBe(false);
  });
});
