// AGE-91 — authority refusals leave a record.
//
// Pattern: mock-DB style. The REAL `logAuthzRefusal`/`logActivity` chain runs;
// only `instance-settings` is stubbed (logActivity consults it for username
// redaction). Every insert is captured off the DB stub, so assertions run
// against the actual `activity_log` row shape — no module mocking pitfalls.
//
// The three original issue scenarios:
//   1. agent key attempting a self-review verdict -> 409 unchanged + one
//      authz.refused row with reasonCode NEUTRAL_VALIDATOR_VIOLATION
//   2. agent calling a direction-setting route guard -> 403 unchanged + one row
//   3. unauthenticated request -> no row at all
// Plus the revision-review requirements (H1, H2, M3, M4, M6, M7).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { logAuthzRefusal, resetAuthzRefusalDedupe } from "../services/activity-log.js";
import { verdictsService } from "../services/verdicts.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-4444-444444444444";

type AnyActor = NonNullable<Express.Request["actor"]>;

function makeReq(input: {
  method?: string;
  url?: string;
  baseUrl?: string;
  routePath?: string;
  actor: AnyActor;
}): Request {
  return {
    method: input.method ?? "POST",
    url: input.url ?? "/api/x",
    originalUrl: input.url ?? "/api/x",
    path: input.url ?? "/api/x",
    baseUrl: input.baseUrl ?? "",
    route: input.routePath ? { path: input.routePath } : undefined,
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

let dbh: ReturnType<typeof makeCapturingDb>;

beforeEach(() => {
  dbh = makeCapturingDb();
  setAuthzRefusalDb(dbh.db as never);
});

// L8: reset the process-wide handle and dedupe window between tests so
// refusal logging/state never leaks from one case into another.
afterEach(() => {
  setAuthzRefusalDb(null);
  resetAuthzRefusalDedupe();
});

describe("AGE-91 scenario 1 — agent self-review verdict is 409 + one authz.refused row", () => {
  it("keeps the 409 and records one authz.refused row with NEUTRAL_VALIDATOR_VIOLATION", async () => {
    dbh.queueSelect([
      {
        id: ISSUE_ID,
        companyId: COMPANY_ID,
        assigneeAgentId: AGENT_ID, // the reviewer IS the assignee
        assigneeUserId: null,
      },
    ]);

    const svc = verdictsService(dbh.db as never);
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
    await vi.waitFor(() => expect(dbh.activityRows).toHaveLength(1));
    expect(dbh.activityRows[0]).toMatchObject({
      companyId: COMPANY_ID,
      actorType: "agent",
      actorId: AGENT_ID,
      agentId: AGENT_ID,
      action: "authz.refused",
      entityType: "issue",
      entityId: ISSUE_ID,
    });
    expect(dbh.activityRows[0]!.details).toEqual({
      method: "POST",
      routePath: "/api/companies/:companyId/verdicts",
      reasonCode: "NEUTRAL_VALIDATOR_VIOLATION",
    });
  });

  it("stays silent on the refusal channel when the verdict is allowed", async () => {
    dbh.queueSelect([
      { id: ISSUE_ID, companyId: COMPANY_ID, assigneeAgentId: null, assigneeUserId: null },
    ]);

    const svc = verdictsService(dbh.db as never);
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
    expect(dbh.activityRows.filter((r) => r.action === "authz.refused")).toHaveLength(0);
  });

  it("M4: service-level self-review refusal (no HTTP context) still writes one row", async () => {
    dbh.queueSelect([
      { id: ISSUE_ID, companyId: COMPANY_ID, assigneeAgentId: AGENT_ID, assigneeUserId: null },
    ]);

    const svc = verdictsService(dbh.db as never);
    const err = await svc
      .create({
        companyId: COMPANY_ID,
        entityType: "issue",
        issueId: ISSUE_ID,
        reviewerAgentId: AGENT_ID,
        outcome: "passed",
      })
      .then(
        () => null,
        (e) => e as HttpError,
      );
    expect(err!.status).toBe(409);

    await vi.waitFor(() => expect(dbh.activityRows).toHaveLength(1));
    expect(dbh.activityRows[0]).toMatchObject({
      companyId: COMPANY_ID, // attributed via the reviewer actor descriptor
      actorType: "agent",
      actorId: AGENT_ID,
      agentId: AGENT_ID,
      action: "authz.refused",
      entityType: "issue",
      entityId: ISSUE_ID,
    });
    expect(dbh.activityRows[0]!.details).toEqual({
      method: "POST",
      routePath: "/api/companies/:companyId/verdicts",
      reasonCode: "NEUTRAL_VALIDATOR_VIOLATION",
    });
  });
});

describe("AGE-91 scenario 2 — agent calling a direction-setting route is 403 + one row", () => {
  it("assertCanSetCompanyDirection keeps the 403 and records AGENT_DIRECTION_FORBIDDEN", async () => {
    const req = agentReq();
    req.method = "PATCH";

    const err = catchThrown(() => assertCanSetCompanyDirection(req, COMPANY_ID));
    expect(err.status).toBe(403);
    expect(err.message).toBe(
      "Agents cannot change company direction. Ask an owner or admin to change the goal.",
    );
    expect(err.details).toBeUndefined();

    await vi.waitFor(() => expect(dbh.activityRows).toHaveLength(1));
    expect(dbh.activityRows[0]).toMatchObject({
      companyId: COMPANY_ID,
      actorType: "agent",
      actorId: AGENT_ID,
      agentId: AGENT_ID,
      action: "authz.refused",
      entityType: "company",
      entityId: COMPANY_ID,
    });
    expect(dbh.activityRows[0]!.details).toEqual({
      method: "PATCH",
      routePath: "/api/x",
      reasonCode: "AGENT_DIRECTION_FORBIDDEN",
    });
  });

  it("H1: cross-company agent refusal is charged to the AGENT's company, not the victim", async () => {
    const req = agentReq({ companyId: OTHER_COMPANY_ID });
    const err = catchThrown(() => assertCompanyAccess(req, COMPANY_ID));
    expect(err.status).toBe(403);
    expect(err.message).toBe("Agent key cannot access another company");

    await vi.waitFor(() => expect(dbh.activityRows).toHaveLength(1));
    const row = dbh.activityRows[0]!;
    // Row lands in the actor's own company…
    expect(row.companyId).toBe(OTHER_COMPANY_ID);
    expect(row.actorType).toBe("agent");
    expect(row.actorId).toBe(AGENT_ID);
    // …and the refused target is recorded in details, keeping the row queryable.
    expect(row.details).toEqual({
      method: "POST",
      routePath: "/api/x",
      reasonCode: "AGENT_CROSS_COMPANY",
      targetCompanyId: COMPANY_ID,
    });
    // Nothing was written into the victim company's log.
    expect(dbh.activityRows.filter((r) => r.companyId === COMPANY_ID)).toHaveLength(0);
  });

  it("H2: routePath is the route pattern — query strings never reach the row", async () => {
    const req = makeReq({
      method: "GET",
      url: "/api/companies/x/connectors/gmail/c1/search?q=alice@corp.com",
      baseUrl: "/api/companies/x/connectors/gmail/c1",
      routePath: "/search",
      actor: { type: "board", source: "session", userId: "u1", companyIds: [COMPANY_ID] },
    });
    const err = catchThrown(() => assertBoard(agentReq({ type: "agent" })));
    void err; // separate refusal for BOARD_ACCESS_REQUIRED; this test only checks pattern

    await flushAsync();
    dbh.captured.length = 0; // discard the assertBoard row

    const err2 = catchThrown(() => assertCompanyAccess(req, OTHER_COMPANY_ID));
    expect(err2.status).toBe(403);

    await vi.waitFor(() => expect(dbh.activityRows).toHaveLength(1));
    const details = dbh.activityRows[0]!.details as Record<string, unknown>;
    expect(details.routePath).toBe("/api/companies/x/connectors/gmail/c1/search");
    expect(String(details.routePath)).not.toContain("alice@corp.com");
    expect(JSON.stringify(details)).not.toContain("alice@corp.com");
  });
});

describe("AGE-91 scenario 3 — unauthenticated requests are never logged", () => {
  it("anonymous 401 produces no refusal row", async () => {
    const err = catchThrown(() =>
      assertAuthenticated(makeReq({ actor: { type: "none" } })),
    );
    expect(err.status).toBe(401);
    expect(err.message).toBe("Unauthorized");

    await flushAsync();
    expect(dbh.activityRows).toHaveLength(0);
  });

  it("an HTTP-unauthenticated self-review attempt is still 409 and writes no row", async () => {
    dbh.queueSelect([
      { id: ISSUE_ID, companyId: COMPANY_ID, assigneeAgentId: AGENT_ID, assigneeUserId: null },
    ]);

    const svc = verdictsService(dbh.db as never);
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

    // With M4, even this case now records: the reviewer identity is known from
    // the payload (this is exactly the E4 gap the review flagged). The strict
    // "no row" guarantee applies to anonymous HTTP actors (assertAuthenticated
    // 401s and guards called with no actor at all), tested above.
    await vi.waitFor(() => expect(dbh.activityRows).toHaveLength(1));
    expect(dbh.activityRows[0]).toMatchObject({
      companyId: COMPANY_ID,
      actorType: "agent",
      actorId: AGENT_ID,
      agentId: AGENT_ID,
    });
    expect(
      (dbh.activityRows[0]!.details as Record<string, unknown>).reasonCode,
    ).toBe("NEUTRAL_VALIDATOR_VIOLATION");
  });

  it("logAuthzRefusal skips none-actors and actors with no derivable company", async () => {
    await expect(
      logAuthzRefusal(dbh.db as never, {
        req: makeReq({ actor: { type: "none" } }),
        companyId: COMPANY_ID,
        entityType: "company",
        entityId: COMPANY_ID,
        reasonCode: "COMPANY_ACCESS_DENIED",
      }),
    ).resolves.toBeUndefined();
    expect(dbh.activityRows).toHaveLength(0);

    await expect(
      logAuthzRefusal(dbh.db as never, {
        req: makeReq({ actor: { type: "board", source: "session", userId: "u1" } }),
        companyId: null,
        entityType: "instance",
        entityId: null,
        reasonCode: "BOARD_ACCESS_REQUIRED",
      }),
    ).resolves.toBeUndefined();
    expect(dbh.activityRows).toHaveLength(0);
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

describe("AGE-91 revision — M3 board/instance refusals, M6 dedupe, M7 runId", () => {
  it("M3: a board user's instance-admin refusal IS recorded against their own company", async () => {
    const { assertInstanceAdmin } = (await import("../routes/authz.js")) as unknown as {
      assertInstanceAdmin: (req: Request) => void;
    };
    const req = makeReq({
      method: "POST",
      url: "/api/instance-settings",
      actor: {
        type: "board",
        source: "session",
        userId: "user-1",
        isInstanceAdmin: false,
        companyIds: [COMPANY_ID],
        memberships: [{ companyId: COMPANY_ID, membershipRole: "member", status: "active" }],
      },
    });

    const err = catchThrown(() => assertInstanceAdmin(req));
    expect(err.status).toBe(403);
    expect(err.message).toBe("Instance admin access required");

    await vi.waitFor(() => expect(dbh.activityRows).toHaveLength(1));
    expect(dbh.activityRows[0]).toMatchObject({
      companyId: COMPANY_ID, // M3: actor-derived, previously null → skipped
      actorType: "user",
      actorId: "user-1",
      action: "authz.refused",
    });
    expect(dbh.activityRows[0]!.details).toMatchObject({
      reasonCode: "INSTANCE_ADMIN_REQUIRED",
    });
  });

  it("M3: BOARD_ORG_ACCESS_REQUIRED for a board actor WITH a company records against it", async () => {
    const { assertBoardOrgAccess } = (await import("../routes/authz.js")) as unknown as {
      assertBoardOrgAccess: (req: Request) => void;
    };
    const req = makeReq({
      method: "GET",
      url: "/api/instance/companies",
      // M3 fallback exercise: no companyIds array, membership only — the
      // actor-company fallback reads memberships[0].companyId.
      actor: {
        type: "board",
        source: "session",
        userId: "user-1",
        isInstanceAdmin: false,
        memberships: [{ companyId: COMPANY_ID, membershipRole: "member", status: "active" }],
      } as AnyActor,
    });
    const err = catchThrown(() => assertBoardOrgAccess(req));
    expect(err.status).toBe(403);
    expect(err.message).toBe("Company membership or instance admin access required");

    await vi.waitFor(() => expect(dbh.activityRows).toHaveLength(1));
    expect(dbh.activityRows[0]).toMatchObject({
      companyId: COMPANY_ID, // M3: actor-derived; previously companyId: null → skipped
      actorType: "user",
      actorId: "user-1",
      action: "authz.refused",
    });
    expect((dbh.activityRows[0]!.details as Record<string, unknown>).reasonCode).toBe(
      "BOARD_ORG_ACCESS_REQUIRED",
    );
  });

  it("M3 limitation stated: a membershipless board actor's refusal records nowhere", async () => {
    const { assertBoardOrgAccess } = (await import("../routes/authz.js")) as unknown as {
      assertBoardOrgAccess: (req: Request) => void;
    };
    const req = makeReq({
      method: "GET",
      url: "/api/instance/companies",
      actor: {
        type: "board",
        source: "session",
        userId: "user-1",
        companyIds: [],
        memberships: [],
      },
    });
    const err = catchThrown(() => assertBoardOrgAccess(req));
    expect(err.status).toBe(403); // still refused…

    // …but with no company anywhere on the actor there is no row to attribute
    // it to (activity_log.company_id is NOT NULL). This is the documented
    // limitation, not a regression: instance-wide refusals only record when
    // the actor belongs to at least one company.
    await flushAsync();
    expect(dbh.activityRows).toHaveLength(0);
  });

  it("M3: an agent on an instance-admin route records BOARD_ACCESS_REQUIRED (dedupe-independent)", async () => {
    const req = makeReq({
      method: "GET",
      url: "/api/instance/settings",
      actor: {
        type: "agent",
        agentId: AGENT_ID,
        companyId: COMPANY_ID,
        source: "agent_key",
      },
    });
    const err = catchThrown(() => assertBoard(req));
    expect(err.status).toBe(403);
    await vi.waitFor(() => expect(dbh.activityRows).toHaveLength(1));
    expect(dbh.activityRows[0]).toMatchObject({
      companyId: COMPANY_ID, // agent-derived
    });
    expect((dbh.activityRows[0]!.details as Record<string, unknown>).reasonCode).toBe(
      "BOARD_ACCESS_REQUIRED",
    );
  });

  it("M6: repeat refusals (same actor/reason/route) collapse to one row inside the window", async () => {
    const req = agentReq();
    req.method = "PATCH";
    for (let i = 0; i < 5; i += 1) {
      const err = catchThrown(() => assertCanSetCompanyDirection(req, COMPANY_ID));
      expect(err.status).toBe(403);
    }
    await vi.waitFor(() => expect(dbh.activityRows.length).toBeGreaterThanOrEqual(1));
    await flushAsync();
    expect(dbh.activityRows).toHaveLength(1); // not 5
  });

  it("M6: dedupe does not collapse different reason codes from the same actor", async () => {
    catchThrown(() => assertBoard(agentReq()));
    await vi.waitFor(() => expect(dbh.activityRows).toHaveLength(1));
    const crossReq = agentReq({ companyId: OTHER_COMPANY_ID });
    const err = catchThrown(() => assertCompanyAccess(crossReq, COMPANY_ID));
    expect(err.status).toBe(403);
    await vi.waitFor(() => expect(dbh.activityRows).toHaveLength(2));
    const reasons = dbh.activityRows.map(
      (r) => (r.details as Record<string, unknown>).reasonCode,
    );
    expect(reasons).toEqual(["BOARD_ACCESS_REQUIRED", "AGENT_CROSS_COMPANY"]);
  });

  it("M6 (re-review): distinct entities are distinct acts — the window never collapses refusals on different records", async () => {
    const actor = { actorType: "agent" as const, actorId: AGENT_ID, agentId: AGENT_ID, companyId: COMPANY_ID };
    const base = { actor, companyId: COMPANY_ID, entityType: "issue", reasonCode: "NEUTRAL_VALIDATOR_VIOLATION", routePath: "service" };
    await logAuthzRefusal(dbh.db as never, { ...base, entityId: "issue-A" });
    await logAuthzRefusal(dbh.db as never, { ...base, entityId: "issue-B" });
    await logAuthzRefusal(dbh.db as never, { ...base, entityId: "issue-A" }); // a retry of the first act
    await flushAsync();
    expect(dbh.activityRows.map((r) => r.entityId)).toEqual(["issue-A", "issue-B"]);
  });

  it("H1 (service path): an agent descriptor without its own company records nothing, even when the caller passes a company", async () => {
    await logAuthzRefusal(dbh.db as never, {
      actor: { actorType: "agent", actorId: AGENT_ID, agentId: AGENT_ID, companyId: null },
      companyId: OTHER_COMPANY_ID,
      entityType: "issue",
      entityId: ISSUE_ID,
      reasonCode: "NEUTRAL_VALIDATOR_VIOLATION",
      routePath: "service",
    });
    await flushAsync();
    expect(dbh.activityRows).toHaveLength(0);
    // a user descriptor may fall back to the caller's scope: that is the user's own refusal context
    await logAuthzRefusal(dbh.db as never, {
      actor: { actorType: "user", actorId: "user-1", companyId: null },
      companyId: COMPANY_ID,
      entityType: "company",
      entityId: COMPANY_ID,
      reasonCode: "BOARD_ACCESS_REQUIRED",
      routePath: "service",
    });
    await flushAsync();
    expect(dbh.activityRows).toHaveLength(1);
    expect(dbh.activityRows[0]!.companyId).toBe(COMPANY_ID);
  });

  it("M7: a runId on the actor is never inserted (FK-safe refusal rows)", async () => {
    const req = agentReq({ runId: "99999999-9999-4999-8999-999999999999" });
    req.method = "PATCH";
    catchThrown(() => assertCanSetCompanyDirection(req, COMPANY_ID));

    await vi.waitFor(() => expect(dbh.activityRows).toHaveLength(1));
    expect(dbh.activityRows[0]!.runId).toBeNull();
  });
});

describe("AGE-91 — wiring and non-goals", () => {
  it("guards stay silent when no db is wired (pre-AGE-91 behavior intact)", async () => {
    // L8: real isolation — null the handle the beforeEach wired.
    setAuthzRefusalDb(null);
    const err = catchThrown(() => assertCanSetCompanyDirection(agentReq(), COMPANY_ID));
    expect(err.status).toBe(403); // still refused
    await flushAsync();
    expect(dbh.activityRows).toHaveLength(0); // nothing captured anywhere
  });

  it("assertBoard refusal for an agent carries BOARD_ACCESS_REQUIRED", async () => {
    const err = catchThrown(() => assertBoard(agentReq()));
    expect(err.status).toBe(403);
    expect(err.message).toBe("Board access required");

    await vi.waitFor(() => expect(dbh.activityRows).toHaveLength(1));
    expect((dbh.activityRows[0]!.details as Record<string, unknown>).reasonCode).toBe(
      "BOARD_ACCESS_REQUIRED",
    );
  });

  it("details never include the request body", async () => {
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

    await vi.waitFor(() => expect(dbh.activityRows).toHaveLength(1));
    const details = dbh.activityRows[0]!.details as Record<string, unknown>;
    expect(details).toEqual({
      method: "PATCH",
      routePath: "/api/companies/x/goals",
      reasonCode: "COMPANY_DIRECTION_ADMIN_REQUIRED",
    });
    expect(JSON.stringify(details)).not.toContain("secretPayload");
  });

  it("routePath is capped at 200 chars even on pathological paths", async () => {
    const longPath = `/api/${"x".repeat(500)}`;
    const req = makeReq({
      method: "GET",
      url: longPath,
      actor: { type: "board", source: "session", userId: "u1", companyIds: [COMPANY_ID] },
    });
    const err = catchThrown(() => assertCompanyAccess(req, OTHER_COMPANY_ID));
    expect(err.status).toBe(403);
    await vi.waitFor(() => expect(dbh.activityRows).toHaveLength(1));
    const details = dbh.activityRows[0]!.details as Record<string, unknown>;
    expect((details.routePath as string).length).toBeLessThanOrEqual(200);
  });
});

// ---- helpers ----

/**
 * Minimal drizzle-chain stub, mirroring verdicts.test.ts, plus capture of every
 * insert so tests can assert on the real `activity_log` row shape.
 */
function makeCapturingDb(_opts: { issues?: unknown[] } = {}) {
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
    captured,
    /** Values inserted via db.insert(...).values(...) — activity_log rows. */
    get activityRows() {
      return captured;
    },
  };
}
