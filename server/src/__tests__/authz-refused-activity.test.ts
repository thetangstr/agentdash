// AGE-91 — authority refusals leave a record.
//
// Pattern: mock-DB style. The REAL `logAuthzRefusal`/`logActivity` chain runs;
// only `instance-settings` is stubbed (logActivity consults it for username
// redaction). Every insert is captured off the DB stub, so assertions run
// against the actual `activity_log` row shape — no module mocking pitfalls.
//
// The three issue scenarios:
//   1. agent key attempting a self-review verdict -> 409 unchanged + one
//      authz.refused row with reasonCode NEUTRAL_VALIDATOR_VIOLATION
//   2. agent calling a direction-setting route guard -> 403 unchanged + one row
//   3. unauthenticated request -> no row at all
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: async () => ({ censorUsernameInLogs: false }),
  }),
}));

import { HttpError } from "../errors.js";
import {
  assertAuthenticated,
  assertBoard,
  assertCanSetCompanyDirection,
  assertCompanyAccess,
  setAuthzRefusalDb,
} from "../routes/authz.js";
import { logAuthzRefusal } from "../services/activity-log.js";
import { verdictsService } from "../services/verdicts.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-4444-444444444444";

type AnyActor = NonNullable<Express.Request["actor"]>;

function makeReq(input: { method?: string; url?: string; actor: AnyActor }): Request {
  return {
    method: input.method ?? "POST",
    url: input.url ?? "/api/x",
    originalUrl: input.url ?? "/api/x",
    actor: input.actor,
  } as unknown as Request;
}

function agentReq(overrides: Partial<AnyActor> = {}): Request {
  return makeReq({
    actor: {
      type: "agent",
      agentId: AGENT_ID,
      companyId: COMPANY_ID,
      runId: undefined,
      source: "agent_key",
      ...overrides,
    },
  });
}

/** Invoke once, return the thrown error (or fail if nothing threw). */
function catchThrown(fn: () => void): HttpError {
  try {
    fn();
  } catch (err) {
    return err as HttpError;
  }
  throw new Error("expected guard to throw");
}

/** Flush fire-and-forget refusal logging before asserting on rows. */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setTimeout(r, 15));
}

describe("AGE-91 scenario 1 — agent self-review verdict is 409 + one authz.refused row", () => {
  it("keeps the 409 and records one authz.refused row with NEUTRAL_VALIDATOR_VIOLATION", async () => {
    const { db, queueSelect, activityRows } = makeVerdictDb();
    queueSelect([
      {
        id: ISSUE_ID,
        companyId: COMPANY_ID,
        assigneeAgentId: AGENT_ID, // the reviewer IS the assignee
        assigneeUserId: null,
      },
    ]);

    const svc = verdictsService(db as never);
    const err = await svc
      .create(
        {
          companyId: COMPANY_ID,
          entityType: "issue",
          issueId: ISSUE_ID,
          reviewerAgentId: AGENT_ID,
          outcome: "passed",
        },
        { req: agentReq() },
      )
      .then(
        () => null,
        (e) => e as HttpError,
      );

    // Response unchanged: same 409, same message, same details envelope as
    // pre-AGE-91.
    expect(err).toBeInstanceOf(HttpError);
    expect(err!.status).toBe(409);
    expect(err!.message).toBe("reviewer must not be the assignee");
    expect(err!.details).toEqual({ code: "NEUTRAL_VALIDATOR_VIOLATION" });

    // Exactly one row written — the refusal — attributed to the agent.
    await vi.waitFor(() => expect(activityRows).toHaveLength(1));
    expect(activityRows[0]).toMatchObject({
      companyId: COMPANY_ID,
      actorType: "agent",
      actorId: AGENT_ID,
      agentId: AGENT_ID,
      action: "authz.refused",
      entityType: "issue",
      entityId: ISSUE_ID,
      runId: null,
    });
    expect(activityRows[0]!.details).toEqual({
      method: "POST",
      routePath: "/api/x",
      reasonCode: "NEUTRAL_VALIDATOR_VIOLATION",
    });
  });

  it("stays silent on the refusal channel when the verdict is allowed", async () => {
    const { db, queueSelect, activityRows } = makeVerdictDb();
    queueSelect([
      { id: ISSUE_ID, companyId: COMPANY_ID, assigneeAgentId: null, assigneeUserId: null },
    ]);

    const svc = verdictsService(db as never);
    const verdict = await svc.create(
      {
        companyId: COMPANY_ID,
        entityType: "issue",
        issueId: ISSUE_ID,
        reviewerAgentId: "55555555-5555-4555-8555-555555555555",
        outcome: "passed",
      },
      { req: agentReq() },
    );
    expect(verdict.outcome).toBe("passed");
    await flushAsync();
    // Only the success-path verdict_recorded activity — no authz.refused.
    expect(
      activityRows.filter((r) => r.action === "authz.refused"),
    ).toHaveLength(0);
  });
});

