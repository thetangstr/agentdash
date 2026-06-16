import { describe, it, expect } from "vitest";
import { assertNoActiveNewsAgents } from "./guard.js";

function dbReturning(rows: { id: string; status: string }[]) {
  return { select: () => ({ from: () => ({ where: async () => rows }) }) } as never;
}

describe("assertNoActiveNewsAgents", () => {
  it("passes when all agents are paused", async () => {
    await expect(assertNoActiveNewsAgents(dbReturning([{ id: "a", status: "paused" }]), "c1")).resolves.toBeUndefined();
  });
  it("throws when any agent is not paused", async () => {
    await expect(assertNoActiveNewsAgents(dbReturning([{ id: "a", status: "active" }]), "c1"))
      .rejects.toThrow(/active/i);
  });
});
