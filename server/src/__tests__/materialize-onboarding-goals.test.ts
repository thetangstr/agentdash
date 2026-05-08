// AgentDash (issue #174): unit tests for the materializeOnboardingGoals
// service helper. Mirrors the mock-DB style used by verdicts.test.ts so we
// don't need an embedded postgres for these shape-level assertions.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

import {
  materializeOnboardingGoals,
  OnboardingStateNotFoundError,
} from "../services/materialize-onboarding-goals.ts";

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
  publishPluginDomainEvent: vi.fn(),
}));

interface OnboardingStateFixture {
  conversationId: string;
  goals: { shortTerm?: string; longTerm?: string };
}

interface GoalRow {
  id: string;
  companyId: string;
  ownerAgentId: string | null;
  title: string;
  level: string;
  status: string;
  parentId: string | null;
  metricDefinition: unknown;
}

interface DbStubOptions {
  state?: OnboardingStateFixture | null;
  existingGoals?: GoalRow[];
}

/**
 * Lightweight stub mimicking the drizzle query chain used inside the
 * transaction. The first `.select()` returns the cos_onboarding_states row;
 * the second returns the existing goals (idempotency lookup). Inserts are
 * recorded and synthesize an id for `.returning()`.
 */
function makeDb(opts: DbStubOptions = {}) {
  const insertedGoals: GoalRow[] = [];
  // Pre-seed `existingGoals` so the idempotency lookup can find them.
  const goalStore: GoalRow[] = [...(opts.existingGoals ?? [])];

  let selectCallCount = 0;

  const select = vi.fn(() => {
    selectCallCount += 1;
    const callIdx = selectCallCount;
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      // Call 1: cos_onboarding_states lookup.
      // Call 2+: existing goals lookup for idempotency.
      let rows: unknown[] = [];
      if (callIdx === 1) {
        rows = opts.state ? [opts.state] : [];
      } else {
        rows = goalStore;
      }
      return Promise.resolve(rows).then(resolve, reject);
    };
    return chain;
  });

  const insertReturning = vi.fn(async () => {
    const last = insertedGoals[insertedGoals.length - 1];
    return last ? [last] : [];
  });
  const insertValues = vi.fn((values: Partial<GoalRow>) => {
    const row: GoalRow = {
      id: randomUUID(),
      companyId: values.companyId!,
      ownerAgentId: values.ownerAgentId ?? null,
      title: values.title!,
      level: values.level ?? "task",
      status: values.status ?? "planned",
      parentId: values.parentId ?? null,
      metricDefinition: values.metricDefinition ?? null,
    };
    insertedGoals.push(row);
    goalStore.push(row);
    return { returning: insertReturning };
  });

  const db = {
    select,
    insert: vi.fn(() => ({ values: insertValues })),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };

  return { db, insertedGoals };
}

const COMPANY_ID = "11111111-1111-1111-1111-111111111111";
const COS_AGENT_ID = "22222222-2222-2222-2222-222222222222";
const CONVERSATION_ID = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  mockLogActivity.mockClear();
});