describe("AGE-91 scenario 2 — agent calling a direction-setting route is 403 + one row", () => {
  it("assertCanSetCompanyDirection keeps the 403 and records AGENT_DIRECTION_FORBIDDEN", async () => {
    const { db, activityRows } = makeVerdictDb();
    setAuthzRefusalDb(db as never);
    const req = agentReq();
    req.method = "PATCH";

    const err = catchThrown(() => assertCanSetCompanyDirection(req, COMPANY_ID));
    // Status/body unchanged from pre-AGE-91:
    expect(err.status).toBe(403);
    expect(err.message).toBe(
      "Agents cannot change company direction. Ask an owner or admin to change the goal.",
    );
    expect(err.details).toBeUndefined();

    await vi.waitFor(() => expect(activityRows).toHaveLength(1));
    expect(activityRows[0]).toMatchObject({
      companyId: COMPANY_ID,
      actorType: "agent",
      actorId: AGENT_ID,
      agentId: AGENT_ID,
      action: "authz.refused",
      entityType: "company",
      entityId: COMPANY_ID,
    });
    expect(activityRows[0]!.details).toEqual({
      method: "PATCH",
      routePath: "/api/x",
      reasonCode: "AGENT_DIRECTION_FORBIDDEN",
    });
  });

  it("cross-company agent on a plain company route is 403 + AGENT_CROSS_COMPANY", async () => {
    const { db, activityRows } = makeVerdictDb();
    setAuthzRefusalDb(db as never);

    const err = catchThrown(() => assertCompanyAccess(agentReq({ companyId: OTHER_COMPANY_ID }), COMPANY_ID));
    expect(err.status).toBe(403);
    expect(err.message).toBe("Agent key cannot access another company");

    await vi.waitFor(() => expect(activityRows).toHaveLength(1));
    expect(activityRows[0]!.details).toMatchObject({ reasonCode: "AGENT_CROSS_COMPANY" });
    expect(activityRows[0]).toMatchObject({ entityType: "company", entityId: COMPANY_ID });
  });
});

