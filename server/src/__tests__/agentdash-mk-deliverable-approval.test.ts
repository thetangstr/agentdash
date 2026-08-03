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
  approvalComments,
  approvals,
  companies,
  companyMemberships,
  connections,
  createDb,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  heartbeatRunEvents,
  heartbeatRuns,
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
import { approvalRoutes } from "../routes/approvals.js";
import { deliverableRoutes } from "../routes/deliverables.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { deliverableCheckService } from "../services/deliverable-checks.js";
import { deliverableReviewService } from "../services/deliverable-review.js";
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
 * AgentDash-MK Slices G4–G7 — review, two sequential approvals, corrections.
 *
 * **Minutes of senior attention per cycle is the number that decides whether
 * this is a business.** So the review surface is the draft plus the items that
 * need attention, and never a blank re-review of every figure: a surface that
 * asks for the same twenty confirmations every week is a surface people stop
 * reading, and then a real failure scrolls past with the rest.
 *
 * Two approvers, deciding in order, and nothing ships without both. The
 * sequencing is a database constraint, not a code path — the second approval
 * cannot exist until the first has landed.
 *
 * Corrections attach to the **fact**, never to a person. Nobody authors a
 * skill, and no artifact carries somebody's name describing what they used to
 * get wrong. That is the learning loop that survives the social objection to
 * it, and it is why the correction is keyed on `fact_id` and applied by the
 * next run regardless of who collected the figure that time.
 */

/** G1g. */
describe("deliverable approval wiring", () => {
  it.each([
    ["advanceDeliverableApproval", "server/src/routes/approvals.ts"],
    ["failDeliverableApproval", "server/src/routes/approvals.ts"],
    ["deliverableReviewService", "server/src/routes/deliverables.ts"],
    ["sweepCheckedRuns", "server/src/index.ts"],
  ])("%s has a non-test caller in %s", (fnName, file) => {
    const source = readFileSync(path.join(repoRoot, file), "utf8");
    expect(source.includes(`${fnName}(`), `${fnName} has no non-test caller`).toBe(true);
  });
});

