import { describe, it, expect } from "vitest";
import { parseMentions } from "../mention-parser.js";

const dir = [
  { id: "a1", name: "Reese", role: "SDR" },
  { id: "a2", name: "Mira", role: "SDR" },
  { id: "a3", name: "Theo", role: "ops coordinator" },
];

describe("parseMentions", () => {
  it("resolves a unique name mention", () => {
    const mentions = parseMentions("hey @reese can you check this?", dir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({ agentId: "a1", matchText: "@reese" });
  });

  it("flags ambiguous role mention", () => {
    const mentions = parseMentions("@SDR what's our pipeline?", dir);
    expect(mentions[0].ambiguous).toBe(true);
    expect(mentions[0].agentId).toBeNull();
  });

  it("returns no agentId for unknown mention", () => {
    const mentions = parseMentions("@unknown person", dir);
    expect(mentions[0].agentId).toBeNull();
    expect(mentions[0].ambiguous).toBeUndefined();
  });

  it("ignores mentions inside fenced code blocks", () => {
    expect(parseMentions("```\n@reese\n```", dir)).toEqual([]);
  });

  it("ignores mentions inside inline code", () => {
    expect(parseMentions("look at `@reese` placeholder", dir)).toEqual([]);
  });

  it("returns multiple mentions in order", () => {
    const mentions = parseMentions("@reese and @theo, please coordinate", dir);
    expect(mentions).toHaveLength(2);
    expect(mentions[0].agentId).toBe("a1");
    expect(mentions[1].agentId).toBe("a3");
  });
});
