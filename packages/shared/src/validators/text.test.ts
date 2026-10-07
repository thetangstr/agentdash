import { describe, expect, it } from "vitest";
import { normalizeEscapedLineBreaks } from "./text.js";

describe("normalizeEscapedLineBreaks", () => {
  it("turns escaped line breaks in prose into real ones (unchanged behaviour)", () => {
    expect(normalizeEscapedLineBreaks("Done\\n\\n- Verified")).toBe("Done\n\n- Verified");
    expect(normalizeEscapedLineBreaks("a\\r\\nb\\rc")).toBe("a\nb\nc");
  });

  it("still unescapes a body that is escaped end to end, fences included", () => {
    expect(normalizeEscapedLineBreaks("# Plan\\n\\n```sh\\npnpm test\\n```")).toBe("# Plan\n\n```sh\npnpm test\n```");
  });

  // AgentDash (PR #1059 review): code is literal. JSON in a fenced block
  // writes newlines inside strings as `\n`; turning those into real line
  // breaks made the JSON unparseable.
  it("leaves fenced code blocks literal", () => {
    const json = JSON.stringify({ detail: "line one\nline two", path: "C:\\new\\rates" });
    const body = "Intro\\nline\n\n```json\n" + json + "\n```\nAfter\\nwards";
    const out = normalizeEscapedLineBreaks(body);
    expect(out).toBe("Intro\nline\n\n```json\n" + json + "\n```\nAfter\nwards");
    const fenced = out.split("```json\n")[1]!.split("\n```")[0]!;
    expect(JSON.parse(fenced)).toEqual({ detail: "line one\nline two", path: "C:\\new\\rates" });
  });

  it("treats tilde fences and longer fences the same, and an unclosed fence as prose", () => {
    expect(normalizeEscapedLineBreaks("~~~\nprintf 'a\\nb'\n~~~")).toBe("~~~\nprintf 'a\\nb'\n~~~");
    expect(normalizeEscapedLineBreaks("````md\n```\nx\\ny\n```\n````")).toBe("````md\n```\nx\\ny\n```\n````");
    expect(normalizeEscapedLineBreaks("```\nopen\\nnever closed")).toBe("```\nopen\nnever closed");
  });

  it("leaves a body that is a whole JSON document untouched", () => {
    const json = JSON.stringify({ schema: "ac.milestone-timeline/v1", events: [{ detail: "a\nb\r\nc" }] }, null, 2);
    expect(normalizeEscapedLineBreaks(json)).toBe(json);
    // Not JSON: normalized as before.
    expect(normalizeEscapedLineBreaks("{not json\\n}")).toBe("{not json\n}");
  });
});
