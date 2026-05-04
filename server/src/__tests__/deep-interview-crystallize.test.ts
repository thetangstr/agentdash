// AgentDash (Phase F): unit tests for crystallizeAndAdvanceCos.
//
// Mocks Drizzle's transaction + chain calls at the call-site shape. The
// helper does:
//   tx.select().from().where().for("update")        — lock state row
//   tx.select().from().where().limit(1)             — look up prior spec
//                                                       (idempotent branch)
//   tx.insert(specsTable).values(...).returning()   — write new spec
//   tx.update(statesTable).set(...).where(...)      — flip status
//   tx.update(cosTable).set(...).where(...)         — advance CoS phase
//                                                       (cos_onboarding scope)
//
// We don't stand up an embedded postgres for these. We assert the writes
// happen in the right order and that idempotency is rock-solid: a second
// call on a `crystallized` state must not insert again.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { crystallizeAndAdvanceCos } from "../services/deep-interview-crystallize.js";
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

interface FakeStateRow {
  id: string;
  scope: "cos_onboarding" | "assess_project";
  scopeRefId: string;
  status: "in_progress" | "ready_to_crystallize" | "crystallized" | "abandoned";
  ambiguityScore: number | null;
  dimensionScores: DimensionScores | null;
  ontologySnapshots: OntologySnapshot[];
  transcript: TranscriptTurn[];
}

interface FakeSpecRow {
  id: string;
  stateId: string;
}

interface UpdateRecord {
  table: "deep_interview_states" | "cos_onboarding_states";
  patch: Record<string, unknown>;
}

interface InsertRecord {
  table: "deep_interview_specs";
  values: Record<string, unknown>;
  returnedId: string;
}

function makeStateRow(overrides?: Partial<FakeStateRow>): FakeStateRow {
  return {
    id: "state-aaaa-bbbb",
    scope: "cos_onboarding",
    scopeRefId: "conv-1234",
    status: "ready_to_crystallize",
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
      { round: 1, question: "Goal?", targetDimension: "goal", answer: "Grow ARR", ambiguityAfter: 0.6 },
      { round: 2, question: "Constraints?", targetDimension: "constraints", answer: "No PII storage", ambiguityAfter: 0.4 },
      { round: 3, question: "Criteria?", targetDimension: "criteria", answer: "10x faster than baseline", ambiguityAfter: 0.2 },
    ],
    ...overrides,
  };
}

function makeFakeDb(args: {
  stateRow: FakeStateRow | null;
  priorSpecRow?: FakeSpecRow | null;
  insertedSpecId?: string;
}) {
  const inserts: InsertRecord[] = [];
  const updates: UpdateRecord[] = [];
  let mutableState = args.stateRow ? { ...args.stateRow } : null;
  const insertedSpecId = args.insertedSpecId ?? "spec-xxxx-yyyy";

  // Track which select chain the helper is about to walk: state lookup uses
  // `.for("update")`, prior-spec lookup uses `.limit(1)`. We branch on the
  // terminal call to return the right rows.
  const buildSelect = () => ({
    from: (_table: unknown) => ({
      where: (_predicate: unknown) => ({
        for: async (_mode: string) =>
          mutableState ? [{ ...mutableState }] : [],
        limit: async (_n: number) =>
          args.priorSpecRow ? [{ ...args.priorSpecRow }] : [],
      }),
    }),
  });

  const buildInsert = (_table: unknown) => ({
    values: (val: Record<string, unknown>) => ({
      returning: async () => {
        inserts.push({
          table: "deep_interview_specs",
          values: val,
          returnedId: insertedSpecId,
        });
        return [{ id: insertedSpecId, ...val }];
      },
    }),
  });

  // Drizzle's table objects expose `Symbol.for("drizzle:Name")` etc. We can't
  // rely on those in unit-land, so we differentiate writes by the patch shape
  // (status change vs phase change) instead of the table object.
  const buildUpdate = (_table: unknown) => ({
    set: (patch: Record<string, unknown>) => ({
      where: async (_predicate: unknown) => {
        const isStateFlip = "status" in patch;
        const tableName: UpdateRecord["table"] = isStateFlip
          ? "deep_interview_states"
          : "cos_onboarding_states";
        updates.push({ table: tableName, patch });
        if (isStateFlip && mutableState) {
          const nextStatus = patch.status as FakeStateRow["status"];
          mutableState = { ...mutableState, status: nextStatus };
        }
      },
    }),
  });

  const tx = {
    select: buildSelect,
    insert: buildInsert,
    update: buildUpdate,
  };

  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as Parameters<typeof crystallizeAndAdvanceCos>[0]["db"];

  return {
    db,
    inserts,
    updates,
    getMutableState: () => mutableState,
  };
}