describe("materializeOnboardingGoals", () => {
  it("creates parent + child goals when both shortTerm and longTerm are present", async () => {
    const { db, insertedGoals } = makeDb({
      state: {
        conversationId: CONVERSATION_ID,
        goals: {
          shortTerm: "ship v2 by Q3",
          longTerm: "self-running ops org by next year",
        },
      },
    });

    const result = await materializeOnboardingGoals({ db: db as any })({
      conversationId: CONVERSATION_ID,
      companyId: COMPANY_ID,
      ownerAgentId: COS_AGENT_ID,
    });

    expect(result.alreadyMaterialized).toBe(false);
    expect(result.longTermGoalId).toBeTruthy();
    expect(result.shortTermGoalId).toBeTruthy();
    expect(insertedGoals).toHaveLength(2);

    // Long-term inserted first as company-level top-level goal.
    expect(insertedGoals[0]).toMatchObject({
      title: "self-running ops org by next year",
      level: "company",
      status: "planned",
      parentId: null,
      ownerAgentId: COS_AGENT_ID,
      companyId: COMPANY_ID,
    });
    // Short-term parented to the long-term goal.
    expect(insertedGoals[1]).toMatchObject({
      title: "ship v2 by Q3",
      level: "task",
      status: "planned",
      parentId: insertedGoals[0]!.id,
      ownerAgentId: COS_AGENT_ID,
    });

    // Activity log: one per created goal.
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
    expect(mockLogActivity.mock.calls[0]![1]).toMatchObject({
      action: "goal_created_from_onboarding",
      entityType: "goal",
      entityId: insertedGoals[0]!.id,
      actorType: "agent",
      actorId: COS_AGENT_ID,
      details: {
        conversationId: CONVERSATION_ID,
        source: "cos_onboarding",
        originalText: "self-running ops org by next year",
        horizon: "long_term",
      },
    });
    expect(mockLogActivity.mock.calls[1]![1]).toMatchObject({
      action: "goal_created_from_onboarding",
      entityId: insertedGoals[1]!.id,
      details: {
        conversationId: CONVERSATION_ID,
        source: "cos_onboarding",
        horizon: "short_term",
        parentGoalId: insertedGoals[0]!.id,
      },
    });
  });

  it("creates only a long-term goal when shortTerm is absent", async () => {
    const { db, insertedGoals } = makeDb({
      state: {
        conversationId: CONVERSATION_ID,
        goals: { longTerm: "build the best agent platform" },
      },
    });

    const result = await materializeOnboardingGoals({ db: db as any })({
      conversationId: CONVERSATION_ID,
      companyId: COMPANY_ID,
      ownerAgentId: COS_AGENT_ID,
    });

    expect(result.longTermGoalId).toBeTruthy();
    expect(result.shortTermGoalId).toBeNull();
    expect(insertedGoals).toHaveLength(1);
    expect(insertedGoals[0]).toMatchObject({
      title: "build the best agent platform",
      level: "company",
      parentId: null,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });

  it("creates only a top-level short-term goal when longTerm is absent", async () => {
    const { db, insertedGoals } = makeDb({
      state: {
        conversationId: CONVERSATION_ID,
        goals: { shortTerm: "set up onboarding flow" },
      },
    });

    const result = await materializeOnboardingGoals({ db: db as any })({
      conversationId: CONVERSATION_ID,
      companyId: COMPANY_ID,
      ownerAgentId: COS_AGENT_ID,
    });

    expect(result.longTermGoalId).toBeNull();
    expect(result.shortTermGoalId).toBeTruthy();
    expect(insertedGoals).toHaveLength(1);
    expect(insertedGoals[0]).toMatchObject({
      title: "set up onboarding flow",
      level: "task",
      parentId: null, // no long-term parent → top-level
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });

  it("returns no-op result when both shortTerm and longTerm are absent", async () => {
    const { db, insertedGoals } = makeDb({
      state: { conversationId: CONVERSATION_ID, goals: {} },
    });

    const result = await materializeOnboardingGoals({ db: db as any })({
      conversationId: CONVERSATION_ID,
      companyId: COMPANY_ID,
      ownerAgentId: COS_AGENT_ID,
    });

    expect(result).toEqual({
      longTermGoalId: null,
      shortTermGoalId: null,
      alreadyMaterialized: false,
    });
    expect(insertedGoals).toHaveLength(0);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("idempotent: a second call with the same input returns the existing ids without inserting", async () => {
    const longGoalId = randomUUID();
    const shortGoalId = randomUUID();
    const { db, insertedGoals } = makeDb({
      state: {
        conversationId: CONVERSATION_ID,
        goals: {
          shortTerm: "ship v2 by Q3",
          longTerm: "self-running ops org",
        },
      },
      existingGoals: [
        {
          id: longGoalId,
          companyId: COMPANY_ID,
          ownerAgentId: COS_AGENT_ID,
          title: "self-running ops org",
          level: "company",
          status: "planned",
          parentId: null,
          metricDefinition: null,
        },
        {
          id: shortGoalId,
          companyId: COMPANY_ID,
          ownerAgentId: COS_AGENT_ID,
          title: "ship v2 by Q3",
          level: "task",
          status: "planned",
          parentId: longGoalId,
          metricDefinition: null,
        },
      ],
    });

    const result = await materializeOnboardingGoals({ db: db as any })({
      conversationId: CONVERSATION_ID,
      companyId: COMPANY_ID,
      ownerAgentId: COS_AGENT_ID,
    });

    expect(result).toEqual({
      longTermGoalId: longGoalId,
      shortTermGoalId: shortGoalId,
      alreadyMaterialized: true,
    });
    expect(insertedGoals).toHaveLength(0);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("throws OnboardingStateNotFoundError when no cos_onboarding_states row exists", async () => {
    const { db } = makeDb({ state: null });

    await expect(
      materializeOnboardingGoals({ db: db as any })({
        conversationId: CONVERSATION_ID,
        companyId: COMPANY_ID,
        ownerAgentId: COS_AGENT_ID,
      }),
    ).rejects.toBeInstanceOf(OnboardingStateNotFoundError);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("writes an activity_log row for each created goal with conversationId in details", async () => {
    const { db, insertedGoals } = makeDb({
      state: {
        conversationId: CONVERSATION_ID,
        goals: {
          shortTerm: "validate first 10 customers",
          longTerm: "$1M ARR by year-end",
        },
      },
    });

    await materializeOnboardingGoals({ db: db as any })({
      conversationId: CONVERSATION_ID,
      companyId: COMPANY_ID,
      ownerAgentId: COS_AGENT_ID,
    });

    expect(mockLogActivity).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      expect(mockLogActivity.mock.calls[i]![1]).toMatchObject({
        companyId: COMPANY_ID,
        actorType: "agent",
        actorId: COS_AGENT_ID,
        action: "goal_created_from_onboarding",
        entityType: "goal",
        entityId: insertedGoals[i]!.id,
        agentId: COS_AGENT_ID,
        details: expect.objectContaining({
          conversationId: CONVERSATION_ID,
          source: "cos_onboarding",
        }),
      });
    }
  });
});
