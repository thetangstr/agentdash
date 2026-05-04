// AgentDash (Phase C): unit tests for the JSON-trailer parser.
//
// Round-trip: a fake LLM response with a valid trailer parses + strips body.
// Malformed inputs return null trailer, never crash.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseJsonTrailer, type TrailerPayload } from "../services/deep-interview-parser.js";

// Silence the parser's own warn logs during tests so the output is readable.
vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const VALID_TRAILER: TrailerPayload = {
  ambiguity_score: 0.42,
  dimensions: { goal: 0.7, constraints: 0.5, criteria: 0.4, context: 0.6 },
  ontology_delta: [
    {
      name: "Customer",
      type: "core_domain",
      fields: ["id", "email"],
      relationships: ["Order"],
    },
  ],
  next_phase: "continue",
  action: "ask_next",
};

function buildResponse(body: string, trailer: TrailerPayload): string {
  return `${body}\n\n\`\`\`json\n${JSON.stringify(trailer, null, 2)}\n\`\`\``;
}

describe("parseJsonTrailer — valid trailers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("round-trips a well-formed trailer and strips the fenced block", () => {
    const raw = buildResponse(
      "Here is my next question. Do you support multi-tenant?",
      VALID_TRAILER,
    );
    const result = parseJsonTrailer(raw);
    expect(result.trailer).not.toBeNull();
    expect(result.trailer!.ambiguity_score).toBeCloseTo(0.42);
    expect(result.trailer!.dimensions.goal).toBeCloseTo(0.7);
    expect(result.trailer!.ontology_delta).toHaveLength(1);
    expect(result.trailer!.ontology_delta[0]!.name).toBe("Customer");
    // visibleBody must NOT contain the fenced block.
    expect(result.visibleBody).not.toContain("```json");
    expect(result.visibleBody).toContain("Do you support multi-tenant?");
  });

  it("accepts trailer without optional 'action' field", () => {
    const trailer: TrailerPayload = { ...VALID_TRAILER };
    delete (trailer as Partial<TrailerPayload>).action;
    const raw = buildResponse("Question?", trailer);
    const result = parseJsonTrailer(raw);
    expect(result.trailer).not.toBeNull();
    expect(result.trailer!.action).toBeUndefined();
  });

  it("accepts all four next_phase challenge values", () => {
    for (const phase of [
      "continue",
      "crystallize",
      "challenge:contrarian",
      "challenge:simplifier",
      "challenge:ontologist",
    ] as const) {
      const trailer: TrailerPayload = { ...VALID_TRAILER, next_phase: phase };
      const raw = buildResponse("Q?", trailer);
      const result = parseJsonTrailer(raw);
      expect(result.trailer, `phase ${phase}`).not.toBeNull();
      expect(result.trailer!.next_phase).toBe(phase);
    }
  });
});

describe("parseJsonTrailer — malformed inputs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null trailer when fence is missing", () => {
    const result = parseJsonTrailer("Just prose, no fence at all.");
    expect(result.trailer).toBeNull();
    expect(result.visibleBody).toBe("Just prose, no fence at all.");
  });

  it("returns null trailer when JSON is unterminated", () => {
    const raw = 'Body\n\n```json\n{"ambiguity_score": 0.5, "dim';
    const result = parseJsonTrailer(raw);
    expect(result.trailer).toBeNull();
  });

  it("returns null trailer when trailer payload is non-object", () => {
    const raw = "Body\n\n```json\n42\n```";
    const result = parseJsonTrailer(raw);
    expect(result.trailer).toBeNull();
  });

  it("returns null trailer when ambiguity_score is missing", () => {
    const raw = `Body\n\n\`\`\`json\n${JSON.stringify({
      dimensions: VALID_TRAILER.dimensions,
      ontology_delta: [],
      next_phase: "continue",
    })}\n\`\`\``;
    const result = parseJsonTrailer(raw);
    expect(result.trailer).toBeNull();
  });

  it("returns null trailer when next_phase is unknown", () => {
    const raw = buildResponse("Q?", {
      ...VALID_TRAILER,
      // @ts-expect-error testing rejection of unknown phase
      next_phase: "nonsense",
    });
    const result = parseJsonTrailer(raw);
    expect(result.trailer).toBeNull();
  });

  it("returns null trailer when ontology entity has wrong type", () => {
    const raw = buildResponse("Q?", {
      ...VALID_TRAILER,
      // @ts-expect-error testing rejection of unknown ontology type
      ontology_delta: [{ name: "X", type: "garbage" }],
    });
    const result = parseJsonTrailer(raw);
    expect(result.trailer).toBeNull();
  });

  it("returns null trailer when dimensions are non-numeric", () => {
    const raw = buildResponse("Q?", {
      ...VALID_TRAILER,
      // @ts-expect-error testing rejection of non-numeric dim
      dimensions: { goal: "high", constraints: 0.5, criteria: 0.4, context: 0.6 },
    });
    const result = parseJsonTrailer(raw);
    expect(result.trailer).toBeNull();
  });

  it("never throws on completely empty input", () => {
    expect(() => parseJsonTrailer("")).not.toThrow();
    const result = parseJsonTrailer("");
    expect(result.trailer).toBeNull();
    expect(result.visibleBody).toBe("");
  });
});

describe("parseJsonTrailer — body extraction edge cases", () => {
  it("strips trailing whitespace from visibleBody", () => {
    const raw = `Body line   \n\n\`\`\`json\n${JSON.stringify(VALID_TRAILER)}\n\`\`\`   `;
    const result = parseJsonTrailer(raw);
    expect(result.visibleBody.endsWith(" ")).toBe(false);
    expect(result.visibleBody).toBe("Body line");
  });

  it("matches only the LAST fenced json block when multiple appear", () => {
    const raw = `Pre block\n\`\`\`json\n{"foo":1}\n\`\`\`\nMid\n\`\`\`json\n${JSON.stringify(
      VALID_TRAILER,
    )}\n\`\`\``;
    const result = parseJsonTrailer(raw);
    expect(result.trailer).not.toBeNull();
    expect(result.trailer!.ambiguity_score).toBeCloseTo(0.42);
  });
});