describe("crystallizeAndAdvanceCos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts a spec, flips state status, and advances CoS phase (cos_onboarding scope)", async () => {
    const fake = makeFakeDb({ stateRow: makeStateRow() });
    const helper = crystallizeAndAdvanceCos({ db: fake.db });

    const result = await helper("state-aaaa-bbbb");

    expect(result.specId).toBe("spec-xxxx-yyyy");
    expect(result.conversationId).toBe("conv-1234");

    // Spec insert happened with goal/constraints/criteria pulled from the transcript.
    expect(fake.inserts).toHaveLength(1);
    const insert = fake.inserts[0]!;
    expect(insert.values.goal).toBe("Grow ARR");
    expect(insert.values.constraints).toEqual(["No PII storage"]);
    expect(insert.values.criteria).toEqual(["10x faster than baseline"]);
    expect(insert.values.finalAmbiguity).toBeCloseTo(0.15, 5);

    // Two updates: deep_interview_states.status='crystallized', cos_onboarding_states.phase='plan'.
    const stateUpdate = fake.updates.find((u) => u.table === "deep_interview_states");
    const cosUpdate = fake.updates.find((u) => u.table === "cos_onboarding_states");
    expect(stateUpdate?.patch.status).toBe("crystallized");
    expect(cosUpdate?.patch.phase).toBe("plan");
    expect(cosUpdate?.patch.deepInterviewSpecId).toBe("spec-xxxx-yyyy");
  });

  it("is idempotent: a second call on a crystallized state returns the prior spec without inserting", async () => {
    // Pretend the first crystallize already ran: status is "crystallized" and a
    // spec row already exists. The helper should early-return that prior spec.
    const fake = makeFakeDb({
      stateRow: makeStateRow({ status: "crystallized" }),
      priorSpecRow: { id: "spec-prior-zzzz", stateId: "state-aaaa-bbbb" },
    });
    const helper = crystallizeAndAdvanceCos({ db: fake.db });

    const result = await helper("state-aaaa-bbbb");

    expect(result.specId).toBe("spec-prior-zzzz");
    expect(result.conversationId).toBe("conv-1234");
    expect(fake.inserts).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });

  it("throws when the state row is not found", async () => {
    const fake = makeFakeDb({ stateRow: null });
    const helper = crystallizeAndAdvanceCos({ db: fake.db });

    await expect(helper("nope")).rejects.toThrow(/not found/);
    expect(fake.inserts).toHaveLength(0);
  });

  it("throws when status=crystallized but no spec row exists (hard inconsistency)", async () => {
    const fake = makeFakeDb({
      stateRow: makeStateRow({ status: "crystallized" }),
      priorSpecRow: null,
    });
    const helper = crystallizeAndAdvanceCos({ db: fake.db });

    await expect(helper("state-aaaa-bbbb")).rejects.toThrow(/no spec row exists/);
  });

  it("does NOT advance CoS phase for assess_project scope", async () => {
    const fake = makeFakeDb({
      stateRow: makeStateRow({ scope: "assess_project", scopeRefId: "company:Project Alpha" }),
    });
    const helper = crystallizeAndAdvanceCos({ db: fake.db });

    const result = await helper("state-aaaa-bbbb");

    expect(result.specId).toBe("spec-xxxx-yyyy");
    // Spec inserted + state flipped, but no cos_onboarding_states update.
    expect(fake.inserts).toHaveLength(1);
    expect(fake.updates.find((u) => u.table === "cos_onboarding_states")).toBeUndefined();
    expect(fake.updates.find((u) => u.table === "deep_interview_states")?.patch.status).toBe(
      "crystallized",
    );
  });
});
