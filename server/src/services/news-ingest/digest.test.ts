// server/src/services/news-ingest/digest.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildDigests } from "./digest.js";

describe("buildDigests", () => {
  it("makes one digest per agent that logged events, plus an Atlas summary", () => {
    const rows = [
      { agentId: "a1", agentName: "Armed Conflict & War", title: "X", beat: "armed-conflict" },
      { agentId: "a1", agentName: "Armed Conflict & War", title: "Y", beat: "armed-conflict" },
      { agentId: "a2", agentName: "Science & Research", title: "Z", beat: "science" },
    ];
    const digests = buildDigests(rows, { atlasAgentId: "atlas", atlasName: "Atlas" });
    expect(digests.find((d) => d.agentId === "a1")?.count).toBe(2);
    expect(digests.find((d) => d.agentId === "a2")?.count).toBe(1);
    const atlas = digests.find((d) => d.agentId === "atlas");
    expect(atlas?.count).toBe(3);
    expect(atlas?.title).toMatch(/wire digest/i);
  });
});
