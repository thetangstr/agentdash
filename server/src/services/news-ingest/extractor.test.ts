import { describe, it, expect } from "vitest";
import { extractEvent } from "./extractor.js";
import { BEATS } from "./feeds.js";

const beat = BEATS[0]; // armed-conflict
const item = { title: "Ceasefire signed in Country X", link: "https://ex.com/a",
  summary: "Both sides agreed to halt fighting.", publishedAt: new Date("2026-06-14"), outlet: "BBC" };

describe("extractEvent", () => {
  it("uses the MiniMax JSON when available", async () => {
    const fakeLlm = async () => JSON.stringify({
      entities: ["Country X"], geo: { country: "Country X" }, confidence: 0.9,
      inflection: { phase: "ceasefire", parties: ["A", "B"] },
    });
    const out = await extractEvent(item, beat, { llm: fakeLlm });
    expect(out.inflection.phase).toBe("ceasefire");
    expect(out.entities).toContain("Country X");
    expect(out.confidence).toBeCloseTo(0.9);
  });
  it("falls back to heuristics when the LLM throws", async () => {
    const fakeLlm = async () => { throw new Error("minimax down"); };
    const out = await extractEvent(item, beat, { llm: fakeLlm });
    expect(out.confidence).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(out.entities)).toBe(true);
  });
  it("falls back when the LLM returns non-JSON", async () => {
    const out = await extractEvent(item, beat, { llm: async () => "sorry, no json here" });
    expect(out.confidence).toBeLessThan(0.6);
  });
});