describeEmbeddedPostgres("agentdash-mk deliverable review and approval", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let msServer: Server | null = null;
  let msBaseUrl = "";
  const savedEnv: Record<string, string | undefined> = {};
  let graphValues: unknown[][] = [["Hours"], [412]];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mk-deliv-appr-");
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

  /**
   * Delete a table, retrying on a foreign-key refusal.
   *
   * These suites drive the shared approvals route, which has background work
   * hanging off a decision. The deliverable path no longer triggers any of it —
   * a sign-off does not wake the assembling agent, because nothing about the
   * assembler is blocked on the decision — but the retry stays as a cheap guard
   * against a future decision hook doing so and turning teardown into a race
   * somebody debugs from a foreign-key error rather than from the cause.
   */
  async function purge(table: Parameters<TestDb["delete"]>[0], attempts = 20) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await db.delete(table);
        return;
      } catch (error) {
        if (attempt === attempts - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

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

    await purge(workflowEvents);
    await purge(factValues);
    await purge(factCorrections);
    await purge(deliverableRuns);
    await purge(deliverableChecks);
    await purge(deliverableFacts);
    await purge(deliverables);
    await purge(agentFactRequests);
    await purge(approvalComments);
    await purge(approvals);
    await purge(connections);
    // The approvals route wakes the requesting agent on a decision, which is a
    // heartbeat run holding an agent reference.
    // After the deliverable tables, and immediately before the heartbeat rows
    // it references: the approvals route wakes the requesting agent in the
    // background, so activity rows can still be arriving when teardown starts.
    await purge(activityLog);
    await purge(heartbeatRunEvents);
    await purge(heartbeatRuns);
    await purge(agentWakeupRequests);
    await purge(agentRuntimeState);
    await purge(agentStewardships);
    await purge(agents);
    await purge(companyMemberships);
    await purge(companySkills);
    await purge(companies);
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

  function createApp(mount: (app: express.Express) => void, actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { ...actor, companyIds: [...((actor.companyIds as string[]) ?? [])] };
      next();
    });
    mount(app);
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

  function deliverableApp(companyId: string, actor: Record<string, unknown>) {
    return createApp((app) => app.use("/api", deliverableRoutes(db)), actor);
  }

  function approvalApp(actor: Record<string, unknown>) {
    return createApp((app) => app.use("/api", approvalRoutes(db)), actor);
  }

  /** The decision metadata every `agentdash_mk` approval decision must carry. */
  function decision(revision = 1) {
    return { revision, idempotencyKey: `web-${randomUUID()}`, channel: "web" };
  }

  async function seed() {
    const company = await db
      .insert(companies)
      .values({
        name: `Approve ${randomUUID()}`,
        issuePrefix: `AP${randomUUID().slice(0, 6).toUpperCase()}`,
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
    const assemblerSteward = await member("operator");
    const approverOne = await member("operator");
    const approverTwo = await member("operator");
    const bystander = await member("operator");
    const assembler = await agent(`Assembler ${randomUUID().slice(0, 6)}`);
    const producer = await agent(`Producer ${randomUUID().slice(0, 6)}`);

    const stewardships = agentStewardshipService(db);
    await stewardships.assign(company.id, {
      agentId: producer.id,
      userId: producerSteward.principalId,
      assignedByUserId: owner.principalId,
    });
    await stewardships.assign(company.id, {
      agentId: assembler.id,
      userId: assemblerSteward.principalId,
      assignedByUserId: owner.principalId,
    });
    await sharepointConnectorService(db).connect(
      company.id,
      producerSteward.principalId,
      "assert-producer",
    );

    const admin = deliverableApp(company.id, boardActor(company.id, owner.principalId, true));
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
    // Two system facts, so a cycle assembles with no human in the collection.
    for (const [key, label, table] of [
      ["labour.hours_booked", "Hours booked this week", "WeeklyHours"],
      ["labour.hours_forecast", "Hours forecast next week", "ForecastHours"],
    ]) {
      await call(admin, (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${company.id}/deliverables/${DELIVERABLE_KEY}/facts`)
          .send({
            key,
            label,
            sourceType: "system",
            derivation: `Sum of the Hours column of the ${table} table.`,
            ownerAgentId: producer.id,
            connectorProvider: "sharepoint",
            connectorConfig: {
              siteId: "site-1",
              itemId: "item-1",
              target: { kind: "table", name: table },
            },
          }),
      );
    }
    await call(admin, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/deliverables/${DELIVERABLE_KEY}/checks`)
        .send({
          key: "hours-in-range",
          kind: "range",
          config: { factKey: "labour.hours_booked", at: { row: 1, column: 0 }, min: 0, max: 900 },
        }),
    );

    return {
      company,
      owner,
      producerSteward,
      assemblerSteward,
      approverOne,
      approverTwo,
      bystander,
      assembler,
      producer,
      admin,
    };
  }

  /** Carry a run all the way to `awaiting_approval` through the real services. */
  async function presentedRun(companyId: string, at = "2026-07-30T09:00:00Z") {
    const runs = deliverableRunService(db);
    const { run } = await runs.openRun(companyId, DELIVERABLE_KEY, { at: new Date(at) });
    expect((await runs.assemble(companyId, run.id)).assembled).toBe(true);
    await deliverableCheckService(db).runChecks(companyId, run.id);
    await deliverableReviewService(db).present(companyId, run.id);
    return run;
  }

  async function runRow(runId: string) {
    return db
      .select()
      .from(deliverableRuns)
      .where(eq(deliverableRuns.id, runId))
      .then((rows) => rows[0]!);
  }

  async function pendingApproval(companyId: string) {
    return db
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
      .then((rows) => rows[0] ?? null);
  }

  // -- G4: draft plus flagged items only ------------------------------------

  it("shows the draft plus what needs attention, and nothing else to confirm", async () => {
    const seeded = await seed();
    // One figure the connector could not read: the second table is absent.
    graphValues = [["Hours"], [412]];
    const runs = deliverableRunService(db);
    const { run } = await runs.openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });
    // Wind one figure back to what a refused fetch leaves behind.
    const forecastFact = await db
      .select()
      .from(deliverableFacts)
      .where(eq(deliverableFacts.key, "labour.hours_forecast"))
      .then((rows) => rows[0]!);
    await db
      .update(factValues)
      .set({
        status: "missing",
        value: null,
        flagged: true,
        flagReason: "target_not_found: Microsoft Graph has no such table",
      })
      .where(and(eq(factValues.runId, run.id), eq(factValues.factId, forecastFact.id)));

    await runs.assemble(seeded.company.id, run.id);
    await deliverableCheckService(db).runChecks(seeded.company.id, run.id);
    await deliverableReviewService(db).present(seeded.company.id, run.id);

    const res = await call(
      deliverableApp(seeded.company.id, boardActor(seeded.company.id, seeded.approverOne.principalId)),
      (baseUrl) =>
        request(baseUrl).get(
          `/api/companies/${seeded.company.id}/deliverable-runs/${run.id}/review`,
        ),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    // The whole draft is there to read.
    expect(res.body.draft).toHaveLength(2);
    // But only the item that needs a decision is asked about. Minutes of senior
    // attention per cycle is the number that decides whether this is a
    // business, and a blank re-review of every figure spends all of them.
    expect(res.body.attention, JSON.stringify(res.body.attention)).toHaveLength(1);
    expect(res.body.attention[0].factKey).toBe("labour.hours_forecast");
    expect(res.body.attention[0].kind).toBe("flagged_value");
    expect(res.body.attention[0].detail).toContain("target_not_found");
    // The figure that landed cleanly is in the draft and NOT in the attention
    // list — it is not re-confirmed every week.
    expect(
      res.body.attention.some((item: any) => item.factKey === "labour.hours_booked"),
      "an unflagged figure was put in front of the approver anyway",
    ).toBe(false);
    expect(res.body.stage).toBe("first");
  });

  it("puts a fact collection never reached in front of the approver rather than dropping it", async () => {
    const seeded = await seed();
    const runs = deliverableRunService(db);
    const { run } = await runs.openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });
    // No value row at all — the shape a half-finished collection leaves. Not a
    // flagged value with a reason on it, which is the ordinary case; this is the
    // one where nothing recorded anything.
    const forecastFact = await db
      .select()
      .from(deliverableFacts)
      .where(eq(deliverableFacts.key, "labour.hours_forecast"))
      .then((rows) => rows[0]!);
    await db
      .delete(factValues)
      .where(and(eq(factValues.runId, run.id), eq(factValues.factId, forecastFact.id)));
    await runs.assemble(seeded.company.id, run.id);
    await deliverableCheckService(db).runChecks(seeded.company.id, run.id);
    await deliverableReviewService(db).present(seeded.company.id, run.id);

    const res = await call(
      deliverableApp(seeded.company.id, boardActor(seeded.company.id, seeded.approverOne.principalId)),
      (baseUrl) =>
        request(baseUrl).get(
          `/api/companies/${seeded.company.id}/deliverable-runs/${run.id}/review`,
        ),
    );
    // Present in the draft AND in the attention list. A fact that simply
    // vanished from the surface is the unmarked hole this pipeline exists to
    // make impossible.
    expect(res.body.draft.map((item: any) => item.factKey)).toContain("labour.hours_forecast");
    const flagged = res.body.attention.find(
      (item: any) => item.factKey === "labour.hours_forecast",
    );
    expect(flagged, JSON.stringify(res.body.attention)).toBeDefined();
    expect(flagged.detail).toMatch(/no value was collected/i);
  });

  it("puts a failed acceptance check in front of the first approver", async () => {
    const seeded = await seed();
    graphValues = [["Hours"], [9_999]];
    const run = await presentedRun(seeded.company.id);

    const res = await call(
      deliverableApp(seeded.company.id, boardActor(seeded.company.id, seeded.approverOne.principalId)),
      (baseUrl) =>
        request(baseUrl).get(
          `/api/companies/${seeded.company.id}/deliverable-runs/${run.id}/review`,
        ),
    );
    const failed = res.body.attention.find((item: any) => item.kind === "failed_check");
    expect(failed, JSON.stringify(res.body.attention)).toBeDefined();
    expect(failed.detail).toContain("9999");
    expect(res.body.checkPassed).toBe(false);
  });

  it("carries a cycle from schedule to an approver's inbox with nobody driving it", async () => {
    // G2 end to end, through the sweeps only. No route call, no agent
    // remembering to do anything: the schedule opens it, collection fills it,
    // the check certifies it, and it arrives in front of the first approver.
    const seeded = await seed();
    const runs = deliverableRunService(db);

    expect((await runs.sweepDueDeliverableRuns(new Date("2026-07-30T09:00:00Z"))).opened).toBe(1);
    expect((await runs.sweepCollectingRuns()).assembled).toBe(1);
    expect((await deliverableCheckService(db).sweepAssembledRuns()).checked).toBe(1);
    expect((await deliverableReviewService(db).sweepCheckedRuns()).presented).toBe(1);

    const run = await db.select().from(deliverableRuns).then((rows) => rows[0]!);
    expect(run.status).toBe("awaiting_approval");
    const pending = await pendingApproval(seeded.company.id);
    expect(pending, "the cycle never reached a human").not.toBeNull();
    expect((pending!.payload as any).approverUserId).toBe(seeded.approverOne.principalId);

    // And it does not present twice.
    expect((await deliverableReviewService(db).sweepCheckedRuns()).presented).toBe(0);
  });

  // -- G5 / G7: two approvers, sequential -----------------------------------

  it("asks the first approver, then the second, and ships only after both", async () => {
    const seeded = await seed();
    const run = await presentedRun(seeded.company.id);

    const first = await pendingApproval(seeded.company.id);
    expect(first, "presenting created no approval").not.toBeNull();
    expect(first!.type).toBe("deliverable_review");
    expect((first!.payload as any).stage).toBe("first");
    expect((first!.payload as any).approverUserId).toBe(seeded.approverOne.principalId);
    // Exactly one. The second seat does not exist yet, which is what makes the
    // two approvals sequential rather than merely two.
    expect(
      await db.select().from(approvals).where(eq(approvals.companyId, seeded.company.id)),
    ).toHaveLength(1);

    const firstDecision = await call(
      approvalApp(boardActor(seeded.company.id, seeded.approverOne.principalId)),
      (baseUrl) =>
        request(baseUrl).post(`/api/approvals/${first!.id}/approve`).send(decision()),
    );
    expect(firstDecision.status, JSON.stringify(firstDecision.body)).toBe(200);

    let stored = await runRow(run.id);
    expect(stored.firstApprovedAt, "the first approval was not recorded").not.toBeNull();
    expect(stored.status, "one approval shipped the deliverable").toBe("awaiting_approval");
    expect(stored.shippedAt, "one approval shipped the deliverable").toBeNull();

    const second = await pendingApproval(seeded.company.id);
    expect(second, "the second approver was never asked").not.toBeNull();
    expect((second!.payload as any).stage).toBe("second");
    expect((second!.payload as any).approverUserId).toBe(seeded.approverTwo.principalId);

    const secondDecision = await call(
      approvalApp(boardActor(seeded.company.id, seeded.approverTwo.principalId)),
      (baseUrl) =>
        request(baseUrl).post(`/api/approvals/${second!.id}/approve`).send(decision()),
    );
    expect(secondDecision.status, JSON.stringify(secondDecision.body)).toBe(200);

    stored = await runRow(run.id);
    expect(stored.secondApprovedAt).not.toBeNull();
    expect(stored.status).toBe("shipped");
    expect(stored.shippedAt).not.toBeNull();
  });

  /**
   * G7, adversarial. A single approval must not be able to ship anything, by
   * any route — including one that goes straight at the table.
   */
  it("refuses at the database to ship a run carrying only one approval", async () => {
    const seeded = await seed();
    const run = await presentedRun(seeded.company.id);
    const first = await pendingApproval(seeded.company.id);
    await call(
      approvalApp(boardActor(seeded.company.id, seeded.approverOne.principalId)),
      (baseUrl) => request(baseUrl).post(`/api/approvals/${first!.id}/approve`).send(decision()),
    );

    let refusal: unknown = null;
    try {
      await db
        .update(deliverableRuns)
        .set({ status: "shipped", shippedAt: new Date() })
        .where(eq(deliverableRuns.id, run.id));
    } catch (error) {
      refusal = error;
    }
    expect(refusal, "a deliverable shipped on one approval").not.toBeNull();
    const cause = (refusal as { cause?: { constraint_name?: string } }).cause;
    expect(cause?.constraint_name).toBe("deliverable_runs_both_approvals_to_ship_ck");
    expect((await runRow(run.id)).shippedAt).toBeNull();
  });

  it("refuses at the database to record a second approval before the first landed", async () => {
    const seeded = await seed();
    const run = await presentedRun(seeded.company.id);
    const first = await pendingApproval(seeded.company.id);

    let refusal: unknown = null;
    try {
      // The same approval row put in the second seat, with nothing in the
      // first. Sequential means the order is enforced, not merely intended.
      await db
        .update(deliverableRuns)
        .set({ secondApprovalId: first!.id, firstApprovedAt: null })
        .where(eq(deliverableRuns.id, run.id));
    } catch (error) {
      refusal = error;
    }
    expect(refusal, "the two approvals were not sequential").not.toBeNull();
    const cause = (refusal as { cause?: { constraint_name?: string } }).cause;
    expect(cause?.constraint_name).toBe("deliverable_runs_sequential_approval_ck");
  });

  it("refuses the second approver's decision while the first seat is open", async () => {
    const seeded = await seed();
    await presentedRun(seeded.company.id);
    const first = await pendingApproval(seeded.company.id);

    const res = await call(
      approvalApp(boardActor(seeded.company.id, seeded.approverTwo.principalId)),
      (baseUrl) => request(baseUrl).post(`/api/approvals/${first!.id}/approve`).send(decision()),
    );
    expect(res.status, "the second approver decided the first seat").toBe(403);
  });

  it("refuses a decision from anyone who is not the named approver", async () => {
    const seeded = await seed();
    await presentedRun(seeded.company.id);
    const first = await pendingApproval(seeded.company.id);

    for (const [who, userId] of [
      ["a bystanding member", seeded.bystander.principalId],
      // The assembling agent's own steward. Ordinarily the steward of the
      // requesting agent decides its approvals; a deliverable's approvers are
      // named on the definition instead, and that must win.
      ["the assembler's steward", seeded.assemblerSteward.principalId],
    ] as const) {
      const res = await call(
        approvalApp(boardActor(seeded.company.id, userId)),
        (baseUrl) => request(baseUrl).post(`/api/approvals/${first!.id}/approve`).send(decision()),
      );
      expect(res.status, `${who} decided a deliverable they do not approve`).toBe(403);
    }
    expect((await runRow((await db.select().from(deliverableRuns))[0]!.id)).firstApprovedAt).toBeNull();
  });

  it("refuses to present a run whose figures moved after the check", async () => {
    const seeded = await seed();
    const runs = deliverableRunService(db);
    const { run } = await runs.openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });
    await runs.assemble(seeded.company.id, run.id);
    await deliverableCheckService(db).runChecks(seeded.company.id, run.id);

    // The exact self-certification-by-later-edit move: check, then adjust.
    await db
      .update(factValues)
      .set({ value: { values: [["Hours"], [1]], address: "Sheet1!A1:A2" } })
      .where(eq(factValues.runId, run.id));

    await expect(
      deliverableReviewService(db).present(seeded.company.id, run.id),
    ).rejects.toThrow(/changed since|check/i);
    expect(await db.select().from(approvals)).toHaveLength(0);
  });

  // -- G5: who waited on whom, and for how long -----------------------------

  it("measures each approval stage's wait without recording which person waited", async () => {
    const seeded = await seed();
    const run = await presentedRun(seeded.company.id);
    const first = await pendingApproval(seeded.company.id);
    await call(
      approvalApp(boardActor(seeded.company.id, seeded.approverOne.principalId)),
      (baseUrl) => request(baseUrl).post(`/api/approvals/${first!.id}/approve`).send(decision()),
    );
    const second = await pendingApproval(seeded.company.id);
    await call(
      approvalApp(boardActor(seeded.company.id, seeded.approverTwo.principalId)),
      (baseUrl) => request(baseUrl).post(`/api/approvals/${second!.id}/approve`).send(decision()),
    );

    const events = await db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.runId, run.id));
    const stages = events
      .filter((event) => event.eventType === "approval_decided")
      .map((event) => ({
        stepKey: event.stepKey,
        actorRole: (event.payload as any)?.actorRole,
        durationMs: event.durationMs,
      }))
      .sort((a, b) => a.stepKey.localeCompare(b.stepKey));

    // Two decisions, on two named STAGES, each carrying how long that stage
    // waited. That is the whole of "who waited on whom" this system is willing
    // to record: the seat, never the occupant. An event that named the person
    // would put a per-employee response-time report one query away, which is
    // the documented task-mining backlash and the fastest way to lose adoption
    // at the moment the system starts working.
    expect(stages).toHaveLength(2);
    expect(stages[0]!.stepKey).toBe("approval.first");
    expect(stages[0]!.actorRole).toBe("approver_1");
    expect(stages[0]!.durationMs).not.toBeNull();
    expect(stages[1]!.stepKey).toBe("approval.second");
    expect(stages[1]!.actorRole).toBe("approver_2");
    expect(stages[1]!.durationMs).not.toBeNull();

    const serialized = JSON.stringify(events);
    for (const identifier of [
      seeded.approverOne.principalId,
      seeded.approverTwo.principalId,
      seeded.assembler.id,
      seeded.producer.id,
    ]) {
      expect(serialized, "a person reached the measurement substrate").not.toContain(identifier);
    }
  });

  // -- G6: corrections attach to the fact -----------------------------------

  it("records a correction against the fact and applies it on the next run", async () => {
    const seeded = await seed();
    const run = await presentedRun(seeded.company.id);

    const recorded = await call(
      deliverableApp(seeded.company.id, boardActor(seeded.company.id, seeded.approverOne.principalId)),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/deliverable-runs/${run.id}/corrections`)
          .send({
            factKey: "labour.hours_booked",
            correction: {
              kind: "replace_source",
              connectorConfig: { target: { kind: "table", name: "WeeklyHoursCorrected" } },
            },
            reason: "the booked hours live in the corrected table since the migration",
          }),
    );
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);

    const stored = await db.select().from(factCorrections);
    expect(stored).toHaveLength(1);
    // Attached to the fact. There is no column here naming whose figure was
    // wrong, and nothing that would let this table answer "how many corrections
    // has this person's work needed".
    const fact = await db
      .select()
      .from(deliverableFacts)
      .where(eq(deliverableFacts.key, "labour.hours_booked"))
      .then((rows) => rows[0]!);
    expect(stored[0]!.factId).toBe(fact.id);
    expect(stored[0]!.retiredAt).toBeNull();

    // The NEXT cycle reads the corrected place, with nobody re-entering
    // anything. Carried forward silently because it is a corrected derivation.
    const { run: next } = await deliverableRunService(db).openRun(
      seeded.company.id,
      DELIVERABLE_KEY,
      { at: new Date("2026-08-06T09:00:00Z") },
    );
    const nextValue = await db
      .select()
      .from(factValues)
      .where(and(eq(factValues.runId, next.id), eq(factValues.factId, fact.id)))
      .then((rows) => rows[0]!);
    expect(nextValue.sourceRef, "the correction was not applied on the next run").toContain(
      "WeeklyHoursCorrected",
    );
    expect(nextValue.appliedCorrectionId).toBe(stored[0]!.id);
    expect(nextValue.method).toContain("corrected");
  });

  it("carries an overridden value forward flagged, never silently", async () => {
    const seeded = await seed();
    const run = await presentedRun(seeded.company.id);
    await call(
      deliverableApp(seeded.company.id, boardActor(seeded.company.id, seeded.approverTwo.principalId)),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/deliverable-runs/${run.id}/corrections`)
          .send({
            factKey: "labour.hours_booked",
            correction: { kind: "override_value", value: { values: [["Hours"], [500]] } },
            reason: "the source double-counts contractors",
          }),
    );

    const { run: next } = await deliverableRunService(db).openRun(
      seeded.company.id,
      DELIVERABLE_KEY,
      { at: new Date("2026-08-06T09:00:00Z") },
    );
    const fact = await db
      .select()
      .from(deliverableFacts)
      .where(eq(deliverableFacts.key, "labour.hours_booked"))
      .then((rows) => rows[0]!);
    const value = await db
      .select()
      .from(factValues)
      .where(and(eq(factValues.runId, next.id), eq(factValues.factId, fact.id)))
      .then((rows) => rows[0]!);

    expect(JSON.stringify(value.value)).toContain("500");
    // A number nobody re-derives is a stale premise, and a human at the end
    // catches errors but not wrong foundations. So it stays visible every week
    // rather than becoming the quiet new truth.
    expect(value.flagged, "a carried-forward override went unflagged").toBe(true);
    expect(value.flagReason).toMatch(/override/i);
  });

  it("retires the previous correction rather than stacking them", async () => {
    const seeded = await seed();
    const run = await presentedRun(seeded.company.id);
    const app = deliverableApp(
      seeded.company.id,
      boardActor(seeded.company.id, seeded.approverOne.principalId),
    );
    for (const note of ["first read", "second read"]) {
      const res = await call(app, (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/deliverable-runs/${run.id}/corrections`)
          .send({
            factKey: "labour.hours_booked",
            correction: { kind: "annotate", note },
            reason: note,
          }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }

    const stored = await db.select().from(factCorrections);
    expect(stored).toHaveLength(2);
    // One active correction per fact, by partial unique index. Two live
    // corrections on one figure is an order-dependent pile nobody can reason
    // about, and the order would decide the number.
    expect(stored.filter((row) => row.retiredAt === null)).toHaveLength(1);
    expect((stored.find((row) => row.retiredAt === null)!.correction as any).note).toBe(
      "second read",
    );
  });

  it("refuses a correction from someone who is not an approver or an implementer", async () => {
    const seeded = await seed();
    const run = await presentedRun(seeded.company.id);
    const res = await call(
      deliverableApp(seeded.company.id, boardActor(seeded.company.id, seeded.bystander.principalId)),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/deliverable-runs/${run.id}/corrections`)
          .send({
            factKey: "labour.hours_booked",
            correction: { kind: "override_value", value: 1 },
            reason: "because",
          }),
    );
    expect(res.status, "anyone could rewrite a figure for every future cycle").toBe(403);
    expect(await db.select().from(factCorrections)).toHaveLength(0);
  });

  it("refuses a correction from the assembling agent", async () => {
    const seeded = await seed();
    const run = await presentedRun(seeded.company.id);
    const res = await call(
      deliverableApp(seeded.company.id, agentActor(seeded.company.id, seeded.assembler.id)),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/deliverable-runs/${run.id}/corrections`)
          .send({
            factKey: "labour.hours_booked",
            correction: { kind: "override_value", value: 1 },
            reason: "trust me",
          }),
    );
    // An agent that could write a durable override would be choosing the number
    // every future cycle reports, permanently, with no human in the loop.
    expect(res.status, "the assembler wrote its own durable override").toBe(403);
  });

  // -- rejection ------------------------------------------------------------

  it("sends a rejected run back to collection rather than shipping or abandoning it", async () => {
    const seeded = await seed();
    const run = await presentedRun(seeded.company.id);
    const first = await pendingApproval(seeded.company.id);

    const rejected = await call(
      approvalApp(boardActor(seeded.company.id, seeded.approverOne.principalId)),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/approvals/${first!.id}/reject`)
          .send({ ...decision(), decisionNote: "the forecast table is wrong" }),
    );
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

    const stored = await runRow(run.id);
    expect(stored.status).toBe("collecting");
    expect(stored.shippedAt).toBeNull();
    // The verdict is cleared with the reset: a run that has to be collected
    // again has to be checked again, and a stale verdict on fresh figures is
    // the thing the draft digest exists to prevent.
    expect(stored.checkedAt).toBeNull();
    expect(stored.checkDraftHash).toBeNull();
    expect(stored.firstApprovalId).toBeNull();
    // No second approver was asked. A rejection at the first seat must not
    // escalate to the second.
    expect(await pendingApproval(seeded.company.id)).toBeNull();
  });

  it("re-collects and re-checks a run that was sent back, through the sweeps", async () => {
    const seeded = await seed();
    const run = await presentedRun(seeded.company.id);
    const first = await pendingApproval(seeded.company.id);
    await call(
      approvalApp(boardActor(seeded.company.id, seeded.approverOne.principalId)),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/approvals/${first!.id}/reject`)
          .send({ ...decision(), decisionNote: "wrong table" }),
    );

    graphValues = [["Hours"], [388]];
    await deliverableRunService(db).sweepCollectingRuns();
    expect((await runRow(run.id)).status).toBe("assembled");
    await deliverableCheckService(db).sweepAssembledRuns();
    expect((await runRow(run.id)).status).toBe("checked");

    const values = await db.select().from(factValues).where(eq(factValues.runId, run.id));
    expect(JSON.stringify(values)).toContain("388");
  });
});
