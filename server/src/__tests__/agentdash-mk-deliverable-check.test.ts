import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agentFactRequests,
  agentStewardships,
  agents,
  approvals,
  companies,
  companyMemberships,
  connections,
  createDb,
  deliverableChecks,
  deliverableFacts,
  deliverableRuns,
  deliverables,
  factCorrections,
  factValues,
  workflowEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { deliverableRoutes } from "../routes/deliverables.js";
import {
  computeDraftHash,
  deliverableCheckService,
} from "../services/deliverable-checks.js";
import { deliverableRunService } from "../services/deliverable-runs.js";
import { GRAPH_READONLY_SCOPES, __resetEntraOboCache } from "../services/entra-obo.js";
import {
  __resetSharepointLimiterState,
  sharepointConnectorService,
} from "../services/sharepoint-connector.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const TENANT = "tenant-mk";
const repoRoot = path.resolve(import.meta.dirname, "../../..");

/**
 * AgentDash-MK Slice G3 — the check that cannot certify the thing that made it.
 *
 * The failure mode being designed out is **reviewer capitulation**, not agent
 * error. The documented way agent deployments fail is that review slots
 * collapse from hours to minutes and reviewers quietly stop catching things. An
 * independent check is the only mitigation that survives that, and it is only
 * independent if self-certification is structurally impossible rather than
 * discouraged by a prompt.
 *
 * Four mechanisms, and each is attempted rather than asserted below:
 *
 * 1. The assembler cannot author the criteria (proven in the definition suite).
 * 2. The check module has no import edge to the assembly module, in either
 *    direction, so neither can reach the other's state.
 * 3. The check re-reads the persisted values and records a digest of exactly
 *    what it read, so a figure that moves after the check invalidates it.
 * 4. The database refuses a run at `checked` or beyond without the check's own
 *    three artifacts, so assembly cannot write the verdict even by accident.
 */
/**
 * Every `.set({ ... })` argument in a source file, brace-matched.
 *
 * Written rather than regexed because the distinction that matters is between
 * reading a column and writing one, and a substring match cannot tell them
 * apart — which is how the first version of the test below passed while
 * asserting nothing.
 */