describe("AGE-91 scenario 3 — unauthenticated requests are never logged", () => {
  it("anonymous 401 produces no refusal row", async () => {
    const { db, activityRows } = makeVerdictDb();
    setAuthzRefusalDb(db as never);

    const err = catchThrown(() => assertAuthenticated(makeReq({ actor: { type: "none" } })));
    expect(err.status).toBe(401);
    expect(err.message).toBe("Unauthorized");

    await flushAsync();
    expect(activityRows).toHaveLength(0);
  });

  it("an unauthenticated self-review attempt is still 409 but writes no row", async () => {
    const { db, queueSelect, activityRows } = makeVerdictDb();
    queueSelect([
      { id: ISSUE_ID, companyId: COMPANY_ID, assigneeAgentId: AGENT_ID, assigneeUserId: null },
    ]);

    const svc = verdictsService(db as never);
    const err = await svc
      .create(
        {
          companyId: COMPANY_ID,
          entityType: "issue",
          issueId: ISSUE_ID,
          reviewerAgentId: AGENT_ID,
          outcome: "passed",
        },
        { req: makeReq({ actor: { type: "none" } }) },
      )
      .then(
        () => null,
        (e) => e as HttpError,
      );
    expect(err!.status).toBe(409); // refusal still refused…
    await flushAsync();
    expect(activityRows).toHaveLength(0); // …but an anonymous actor leaves no record
  });

  it("logAuthzRefusal skips none-actors and actors with no derivable company", async () => {
    const { db, activityRows } = makeVerdictDb();

    await expect(
      logAuthzRefusal(db as never, {
        req: makeReq({ actor: { type: "none" } }),
        companyId: COMPANY_ID,
        entityType: "company",
        entityId: COMPANY_ID,
        reasonCode: "COMPANY_ACCESS_DENIED",
      }),
    ).resolves.toBeUndefined();
    expect(activityRows).toHaveLength(0);

    // No company scope derivable from request or actor -> skipped, not crashed.
    await expect(
      logAuthzRefusal(db as never, {
        req: makeReq({ actor: { type: "board", source: "session", userId: "u1" } }),
        companyId: null,
        entityType: "instance",
        entityId: null,
        reasonCode: "BOARD_ACCESS_REQUIRED",
      }),
    ).resolves.toBeUndefined();
    expect(activityRows).toHaveLength(0);
  });

  it("logAuthzRefusal swallows insert failures (the 403/409 would be unaffected)", async () => {
    const failingDb = {
      insert: vi.fn(() => {
        throw new Error("db down");
      }),
    };
    await expect(
      logAuthzRefusal(failingDb as never, {
        req: agentReq(),
        companyId: COMPANY_ID,
        entityType: "company",
        entityId: COMPANY_ID,
        reasonCode: "COMPANY_ACCESS_DENIED",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("AGE-91 — wiring and non-goals", () => {
  it("guards stay silent when no db is wired (pre-AGE-91 behavior intact)", async () => {
    setAuthzRefusalDb(null);
    const err = catchThrown(() => assertCanSetCompanyDirection(agentReq(), COMPANY_ID));
    expect(err.status).toBe(403); // still refused
    const { activityRows } = makeVerdictDb(); // nothing to observe anyway
    await flushAsync();
    expect(activityRows).toHaveLength(0);
  });

  it("assertBoard refusal for an agent carries BOARD_ACCESS_REQUIRED", async () => {
    const { db, activityRows } = makeVerdictDb();
    setAuthzRefusalDb(db as never);

    const err = catchThrown(() => assertBoard(agentReq()));
    expect(err.status).toBe(403);
    expect(err.message).toBe("Board access required");

    await vi.waitFor(() => expect(activityRows).toHaveLength(1));
    expect(activityRows[0]!.details).toMatchObject({ reasonCode: "BOARD_ACCESS_REQUIRED" });
  });

  it("details never include the request body", async () => {
    const { db, activityRows } = makeVerdictDb();
    setAuthzRefusalDb(db as never);
    const req = makeReq({
      method: "PATCH",
      url: "/api/companies/x/goals",
      actor: {
        type: "board",
        source: "session",
        userId: "user-1",
        companyIds: [COMPANY_ID],
        memberships: [{ companyId: COMPANY_ID, membershipRole: "member", status: "active" }],
      },
    });
    (req as unknown as { body: unknown }).body = { secretPayload: "never-log-me" };

    const err = catchThrown(() => assertCanSetCompanyDirection(req, COMPANY_ID));
    expect(err.status).toBe(403);
    expect(err.message).toBe("Only an admin can change company direction.");

    await vi.waitFor(() => expect(activityRows).toHaveLength(1));
    const details = activityRows[0]!.details as Record<string, unknown>;
    expect(details).toEqual({
      method: "PATCH",
      routePath: "/api/companies/x/goals",
      reasonCode: "COMPANY_DIRECTION_ADMIN_REQUIRED",
    });
    expect(JSON.stringify(details)).not.toContain("secretPayload");
  });
});

// ---- helpers ----

interface IssueFixture {
  id: string;
  companyId: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

/**
 * Minimal drizzle-chain stub, mirroring verdicts.test.ts, plus capture of every
 * insert so tests can assert on the real `activity_log` row shape.
 */
function makeVerdictDb(_opts: { issues?: IssueFixture[] } = {}) {
  const selectQueue: unknown[][] = [];
  const captured: Array<Record<string, unknown>> = [];

  const select = vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.then = (
      resolve: (v: unknown) => unknown,
      reject: (e: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject);
    return chain;
  });

  const insert = vi.fn((_table: unknown) => ({
    values: vi.fn((values: Record<string, unknown>) => {
      captured.push(values);
      return {
        returning: vi.fn(async () => [
          { id: "generated-verdict-id", createdAt: new Date(), ...values },
        ]),
      };
    }),
  }));

  const db = {
    select,
    insert,
    update: vi.fn(),
    transaction: vi.fn(),
  };
  function queueSelect(rows: unknown[]) {
    selectQueue.push(rows);
  }
  return {
    db,
    queueSelect,
    /** Values inserted via db.insert(...).values(...) — activity_log rows. */
    get activityRows() {
      return captured;
    },
  };
}
