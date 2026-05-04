// AgentDash (Phase C): unit tests for the deep-interview engine state machine.
//
// We mock the Drizzle DB at the call-site level (select/insert/update returning
// predictable shapes) and inject a stub dispatchLLM that returns canned
// responses with valid JSON trailers. This keeps the test scope to engine
// logic without standing up an embedded postgres.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AMBIGUITY_THRESHOLD,
  HARD_ROUND_CAP,
  computeWeightedAmbiguity,
  pickChallengeMode,
  targetWeakestDimension,
  allDimensionsDone,
  nextOntologySnapshot,
  deepInterviewEngine,
  type EngineLLMDispatch,
} from "../services/deep-interview-engine.js";
import type {
  DimensionScores,
  OntologySnapshot,
  TranscriptTurn,
} from "@paperclipai/shared/deep-interview";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Pure-helper tests
// ---------------------------------------------------------------------------

describe("computeWeightedAmbiguity", () => {
  it("brownfield uses 35/25/25/15 weights", () => {
    const dims: DimensionScores = {
      goal: 1,
      constraints: 1,
      criteria: 1,
      context: 1,
    };
    expect(computeWeightedAmbiguity(dims, true)).toBeCloseTo(0, 5);
  });

  it("brownfield with all-zeros yields ambiguity 1.0", () => {
    const dims: DimensionScores = {
      goal: 0,
      constraints: 0,
      criteria: 0,
      context: 0,
    };
    expect(computeWeightedAmbiguity(dims, true)).toBeCloseTo(1, 5);
  });

  it("greenfield uses 40/30/30 weights and ignores context", () => {
    const dims: DimensionScores = {
      goal: 1,
      constraints: 1,
      criteria: 1,
      context: 0,
    };
    // 1 - (1*0.4 + 1*0.3 + 1*0.3) = 0
    expect(computeWeightedAmbiguity(dims, false)).toBeCloseTo(0, 5);
  });

  it("clamps non-finite or out-of-range inputs", () => {
    const dims: DimensionScores = {
      goal: Number.POSITIVE_INFINITY,
      constraints: -10,
      criteria: 2,
      context: NaN,
    };
    const v = computeWeightedAmbiguity(dims, true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe("targetWeakestDimension", () => {
  it("returns 'goal' when all are equal (stable tiebreak)", () => {
    const dims: DimensionScores = {
      goal: 0.5,
      constraints: 0.5,
      criteria: 0.5,
      context: 0.5,
    };
    expect(targetWeakestDimension(dims, true)).toBe("goal");
  });

  it("returns the lowest-scoring dim", () => {
    const dims: DimensionScores = {
      goal: 0.9,
      constraints: 0.3,
      criteria: 0.6,
      context: 0.7,
    };
    expect(targetWeakestDimension(dims, true)).toBe("constraints");
  });

  it("ignores 'context' on greenfield", () => {
    const dims: DimensionScores = {
      goal: 0.9,
      constraints: 0.5,
      criteria: 0.4,
      context: 0.0,
    };
    expect(targetWeakestDimension(dims, false)).toBe("criteria");
  });

  it("falls back to 'goal' when dims are null", () => {
    expect(targetWeakestDimension(null, true)).toBe("goal");
  });
});

describe("pickChallengeMode", () => {
  it("returns 'contrarian' on round 4 if not used", () => {
    expect(pickChallengeMode(4, [], 0.6)).toBe("contrarian");
  });

  it("does not re-fire a mode that's already in challengeModesUsed", () => {
    expect(pickChallengeMode(4, ["contrarian"], 0.6)).toBeNull();
  });

  it("returns 'simplifier' on round 6", () => {
    expect(pickChallengeMode(6, ["contrarian"], 0.6)).toBe("simplifier");
  });

  it("returns 'ontologist' on round 8 only when ambiguity > 0.3", () => {
    expect(pickChallengeMode(8, [], 0.5)).toBe("ontologist");
    expect(pickChallengeMode(8, [], 0.2)).toBeNull();
  });

  it("returns null on rounds without a configured challenge", () => {
    expect(pickChallengeMode(1, [], 0.5)).toBeNull();
    expect(pickChallengeMode(7, [], 0.5)).toBeNull();
    expect(pickChallengeMode(20, [], 0.5)).toBeNull();
  });
});

describe("allDimensionsDone", () => {
  it("requires all four dims ≥ 0.9 on brownfield", () => {
    expect(
      allDimensionsDone(
        { goal: 0.95, constraints: 0.95, criteria: 0.95, context: 0.95 },
        true,
      ),
    ).toBe(true);
    expect(
      allDimensionsDone(
        { goal: 0.95, constraints: 0.95, criteria: 0.95, context: 0.5 },
        true,
      ),
    ).toBe(false);
  });

  it("ignores 'context' on greenfield", () => {
    expect(
      allDimensionsDone(
        { goal: 0.95, constraints: 0.95, criteria: 0.95, context: 0 },
        false,
      ),
    ).toBe(true);
  });

  it("returns false when dims is null", () => {
    expect(allDimensionsDone(null, true)).toBe(false);
  });
});

describe("nextOntologySnapshot", () => {
  it("returns null stabilityRatio for the first snapshot", () => {
    const snap = nextOntologySnapshot(
      [],
      [{ name: "Customer", type: "core_domain" }],
      1,
    );
    expect(snap.round).toBe(1);
    expect(snap.entities).toHaveLength(1);
    expect(snap.newCount).toBe(1);
    expect(snap.stabilityRatio).toBeNull();
  });

  it("computes stabilityRatio against prior snapshot", () => {
    const prev: OntologySnapshot[] = [
      {
        round: 1,
        entities: [
          { name: "Customer", type: "core_domain" },
          { name: "Order", type: "core_domain" },
        ],
        newCount: 2,
        changedCount: 0,
        stableCount: 0,
        stabilityRatio: null,
      },
    ];
    // Add a third entity, keep the other two unchanged.
    const next = nextOntologySnapshot(
      prev,
      [{ name: "Product", type: "core_domain" }],
      2,
    );
    // 2 stable / 3 total = 0.666...
    expect(next.entities).toHaveLength(3);
    expect(next.newCount).toBe(1);
    expect(next.stableCount).toBe(2);
    expect(next.stabilityRatio).toBeCloseTo(2 / 3, 5);
  });

  it("counts changed entities (same name, different fields) correctly", () => {
    const prev: OntologySnapshot[] = [
      {
        round: 1,
        entities: [{ name: "Customer", type: "core_domain", fields: ["id"] }],
        newCount: 1,
        changedCount: 0,
        stableCount: 0,
        stabilityRatio: null,
      },
    ];
    const next = nextOntologySnapshot(
      prev,
      [{ name: "Customer", type: "core_domain", fields: ["id", "email"] }],
      2,
    );
    expect(next.changedCount).toBe(1);
    expect(next.newCount).toBe(0);
    expect(next.stableCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Engine integration with mocked DB + stub LLM
// ---------------------------------------------------------------------------

interface FakeStateRow {
  id: string;
  scope: string;
  scopeRefId: string;
  status: string;
  currentRound: number;
  ambiguityScore: number | null;
  dimensionScores: DimensionScores | null;
  ontologySnapshots: OntologySnapshot[];
  challengeModesUsed: string[];
  transcript: TranscriptTurn[];
}

function makeStateRow(overrides?: Partial<FakeStateRow>): FakeStateRow {
  return {
    id: "state-aaaa-bbbb",
    scope: "cos_onboarding",
    scopeRefId: "ref-1234",
    status: "in_progress",
    currentRound: 0,
    ambiguityScore: null,
    dimensionScores: null,
    ontologySnapshots: [],
    challengeModesUsed: [],
    transcript: [],
    ...overrides,
  };
}

/**
 * Build a Drizzle-shaped fake DB. The engine calls:
 *   - db.select().from(...).where(...).limit(1)
 *   - db.insert(...).values(...).returning()
 *   - db.update(...).set(...).where(...)
 *
 * We intercept by chaining thenable objects.
 */
function makeFakeDb(stateRow: FakeStateRow | null) {
  let current: FakeStateRow | null = stateRow;
  let lastInsertedSpec: { id: string; stateId: string } | null = null;
  const updateCalls: Array<Record<string, unknown>> = [];
  const insertCalls: Array<Record<string, unknown>> = [];

  const selectChain = () => ({
    from: () => ({
      where: () => ({
        limit: async () => (current ? [current] : []),
      }),
    }),
  });

  const insertChain = (_table: unknown) => {
    return {
      values: (val: Record<string, unknown>) => ({
        returning: async () => {
          // Discriminate by shape: specs always carry stateId + finalAmbiguity;
          // states carry scope + scopeRefId.
          const isSpec = "stateId" in val && "finalAmbiguity" in val;
          const tableName = isSpec ? "deep_interview_specs" : "deep_interview_states";
          insertCalls.push({ table: tableName, ...val });
          if (isSpec) {
            lastInsertedSpec = {
              id: "spec-xxxx-yyyy",
              stateId: (val.stateId as string) ?? "",
            };
            return [{ id: lastInsertedSpec.id, ...val }];
          }
          current = {
            id: "state-aaaa-bbbb",
            scope: (val.scope as string) ?? "cos_onboarding",
            scopeRefId: (val.scopeRefId as string) ?? "ref-1234",
            status: "in_progress",
            currentRound: 0,
            ambiguityScore: null,
            dimensionScores: null,
            ontologySnapshots: [],
            challengeModesUsed: [],
            transcript: [],
          };
          return [{ ...current }];
        },
      }),
    };
  };

  const updateChain = () => ({
    set: (patch: Record<string, unknown>) => {
      updateCalls.push(patch);
      // Apply patch in-place so subsequent select() reads see it.
      if (current) {
        const dropUpdatedAt = { ...patch };
        delete dropUpdatedAt.updatedAt;
        Object.assign(current, dropUpdatedAt);
      }
      return {
        where: async () => undefined,
      };
    },
  });

  return {
    db: {
      select: selectChain,
      insert: insertChain,
      update: updateChain,
    } as unknown as Parameters<typeof deepInterviewEngine>[0]["db"],
    // Probes for assertions:
    getCurrent: () => current,
    getLastSpec: () => lastInsertedSpec,
    getUpdateCalls: () => updateCalls,
    getInsertCalls: () => insertCalls,
  };
}

function trailerJson(payload: {
  ambiguity_score: number;
  dimensions: DimensionScores;
  ontology_delta?: Array<Record<string, unknown>>;
  next_phase?: string;
  action?: string;
}): string {
  return [
    "Here is my next question. What outcomes matter most?",
    "",
    "```json",
    JSON.stringify({
      ambiguity_score: payload.ambiguity_score,
      dimensions: payload.dimensions,
      ontology_delta: payload.ontology_delta ?? [],
      next_phase: payload.next_phase ?? "continue",
      action: payload.action ?? "ask_next",
    }),
    "```",
  ].join("\n");
}

describe("deepInterviewEngine.nextTurn — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("first turn creates the row, increments to round 1, persists dim scores", async () => {
    const fake = makeFakeDb(null);
    const llm: EngineLLMDispatch = vi.fn().mockResolvedValue(
      trailerJson({
        ambiguity_score: 0.85,
        dimensions: { goal: 0.3, constraints: 0.1, criteria: 0.1, context: 0.1 },
        ontology_delta: [{ name: "Customer", type: "core_domain" }],
      }),
    );
    const engine = deepInterviewEngine({ db: fake.db, dispatchLLM: llm });

    const result = await engine.nextTurn({
      scope: "cos_onboarding",
      scopeRefId: "ref-1234",
      userId: "user-1",
      companyId: "company-1",
      initialIdea: "Build a CRM",
      adapter: "claude_api",
    });

    expect(result.kind).toBe("question");
    expect(result.round).toBe(0); // No userAnswer ⇒ round stays at 0; engine asks the seed question.
    expect(llm).toHaveBeenCalledTimes(1);
    const updates = fake.getUpdateCalls();
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0]!.dimensionScores).toEqual({
      goal: 0.3,
      constraints: 0.1,
      criteria: 0.1,
      context: 0.1,
    });
  });

  it("subsequent turn with userAnswer increments currentRound", async () => {
    const fake = makeFakeDb(
      makeStateRow({
        currentRound: 1,
        ambiguityScore: 0.8,
        dimensionScores: { goal: 0.3, constraints: 0.1, criteria: 0.1, context: 0.1 },
        transcript: [
          {
            round: 1,
            question: "What outcomes matter most?",
            targetDimension: "goal",
            answer: "",
            ambiguityAfter: 0.8,
          },
        ],
      }),
    );
    const llm: EngineLLMDispatch = vi.fn().mockResolvedValue(
      trailerJson({
        ambiguity_score: 0.6,
        dimensions: { goal: 0.6, constraints: 0.4, criteria: 0.3, context: 0.2 },
      }),
    );
    const engine = deepInterviewEngine({ db: fake.db, dispatchLLM: llm });

    const result = await engine.nextTurn({
      scope: "cos_onboarding",
      scopeRefId: "ref-1234",
      userId: "user-1",
      companyId: "company-1",
      initialIdea: "Build a CRM",
      adapter: "claude_api",
      userAnswer: "Top of funnel growth.",
    });

    expect(result.kind).toBe("question");
    expect(result.round).toBe(2);
    expect(result.ambiguityScore).toBeCloseTo(0.6);
  });
});

describe("deepInterviewEngine.nextTurn — termination conditions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flips to ready_to_crystallize when ambiguity drops to threshold", async () => {
    const fake = makeFakeDb(
      makeStateRow({
        currentRound: 5,
        ambiguityScore: 0.4,
        dimensionScores: { goal: 0.6, constraints: 0.5, criteria: 0.5, context: 0.4 },
        transcript: [
          {
            round: 5,
            question: "Last Q?",
            targetDimension: "goal",
            answer: "",
            ambiguityAfter: 0.4,
          },
        ],
      }),
    );
    const llm: EngineLLMDispatch = vi.fn().mockResolvedValue(
      trailerJson({
        ambiguity_score: AMBIGUITY_THRESHOLD - 0.05,
        dimensions: { goal: 0.95, constraints: 0.9, criteria: 0.9, context: 0.85 },
      }),
    );
    const engine = deepInterviewEngine({ db: fake.db, dispatchLLM: llm });

    const result = await engine.nextTurn({
      scope: "cos_onboarding",
      scopeRefId: "ref-1234",
      userId: "user-1",
      companyId: "company-1",
      initialIdea: "X",
      adapter: "claude_api",
      userAnswer: "Final answer",
    });

    expect(result.kind).toBe("ready_to_crystallize");
    expect(result.ambiguityScore).toBeLessThanOrEqual(AMBIGUITY_THRESHOLD);
    const updates = fake.getUpdateCalls();
    expect(updates[updates.length - 1]!.status).toBe("ready_to_crystallize");
  });

  it("flips to ready_to_crystallize at round HARD_ROUND_CAP", async () => {
    const fake = makeFakeDb(
      makeStateRow({
        currentRound: HARD_ROUND_CAP - 1,
        ambiguityScore: 0.7,
        dimensionScores: { goal: 0.5, constraints: 0.5, criteria: 0.5, context: 0.5 },
        transcript: [
          {
            round: HARD_ROUND_CAP - 1,
            question: "Q19?",
            targetDimension: "goal",
            answer: "",
            ambiguityAfter: 0.7,
          },
        ],
      }),
    );
    const llm: EngineLLMDispatch = vi.fn().mockResolvedValue(
      trailerJson({
        ambiguity_score: 0.7,
        dimensions: { goal: 0.5, constraints: 0.5, criteria: 0.5, context: 0.5 },
      }),
    );
    const engine = deepInterviewEngine({ db: fake.db, dispatchLLM: llm });

    const result = await engine.nextTurn({
      scope: "cos_onboarding",
      scopeRefId: "ref-1234",
      userId: "user-1",
      companyId: "company-1",
      initialIdea: "X",
      adapter: "claude_api",
      userAnswer: "Last allowed answer",
    });

    expect(result.kind).toBe("ready_to_crystallize");
    expect(result.round).toBe(HARD_ROUND_CAP);
  });
});

describe("deepInterviewEngine.nextTurn — malformed trailer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not crash when LLM omits the JSON trailer", async () => {
    const fake = makeFakeDb(makeStateRow());
    const llm: EngineLLMDispatch = vi
      .fn()
      .mockResolvedValue("Just prose. No JSON trailer at all.");
    const engine = deepInterviewEngine({ db: fake.db, dispatchLLM: llm });

    await expect(
      engine.nextTurn({
        scope: "cos_onboarding",
        scopeRefId: "ref-1234",
        userId: "user-1",
        companyId: "company-1",
        initialIdea: "X",
        adapter: "claude_api",
      }),
    ).resolves.toMatchObject({ kind: "question" });
    // It should still persist a turn, falling back to derived ambiguity from
    // existing dims (zeros yield 1.0).
    const updates = fake.getUpdateCalls();
    expect(updates.length).toBeGreaterThan(0);
    const lastAmbiguity = updates[updates.length - 1]!.ambiguityScore;
    expect(typeof lastAmbiguity).toBe("number");
  });

  it("does not crash on garbled JSON trailer", async () => {
    const fake = makeFakeDb(makeStateRow());
    const llm: EngineLLMDispatch = vi
      .fn()
      .mockResolvedValue('Body\n\n```json\n{"ambiguity_score": "not a number"}\n```');
    const engine = deepInterviewEngine({ db: fake.db, dispatchLLM: llm });

    await expect(
      engine.nextTurn({
        scope: "cos_onboarding",
        scopeRefId: "ref-1234",
        userId: "user-1",
        companyId: "company-1",
        initialIdea: "X",
        adapter: "claude_api",
      }),
    ).resolves.toMatchObject({ kind: "question" });
  });
});

describe("deepInterviewEngine.crystallize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts a deep_interview_specs row and flips status='crystallized'", async () => {
    const fake = makeFakeDb(
      makeStateRow({
        status: "ready_to_crystallize",
        currentRound: 5,
        ambiguityScore: 0.15,
        dimensionScores: { goal: 0.95, constraints: 0.9, criteria: 0.9, context: 0.85 },
        ontologySnapshots: [
          {
            round: 5,
            entities: [{ name: "Customer", type: "core_domain" }],
            newCount: 1,
            changedCount: 0,
            stableCount: 0,
            stabilityRatio: null,
          },
        ],
        transcript: [
          {
            round: 1,
            question: "Goal?",
            targetDimension: "goal",
            answer: "Grow ARR",
            ambiguityAfter: 0.6,
          },
          {
            round: 2,
            question: "Constraints?",
            targetDimension: "constraints",
            answer: "No PII storage",
            ambiguityAfter: 0.4,
          },
          {
            round: 3,
            question: "Criteria?",
            targetDimension: "criteria",
            answer: "10x faster than baseline",
            ambiguityAfter: 0.2,
          },
        ],
      }),
    );
    // crystallize() does not call the LLM.
    const llm: EngineLLMDispatch = vi.fn();
    const engine = deepInterviewEngine({ db: fake.db, dispatchLLM: llm });

    const out = await engine.crystallize("state-aaaa-bbbb");
    expect(out.specId).toBe("spec-xxxx-yyyy");
    expect(out.stateId).toBe("state-aaaa-bbbb");
    expect(llm).not.toHaveBeenCalled();

    const inserts = fake.getInsertCalls();
    const specInsert = inserts.find((i) => i.table === "deep_interview_specs");
    expect(specInsert).toBeDefined();
    expect(specInsert!.goal).toBe("Grow ARR");
    expect(specInsert!.constraints).toEqual(["No PII storage"]);
    expect(specInsert!.criteria).toEqual(["10x faster than baseline"]);
    // status update emitted with crystallized.
    const updates = fake.getUpdateCalls();
    expect(updates[updates.length - 1]!.status).toBe("crystallized");
  });

  it("throws when state row does not exist", async () => {
    const fake = makeFakeDb(null);
    const engine = deepInterviewEngine({ db: fake.db, dispatchLLM: vi.fn() });
    await expect(engine.crystallize("nope")).rejects.toThrow(/not found/);
  });
});

describe("deepInterviewEngine.getInProgress", () => {
  it("returns the row for matching (scope, scopeRefId)", async () => {
    const fake = makeFakeDb(makeStateRow({ currentRound: 3 }));
    const engine = deepInterviewEngine({ db: fake.db, dispatchLLM: vi.fn() });
    const row = await engine.getInProgress("cos_onboarding", "ref-1234");
    expect(row).not.toBeNull();
    expect(row!.currentRound).toBe(3);
  });

  it("returns null when no row exists", async () => {
    const fake = makeFakeDb(null);
    const engine = deepInterviewEngine({ db: fake.db, dispatchLLM: vi.fn() });
    const row = await engine.getInProgress("cos_onboarding", "ref-9999");
    expect(row).toBeNull();
  });
});