function updateArguments(source: string): string[] {
  const chunks: string[] = [];
  let index = source.indexOf(".set({");
  while (index !== -1) {
    let depth = 0;
    let cursor = index + ".set(".length;
    const start = cursor;
    for (; cursor < source.length; cursor += 1) {
      const char = source[cursor];
      if (char === "{" || char === "(") depth += 1;
      else if (char === "}" || char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    chunks.push(source.slice(start, cursor + 1));
    index = source.indexOf(".set({", cursor);
  }
  return chunks;
}

describe("check independence is structural", () => {
  const checkSource = readFileSync(
    path.join(repoRoot, "server/src/services/deliverable-checks.ts"),
    "utf8",
  );
  const assemblySource = readFileSync(
    path.join(repoRoot, "server/src/services/deliverable-runs.ts"),
    "utf8",
  );

  it("has no import edge between assembly and the check, in either direction", () => {
    expect(
      assemblySource.includes("deliverable-checks.js"),
      "the assembler imports the checker; it could call it on its own output",
    ).toBe(false);
    expect(
      checkSource.includes("deliverable-runs.js"),
      "the checker imports the assembler; it could be handed the draft instead of reading it",
    ).toBe(false);
  });

  it("never lets assembly write the check's own artifacts", () => {
    // Reads are fine — assembly's `detail()` legitimately reports whether a run
    // has been checked. Writes are not, so this looks only inside `.set({...})`
    // arguments. A blunter substring match passed on the read and would have
    // gone on passing after someone added the write.
    const writes = updateArguments(assemblySource);
    expect(writes.length, "no .set() call was found; the extractor is broken").toBeGreaterThan(0);
    for (const column of ["checkedAt", "checkOutcome", "checkDraftHash", "checkPassed"]) {
      const offender = writes.find((chunk) => chunk.includes(`${column}:`));
      expect(
        offender,
        `deliverable-runs.ts writes ${column}; assembly can certify itself`,
      ).toBeUndefined();
    }
  });
});

describe("draft digest", () => {
  it("changes when any figure changes and not when the order of reading does", () => {
    const a = computeDraftHash([
      { factKey: "b", status: "answered", value: { text: "two" }, sourceRef: "r2" },
      { factKey: "a", status: "fetched", value: 1, sourceRef: "r1" },
    ]);
    const reordered = computeDraftHash([
      { factKey: "a", status: "fetched", value: 1, sourceRef: "r1" },
      { factKey: "b", status: "answered", value: { text: "two" }, sourceRef: "r2" },
    ]);
    expect(reordered, "the digest depended on row order").toBe(a);

    const moved = computeDraftHash([
      { factKey: "a", status: "fetched", value: 2, sourceRef: "r1" },
      { factKey: "b", status: "answered", value: { text: "two" }, sourceRef: "r2" },
    ]);
    expect(moved, "a changed figure produced the same digest").not.toBe(a);
  });
});

/** G1g. A checker nothing calls never runs. */
describe("check wiring", () => {
  it("ticks the assembled-run check sweep from server startup", () => {
    const entrypoint = readFileSync(path.join(repoRoot, "server/src/index.ts"), "utf8");
    expect(
      entrypoint.includes("sweepAssembledRuns("),
      "sweepAssembledRuns has no non-test caller; nothing ever checks an assembled run",
    ).toBe(true);
  });
});

describeEmbeddedPostgres("agentdash-mk deliverable check", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let msServer: Server | null = null;
  let msBaseUrl = "";
  const savedEnv: Record<string, string | undefined> = {};
  let graphValues: unknown[][] = [["Hours"], [412]];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mk-deliv-chk-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    __resetEntraOboCache();
    __resetSharepointLimiterState();
    graphValues = [["Hours"], [412]];

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.post(`/entra/${TENANT}/oauth2/v2.0/token`, (req, res) => {
      res.json({
        access_token: `graph-token-for:${String(req.body.assertion ?? "")}`,
        expires_in: 3600,
        token_type: "Bearer",
        scope: GRAPH_READONLY_SCOPES.join(" "),
      });
    });
    app.all(/^\/graph\/.*/, (req, res) => {
      const graphPath = req.originalUrl.slice("/graph".length);
      if (graphPath.includes("/workbook/tables/")) {
        res.json({
          address: "Sheet1!A1:A2",
          values: graphValues,
          rowCount: graphValues.length,
          columnCount: 1,
        });
        return;
      }
      res.json({ userPrincipalName: "producer@mk.test" });
    });

    msServer = createServer(app);
    await new Promise<void>((resolve) => msServer!.listen(0, "127.0.0.1", resolve));
    const address = msServer.address();
    if (!address || typeof address === "string") throw new Error("no port");
    msBaseUrl = `http://127.0.0.1:${address.port}`;

    for (const key of [
      "ENTRA_TENANT_ID",
      "ENTRA_CLIENT_ID",
      "ENTRA_CLIENT_SECRET",
      "ENTRA_OBO_TOKEN_URL",
      "SHAREPOINT_GRAPH_BASE_URL",
    ] as const) {
      savedEnv[key] = process.env[key];
    }
    process.env.ENTRA_TENANT_ID = TENANT;
    process.env.ENTRA_CLIENT_ID = "app-client-id";
    process.env.ENTRA_CLIENT_SECRET = "app-client-secret";
    process.env.ENTRA_OBO_TOKEN_URL = `${msBaseUrl}/entra/${TENANT}/oauth2/v2.0/token`;
    process.env.SHAREPOINT_GRAPH_BASE_URL = `${msBaseUrl}/graph`;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (msServer?.listening) {
      await new Promise<void>((resolve, reject) =>
        msServer!.close((error) => (error ? reject(error) : resolve())),
      );
    }
    msServer = null;

    await db.delete(workflowEvents);
    await db.delete(activityLog);
    await db.delete(factValues);
    await db.delete(factCorrections);
    await db.delete(deliverableRuns);
    await db.delete(deliverableChecks);
    await db.delete(deliverableFacts);
    await db.delete(deliverables);
    await db.delete(agentFactRequests);
    await db.delete(approvals);
    await db.delete(connections);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const DELIVERABLE_KEY = "weekly-project-review";

  function boardActor(companyId: string, userId: string, isInstanceAdmin = false) {
    return {
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
    };
  }

  function agentActor(companyId: string, agentId: string) {
    return { type: "agent", agentId, companyId, source: "agent_key", companyIds: [companyId] };
  }

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor, companyIds: [...((actor.companyIds as string[]) ?? [])] };
      next();
    });
    app.use("/api", deliverableRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function call(app: express.Express, build: (baseUrl: string) => request.Test) {
    const server = createServer(app);
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      return await build(`http://127.0.0.1:${address.port}`);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  }

  /**
   * A single-fact deliverable, all `system`, so a cycle assembles without a
   * human in it and the check is the only thing between collection and review.
   */
  async function seed(checks: Array<Record<string, unknown>>) {
    const company = await db
      .insert(companies)
      .values({
        name: `Check ${randomUUID()}`,
        issuePrefix: `CK${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: "agentdash_mk",
      })
      .returning()
      .then((rows) => rows[0]!);

    async function member(role: string) {
      return db
        .insert(companyMemberships)
        .values({
          companyId: company.id,
          principalType: "user",
          principalId: randomUUID(),
          status: "active",
          membershipRole: role,
        })
        .returning()
        .then((rows) => rows[0]!);
    }
    async function agent(name: string) {
      return db
        .insert(agents)
        .values({
          companyId: company.id,
          name,
          role: "engineer",
          status: "idle",
          adapterType: "process",
        })
        .returning()
        .then((rows) => rows[0]!);
    }

    const owner = await member("owner");
    const producerSteward = await member("operator");
    const approverOne = await member("operator");
    const approverTwo = await member("operator");
    const assembler = await agent(`Assembler ${randomUUID().slice(0, 6)}`);
    const producer = await agent(`Producer ${randomUUID().slice(0, 6)}`);

    await (await import("../services/agent-stewardships.js"))
      .agentStewardshipService(db)
      .assign(company.id, {
        agentId: producer.id,
        userId: producerSteward.principalId,
        assignedByUserId: owner.principalId,
      });
    await sharepointConnectorService(db).connect(
      company.id,
      producerSteward.principalId,
      "assert-producer",
    );

    const admin = createApp(boardActor(company.id, owner.principalId, true));
    await call(admin, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/deliverables`)
        .send({
          key: DELIVERABLE_KEY,
          name: "Weekly project review",
          cadence: "weekly",
          assemblerAgentId: assembler.id,
          firstApproverUserId: approverOne.principalId,
          secondApproverUserId: approverTwo.principalId,
        }),
    );
    await call(admin, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/deliverables/${DELIVERABLE_KEY}/facts`)
        .send({
          key: "labour.hours_booked",
          label: "Hours booked this week",
          sourceType: "system",
          derivation: "Sum of the Hours column of the WeeklyHours table.",
          ownerAgentId: producer.id,
          connectorProvider: "sharepoint",
          connectorConfig: {
            siteId: "site-1",
            itemId: "item-1",
            target: { kind: "table", name: "WeeklyHours" },
          },
        }),
    );
    for (const check of checks) {
      const res = await call(admin, (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${company.id}/deliverables/${DELIVERABLE_KEY}/checks`)
          .send(check),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }

    return { company, owner, approverOne, approverTwo, assembler, producer, admin };
  }

  async function assembledRun(companyId: string, at = "2026-07-30T09:00:00Z") {
    const svc = deliverableRunService(db);
    const { run } = await svc.openRun(companyId, DELIVERABLE_KEY, { at: new Date(at) });
    const result = await svc.assemble(companyId, run.id);
    expect(result.assembled, JSON.stringify(result)).toBe(true);
    return run;
  }

  // -- G3: the criteria are not authorable by the assembler -----------------

  it("refuses a check kind that has no evaluator", async () => {
    const seeded = await seed([]);
    const res = await call(seeded.admin, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${seeded.company.id}/deliverables/${DELIVERABLE_KEY}/checks`)
        .send({ key: "vibes", kind: "custom", config: {}, severity: "blocking" }),
    );
    // A check with no evaluator either always passes, which is worthless, or
    // always fails, which is noise that trains an approver to scroll past
    // everything including the real failures.
    expect(res.status, "a check nothing can evaluate was accepted").toBe(400);
  });

  // -- G3: the check runs, and it runs on its own path ----------------------

  it("checks an assembled run and records what it read", async () => {
    const seeded = await seed([
      { key: "hours-present", kind: "missing", config: { factKey: "labour.hours_booked" } },
      {
        key: "hours-in-range",
        kind: "range",
        config: { factKey: "labour.hours_booked", at: { row: 1, column: 0 }, min: 100, max: 900 },
      },
    ]);
    const run = await assembledRun(seeded.company.id);

    const verdict = await deliverableCheckService(db).runChecks(seeded.company.id, run.id);
    expect(verdict.passed, JSON.stringify(verdict.outcome)).toBe(true);
    expect(verdict.outcome).toHaveLength(2);

    const stored = await db
      .select()
      .from(deliverableRuns)
      .where(eq(deliverableRuns.id, run.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("checked");
    expect(stored.checkPassed).toBe(true);
    expect(stored.checkedAt).not.toBeNull();
    expect(stored.checkDraftHash, "the check recorded no digest of what it read").toBeTruthy();
  });

  it("fails a blocking check and says which figure and why", async () => {
    const seeded = await seed([
      {
        key: "hours-in-range",
        kind: "range",
        config: { factKey: "labour.hours_booked", at: { row: 1, column: 0 }, min: 0, max: 40 },
      },
    ]);
    const run = await assembledRun(seeded.company.id);

    const verdict = await deliverableCheckService(db).runChecks(seeded.company.id, run.id);
    expect(verdict.passed).toBe(false);
    const failed = verdict.outcome.find((entry) => !entry.passed)!;
    expect(failed.checkKey).toBe("hours-in-range");
    expect(failed.factKey).toBe("labour.hours_booked");
    // A named reason, never a score. A reviewer reading "412 is above the
    // ceiling of 40" can decide; one reading "risk: high" can only defer, and a
    // surface that can only be deferred to is a rubber stamp with extra steps.
    expect(failed.detail).toContain("412");
    expect(failed.detail).toContain("40");
  });

  it("fails loudly rather than guessing when a figure is not addressable", async () => {
    const seeded = await seed([
      {
        key: "hours-in-range",
        kind: "range",
        // No `at`, and the value is a table rather than a bare number. There is
        // deliberately no heuristic that goes looking for the first number it
        // can find: that is the `usedRange` mistake one layer up, and a wrong
        // number that looks right is worse than an error.
        config: { factKey: "labour.hours_booked", min: 0, max: 900 },
      },
    ]);
    const run = await assembledRun(seeded.company.id);

    const verdict = await deliverableCheckService(db).runChecks(seeded.company.id, run.id);
    expect(verdict.passed).toBe(false);
    expect(verdict.outcome[0]!.detail).toMatch(/addressab/i);
  });

  it("flags a missing figure as a failed check, not as an absent one", async () => {
    const seeded = await seed([
      { key: "hours-present", kind: "missing", config: { factKey: "labour.hours_booked" } },
    ]);
    const svc = deliverableRunService(db);
    const { run } = await svc.openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });
    // Wind the collected value back to the shape a lapsed lease leaves behind.
    await db
      .update(factValues)
      .set({ status: "missing", value: null, flagged: true, flagReason: "missing: lease lapsed" })
      .where(eq(factValues.runId, run.id));
    await svc.assemble(seeded.company.id, run.id);

    const verdict = await deliverableCheckService(db).runChecks(seeded.company.id, run.id);
    expect(verdict.passed).toBe(false);
    expect(verdict.outcome[0]!.detail).toMatch(/missing/i);
  });

  // -- G3 adversarial: self-certification -----------------------------------

  it("refuses at the database to mark a run checked without a verdict", async () => {
    // THE ADVERSARIAL CASE, attempted rather than asserted. If assembly — or
    // anything else — could move a run to `checked` without producing the
    // check's own artifacts, the separate execution path would be decoration.
    const seeded = await seed([
      { key: "hours-present", kind: "missing", config: { factKey: "labour.hours_booked" } },
    ]);
    const run = await assembledRun(seeded.company.id);

    let refusal: unknown = null;
    try {
      await db
        .update(deliverableRuns)
        .set({ status: "checked" })
        .where(eq(deliverableRuns.id, run.id));
    } catch (error) {
      refusal = error;
    }
    expect(refusal, "a run was certified with no check behind it").not.toBeNull();
    const cause = (refusal as { cause?: { constraint_name?: string } }).cause;
    expect(cause?.constraint_name).toBe("deliverable_runs_checked_has_verdict_ck");
  });

  it("invalidates its own verdict when a figure moves after the check", async () => {
    // The check records a digest of exactly the values it read. An assembler
    // that ran the check and then adjusted a number leaves a run whose stored
    // digest no longer matches its own values — and it cannot recompute the
    // digest, because writing it is the check's act.
    const seeded = await seed([
      { key: "hours-present", kind: "missing", config: { factKey: "labour.hours_booked" } },
    ]);
    const run = await assembledRun(seeded.company.id);
    const checks = deliverableCheckService(db);
    await checks.runChecks(seeded.company.id, run.id);

    expect((await checks.verifyDraftUnchanged(seeded.company.id, run.id)).unchanged).toBe(true);

    await db
      .update(factValues)
      .set({ value: { values: [["Hours"], [9_999]], address: "Sheet1!A1:A2" } })
      .where(eq(factValues.runId, run.id));

    const after = await checks.verifyDraftUnchanged(seeded.company.id, run.id);
    expect(after.unchanged, "a figure moved after the check and the verdict still stood").toBe(
      false,
    );
  });

  it("refuses to check a run that has not been assembled", async () => {
    const seeded = await seed([
      { key: "hours-present", kind: "missing", config: { factKey: "labour.hours_booked" } },
    ]);
    const { run } = await deliverableRunService(db).openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });
    // Still `collecting`. Checking a draft that is not finished would certify
    // figures that are about to change.
    await expect(
      deliverableCheckService(db).runChecks(seeded.company.id, run.id),
    ).rejects.toThrow(/assembled/i);
  });

  it("refuses to run the check from the assembling agent's own credential", async () => {
    const seeded = await seed([
      { key: "hours-present", kind: "missing", config: { factKey: "labour.hours_booked" } },
    ]);
    const run = await assembledRun(seeded.company.id);

    const res = await call(
      createApp(agentActor(seeded.company.id, seeded.assembler.id)),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/deliverable-runs/${run.id}/check`)
          .send({}),
    );
    // The party being checked does not operate the checker. It cannot write the
    // criteria and it cannot fire the verdict; the sweep does, or an
    // implementer does.
    expect(res.status, "the assembler certified its own run").toBe(403);
    const stored = await db
      .select()
      .from(deliverableRuns)
      .where(eq(deliverableRuns.id, run.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("assembled");
  });

  // -- the sweep ------------------------------------------------------------

  it("checks every assembled run from the sweep, and does not re-check one", async () => {
    const seeded = await seed([
      { key: "hours-present", kind: "missing", config: { factKey: "labour.hours_booked" } },
    ]);
    await assembledRun(seeded.company.id);

    const checks = deliverableCheckService(db);
    expect((await checks.sweepAssembledRuns()).checked).toBe(1);
    expect((await checks.sweepAssembledRuns()).checked).toBe(0);
  });

  // -- G8: pass^k, not pass@k -----------------------------------------------

  it("scores cycles as pass^k and reports pass@k beside it so they cannot be confused", async () => {
    const seeded = await seed([
      { key: "hours-present", kind: "missing", config: { factKey: "labour.hours_booked" } },
      {
        key: "hours-in-range",
        kind: "range",
        config: { factKey: "labour.hours_booked", at: { row: 1, column: 0 }, min: 0, max: 500 },
      },
      {
        key: "hours-sane",
        kind: "range",
        config: { factKey: "labour.hours_booked", at: { row: 1, column: 0 }, min: 0, max: 1_000 },
      },
      {
        key: "hours-plausible",
        kind: "range",
        config: { factKey: "labour.hours_booked", at: { row: 1, column: 0 }, min: 0, max: 2_000 },
      },
    ]);
    const checks = deliverableCheckService(db);

    // Three cycles, each with one of four checks failing: 75% per run.
    for (const [index, week] of [
      "2026-07-30T09:00:00Z",
      "2026-08-06T09:00:00Z",
      "2026-08-13T09:00:00Z",
    ].entries()) {
      graphValues = [["Hours"], [700 + index]];
      const run = await assembledRun(seeded.company.id, week);
      const verdict = await checks.runChecks(seeded.company.id, run.id);
      expect(verdict.outcome.filter((entry) => entry.passed)).toHaveLength(3);
    }

    const score = await checks.scoreDeliverable(seeded.company.id, DELIVERABLE_KEY, 3);
    expect(score.cycles).toBe(3);
    expect(score.perRunPassRate).toEqual([0.75, 0.75, 0.75]);
    // 0.75^3 = 0.421875. This is the number that says whether the thing works
    // over a quarter, and it is not 75%.
    expect(score.passPowK).toBeCloseTo(0.421875, 6);
    // 1 − 0.25^3 = 0.984375. The flattering number, reported so it can be read
    // next to the real one rather than mistaken for it.
    expect(score.passAtK).toBeCloseTo(0.984375, 6);
    expect(score.passAtK).toBeGreaterThan(score.passPowK);
    expect(score.runsFullyPassed).toBe(0);
  });

  it("serves the reliability score over a route", async () => {
    const seeded = await seed([
      { key: "hours-present", kind: "missing", config: { factKey: "labour.hours_booked" } },
    ]);
    const run = await assembledRun(seeded.company.id);
    await deliverableCheckService(db).runChecks(seeded.company.id, run.id);

    const res = await call(
      createApp(boardActor(seeded.company.id, seeded.approverOne.principalId)),
      (baseUrl) =>
        request(baseUrl).get(
          `/api/companies/${seeded.company.id}/deliverables/${DELIVERABLE_KEY}/reliability?cycles=3`,
        ),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.cycles).toBe(1);
    expect(res.body.passPowK).toBe(1);
    expect(res.body).toHaveProperty("passAtK");
  });

  // -- measurement ----------------------------------------------------------

  it("measures the check as a system step, naming nobody", async () => {
    const seeded = await seed([
      { key: "hours-present", kind: "missing", config: { factKey: "labour.hours_booked" } },
    ]);
    const run = await assembledRun(seeded.company.id);
    await deliverableCheckService(db).runChecks(seeded.company.id, run.id);

    const events = await db
      .select()
      .from(workflowEvents)
      .where(and(eq(workflowEvents.runId, run.id), eq(workflowEvents.stepKey, "check")));
    expect(events, "the check was never measured").toHaveLength(1);
    expect(events[0]!.actorKind).toBe("system");
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(seeded.assembler.id);
    expect(serialized).not.toContain(seeded.producer.id);
  });
});
