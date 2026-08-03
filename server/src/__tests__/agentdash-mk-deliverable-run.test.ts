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
import { agentFactRequestRoutes } from "../routes/agent-fact-requests.js";
import { deliverableRoutes } from "../routes/deliverables.js";
import { agentFactRequestService } from "../services/agent-fact-requests.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { deliverableRunService, runKeyFor } from "../services/deliverable-runs.js";
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
 * AgentDash-MK Slice G2 — a run opens, collects, and assembles.
 *
 * The collection mechanism is the design commitment, not an implementation
 * detail: **whatever can be fetched is fetched, whatever cannot is asked for.**
 * A `system` fact is read through the owning person's own on-behalf-of identity;
 * a `human` fact becomes one specific agent-to-agent request, which the owning
 * agent answers, declines, or escalates to its steward's harness. Nothing here
 * tries to replace how anybody produces their number — it triggers whatever
 * they already do and collects the result in one place with provenance on it.
 *
 * Retrieval-versus-reconstruction is therefore a dial. A deliverable made
 * entirely of `human` facts still runs; it just costs more attention, and the
 * measurement substrate is what says how much.
 *
 * Every network boundary is mocked. These tests prove OUR collection, OUR
 * provenance, and OUR handling of a fact nobody supplied. They prove nothing
 * about Microsoft Graph.
 */
describe("run key derivation", () => {
  it("labels a weekly cycle by its ISO week and a monthly one by its month", () => {
    // Thursday 2026-07-30 falls in ISO week 31 of 2026.
    expect(runKeyFor("weekly", new Date("2026-07-30T09:00:00Z"))).toBe("2026-W31");
    expect(runKeyFor("monthly", new Date("2026-07-30T09:00:00Z"))).toBe("2026-07");
  });

  it("keeps a whole ISO week under one label", () => {
    // Monday through Sunday of ISO week 31, 2026.
    const week = [
      "2026-07-27T00:00:00Z",
      "2026-07-29T12:00:00Z",
      "2026-08-02T23:59:00Z",
    ].map((iso) => runKeyFor("weekly", new Date(iso)));
    expect(new Set(week).size, "one calendar week produced more than one run key").toBe(1);
    expect(week[0]).toBe("2026-W31");
  });

  it("puts a year-straddling week in the year that owns it", () => {
    // 2027-01-01 is a Friday, so ISO week 53 of 2026 — not week 1 of 2027.
    // Getting this wrong opens a duplicate run every New Year.
    expect(runKeyFor("weekly", new Date("2027-01-01T09:00:00Z"))).toBe("2026-W53");
  });
});

/** G1g. A scheduler nothing calls is a comment about scheduling. */
describe("deliverable scheduler wiring", () => {
  it("ticks the due-run sweep from server startup", () => {
    const entrypoint = readFileSync(path.join(repoRoot, "server/src/index.ts"), "utf8");
    expect(
      entrypoint.includes("sweepDueDeliverableRuns("),
      "sweepDueDeliverableRuns has no non-test caller; no run ever opens on schedule",
    ).toBe(true);
  });
});

describeEmbeddedPostgres("agentdash-mk deliverable run", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let msServer: Server | null = null;
  let msBaseUrl = "";
  const savedEnv: Record<string, string | undefined> = {};

  let graphCalls: Array<{ method: string; path: string; authorization: string }> = [];
  let graphHandler: (path: string, bearer: string) => { status: number; body: unknown };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mk-deliv-run-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    __resetEntraOboCache();
    __resetSharepointLimiterState();
    graphCalls = [];
    graphHandler = () => ({ status: 200, body: {} });

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
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const graphPath = req.originalUrl.slice("/graph".length);
      graphCalls.push({ method: req.method, path: graphPath, authorization: bearer });
      const { status, body } = graphHandler(graphPath, bearer);
      res.status(status).json(body);
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

  // -- fixtures -------------------------------------------------------------

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

  function createApp(
    mount: (app: express.Express) => void,
    actor: Record<string, unknown>,
  ) {
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

  const DELIVERABLE_KEY = "weekly-project-review";

  /**
   * The whole cast: an assembling agent, a producing agent whose steward owns
   * the numbers, two approvers, and a real SharePoint identity established
   * through `connect()`.
   *
   * Nothing hand-builds a connection row. This repository has a documented
   * incident where HubSpot was broken for every real user while its tests built
   * connection rows around the production path (G3g).
   */
  async function seed(opts: { withConnection?: boolean } = {}) {
    const company = await db
      .insert(companies)
      .values({
        name: `Run ${randomUUID()}`,
        issuePrefix: `RN${randomUUID().slice(0, 6).toUpperCase()}`,
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
    const bystander = await agent(`Bystander ${randomUUID().slice(0, 6)}`);

    const stewardships = agentStewardshipService(db);
    await stewardships.assign(company.id, {
      agentId: producer.id,
      userId: producerSteward.principalId,
      assignedByUserId: owner.principalId,
    });

    if (opts.withConnection !== false) {
      graphHandler = () => ({ status: 200, body: { userPrincipalName: "producer@mk.test" } });
      await sharepointConnectorService(db).connect(
        company.id,
        producerSteward.principalId,
        "assert-producer",
      );
      graphCalls = [];
    }

    const admin = createApp(
      (app) => app.use("/api", deliverableRoutes(db)),
      boardActor(company.id, owner.principalId, true),
    );

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
          orderIndex: 0,
        }),
    );
    await call(admin, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${company.id}/deliverables/${DELIVERABLE_KEY}/facts`)
        .send({
          key: "risk.narrative",
          label: "This week's risks",
          sourceType: "human",
          derivation: "The project lead's own read, in their own words.",
          ownerAgentId: producer.id,
          orderIndex: 1,
        }),
    );

    return {
      company,
      owner,
      producerSteward,
      approverOne,
      approverTwo,
      assembler,
      producer,
      bystander,
      admin,
    };
  }

  /** Graph answers the workbook range as the identity in the bearer token. */
  function workbookReturns(values: unknown[][]) {
    graphHandler = (graphPath) => {
      if (graphPath.includes("/workbook/tables/")) {
        return {
          status: 200,
          body: { address: "Sheet1!A1:B2", values, rowCount: values.length, columnCount: 2 },
        };
      }
      return { status: 404, body: { error: { code: "itemNotFound" } } };
    };
  }

  function runs(db_: TestDb, companyId: string) {
    return db_.select().from(deliverableRuns).where(eq(deliverableRuns.companyId, companyId));
  }

  async function valuesByFactKey(runId: string) {
    const rows = await db
      .select({
        key: deliverableFacts.key,
        value: factValues.value,
        status: factValues.status,
        sourceRef: factValues.sourceRef,
        method: factValues.method,
        fetchedAt: factValues.fetchedAt,
        flagged: factValues.flagged,
        flagReason: factValues.flagReason,
        answeredByAgentId: factValues.answeredByAgentId,
      })
      .from(factValues)
      .innerJoin(deliverableFacts, eq(factValues.factId, deliverableFacts.id))
      .where(eq(factValues.runId, runId));
    return Object.fromEntries(rows.map((row) => [row.key, row]));
  }

  // -- G2: opens on schedule ------------------------------------------------

  it("opens exactly one run per cycle from the scheduler, and does not open a second", async () => {
    const seeded = await seed();
    workbookReturns([["Hours"], [412]]);

    const svc = deliverableRunService(db);
    const at = new Date("2026-07-30T09:00:00Z");
    const first = await svc.sweepDueDeliverableRuns(at);
    expect(first.opened, "the scheduler opened no run").toBe(1);

    const second = await svc.sweepDueDeliverableRuns(at);
    // Two schedulers ticking together, or one retrying, must not produce two
    // cycles — the unique index is what makes this idempotent without a lock.
    expect(second.opened, "the scheduler opened the same cycle twice").toBe(0);

    const openRuns = await runs(db, seeded.company.id);
    expect(openRuns).toHaveLength(1);
    expect(openRuns[0]!.runKey).toBe("2026-W31");
    expect(openRuns[0]!.status).toBe("collecting");
  });

  it("opens the next cycle's run when the calendar moves on", async () => {
    const seeded = await seed();
    workbookReturns([["Hours"], [412]]);
    const svc = deliverableRunService(db);

    await svc.sweepDueDeliverableRuns(new Date("2026-07-30T09:00:00Z"));
    await svc.sweepDueDeliverableRuns(new Date("2026-08-06T09:00:00Z"));

    const keys = (await runs(db, seeded.company.id)).map((row) => row.runKey).sort();
    expect(keys).toEqual(["2026-W31", "2026-W32"]);
  });

  it("opens no run for a paused deliverable", async () => {
    const seeded = await seed();
    await db
      .update(deliverables)
      .set({ status: "paused" })
      .where(eq(deliverables.companyId, seeded.company.id));

    const swept = await deliverableRunService(db).sweepDueDeliverableRuns(
      new Date("2026-07-30T09:00:00Z"),
    );
    expect(swept.opened).toBe(0);
    expect(await runs(db, seeded.company.id)).toHaveLength(0);
  });

  // -- G2: collects what it can fetch ---------------------------------------

  it("fetches a system fact through the owner's own identity and records the exact call", async () => {
    const seeded = await seed();
    workbookReturns([["Hours"], [412]]);

    const svc = deliverableRunService(db);
    const { run } = await svc.openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });

    const byKey = await valuesByFactKey(run.id);
    const hours = byKey["labour.hours_booked"]!;
    expect(hours.status, JSON.stringify(hours)).toBe("fetched");
    expect(JSON.stringify(hours.value)).toContain("412");

    // A value with no provenance is a bug, not a degraded case. The source ref
    // is the exact call: the site, the item, and the named table that was read.
    expect(hours.sourceRef).toContain("site-1");
    expect(hours.sourceRef).toContain("item-1");
    expect(hours.sourceRef).toContain("WeeklyHours");
    expect(hours.method).toContain("sharepoint");
    expect(hours.fetchedAt).not.toBeNull();
    expect(hours.flagged).toBe(false);

    // Read as the producer's steward, not as an application. This is the whole
    // OBO argument made mechanical: the mock answers whichever token is
    // presented, so presenting the wrong one would return the wrong documents.
    const workbookCall = graphCalls.find((c) => c.path.includes("/workbook/tables/"));
    expect(workbookCall, "nothing ever reached Graph").toBeDefined();
    expect(workbookCall!.method).toBe("GET");
    expect(workbookCall!.authorization).toBe("graph-token-for:assert-producer");
  });

  it("marks a fact missing and flagged when the connector refuses, never guessing", async () => {
    const seeded = await seed();
    // The workbook is gone. There is deliberately no fallback that returns
    // "whatever occupies the top-left": a wrong number that looks right is far
    // worse than an error, because the error gets fixed and the number gets
    // believed.
    graphHandler = () => ({ status: 404, body: { error: { code: "itemNotFound" } } });

    const { run } = await deliverableRunService(db).openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });

    const hours = (await valuesByFactKey(run.id))["labour.hours_booked"]!;
    expect(hours.status).toBe("missing");
    expect(hours.flagged, "a fact the connector refused was not flagged").toBe(true);
    expect(hours.flagReason).toContain("target_not_found");
    expect(hours.value, "a refused fetch invented a value").toBeNull();
  });

  it("refuses at the database to store a fetched value with no provenance", async () => {
    // THE ADVERSARIAL CASE, attempted rather than asserted. A row written by
    // anything other than the collector — a later slice, a migration, a psql
    // session — must not be able to park a figure nobody can trace where an
    // approver will read it as checked.
    const seeded = await seed();
    workbookReturns([["Hours"], [412]]);
    const { run } = await deliverableRunService(db).openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });
    const fact = await db
      .select()
      .from(deliverableFacts)
      .where(eq(deliverableFacts.key, "risk.narrative"))
      .then((rows) => rows[0]!);

    let refusal: unknown = null;
    try {
      await db
        .update(factValues)
        .set({ status: "answered", value: { text: "everything is fine" }, sourceRef: null })
        .where(and(eq(factValues.runId, run.id), eq(factValues.factId, fact.id)));
    } catch (error) {
      refusal = error;
    }
    expect(refusal, "the database accepted a figure with no provenance").not.toBeNull();
    const cause = (refusal as { cause?: { constraint_name?: string } }).cause;
    expect(cause?.constraint_name).toBe("fact_values_provenance_ck");
  });

  // -- G2: asks for what it cannot fetch ------------------------------------

  it("asks the owning agent for a human fact, once, through the real request path", async () => {
    const seeded = await seed();
    workbookReturns([["Hours"], [412]]);

    const svc = deliverableRunService(db);
    const { run } = await svc.openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });

    const asks = await db.select().from(agentFactRequests);
    expect(asks, "the human fact was never asked for").toHaveLength(1);
    expect(asks[0]!.factKey).toBe("risk.narrative");
    expect(asks[0]!.requestedByAgentId).toBe(seeded.assembler.id);
    expect(asks[0]!.targetAgentId).toBe(seeded.producer.id);
    expect(asks[0]!.runId).toBe(run.id);
    expect(asks[0]!.pipelineId).toBe(`deliverable:${DELIVERABLE_KEY}`);
    // Trigger, not automate: the question names the figure and the derivation,
    // so the person is prompted to do whatever they already do.
    expect(asks[0]!.question).toContain("This week's risks");

    // Collecting again must not ask a second time. A person asked the same
    // question twice in one cycle stops answering, and this design is a bet on
    // them continuing to.
    const workbookCallsAfterOpen = graphCalls.filter((c) =>
      c.path.includes("/workbook/tables/"),
    ).length;
    expect(workbookCallsAfterOpen).toBe(1);

    await svc.collect(seeded.company.id, run.id);
    expect(await db.select().from(agentFactRequests)).toHaveLength(1);
    // And must not re-read a figure that already landed. The fact-request table
    // deduplicates the ask by unique index whatever this service does, but
    // nothing outside this service stops a second connector fetch — a value
    // that silently changed between the collection and the check is exactly
    // what the check's draft digest exists to catch, and the cheapest place to
    // not do it is here.
    expect(
      graphCalls.filter((c) => c.path.includes("/workbook/tables/")),
      "a settled figure was fetched a second time",
    ).toHaveLength(1);
  });

  it("stalls assembly while a human fact is outstanding, and completes when it lands", async () => {
    const seeded = await seed();
    workbookReturns([["Hours"], [412]]);
    const svc = deliverableRunService(db);
    const { run } = await svc.openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });

    const stalled = await svc.assemble(seeded.company.id, run.id);
    expect(stalled.assembled, "a run assembled with an unanswered question in it").toBe(false);
    expect(stalled.pending).toEqual(["risk.narrative"]);
    expect(
      (await runs(db, seeded.company.id))[0]!.status,
      "a stalled run left `collecting`",
    ).toBe("collecting");

    // Answered through the real fact-request route by the agent that was asked.
    const ask = (await db.select().from(agentFactRequests))[0]!;
    const factApp = createApp(
      (app) => app.use("/api", agentFactRequestRoutes(db)),
      agentActor(seeded.company.id, seeded.producer.id),
    );
    const answered = await call(factApp, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${seeded.company.id}/fact-requests/${ask.id}/answer`)
        .send({ answer: "Two schedule risks on the west wing.", sourceKind: "human" }),
    );
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);

    const assembled = await svc.assemble(seeded.company.id, run.id);
    expect(assembled.assembled, JSON.stringify(assembled)).toBe(true);
    expect((await runs(db, seeded.company.id))[0]!.status).toBe("assembled");

    const narrative = (await valuesByFactKey(run.id))["risk.narrative"]!;
    expect(narrative.status).toBe("answered");
    expect(JSON.stringify(narrative.value)).toContain("west wing");
    // Still framed. The answer travelled from another agent, and a deliverable
    // is not a place where that stops being true.
    expect(JSON.stringify(narrative.value)).toContain("untrusted-agent-answer");
    expect(narrative.answeredByAgentId).toBe(seeded.producer.id);
    expect(narrative.sourceRef).toContain(ask.id);
    expect(narrative.method).toContain("human");
  });

  it("marks a lapsed escalation missing and flagged, and assembles around the hole", async () => {
    const seeded = await seed();
    workbookReturns([["Hours"], [412]]);
    const svc = deliverableRunService(db);
    const { run } = await svc.openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });

    const ask = (await db.select().from(agentFactRequests))[0]!;
    const factApp = createApp(
      (app) => app.use("/api", agentFactRequestRoutes(db)),
      agentActor(seeded.company.id, seeded.producer.id),
    );
    await call(factApp, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${seeded.company.id}/fact-requests/${ask.id}/escalate`)
        .send({}),
    );
    // Wind the lease back rather than waiting it out.
    await db
      .update(agentFactRequests)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(agentFactRequests.id, ask.id));
    expect(await agentFactRequestService(db).sweepExpiredFactLeases()).toBe(1);

    const assembled = await svc.assemble(seeded.company.id, run.id);
    expect(assembled.assembled, "a lapsed lease blocked the cycle forever").toBe(true);

    const narrative = (await valuesByFactKey(run.id))["risk.narrative"]!;
    // Never silently dropped. A deliverable that says where the hole is gets
    // corrected; one with an unmarked hole gets believed.
    expect(narrative.status).toBe("missing");
    expect(narrative.flagged).toBe(true);
    expect(narrative.flagReason).toContain("missing");
    expect(narrative.value).toBeNull();
  });

  it("marks a declined fact missing and flagged rather than absent", async () => {
    const seeded = await seed();
    workbookReturns([["Hours"], [412]]);
    const svc = deliverableRunService(db);
    const { run } = await svc.openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });

    const ask = (await db.select().from(agentFactRequests))[0]!;
    await call(
      createApp(
        (app) => app.use("/api", agentFactRequestRoutes(db)),
        agentActor(seeded.company.id, seeded.producer.id),
      ),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/fact-requests/${ask.id}/decline`)
          .send({ reason: "nobody produced that this week" }),
    );

    expect((await svc.assemble(seeded.company.id, run.id)).assembled).toBe(true);
    const narrative = (await valuesByFactKey(run.id))["risk.narrative"]!;
    expect(narrative.status).toBe("missing");
    expect(narrative.flagged).toBe(true);
    expect(narrative.flagReason).toContain("declined");
  });

  // -- measurement ----------------------------------------------------------

  it("measures the cycle without recording who was involved in it", async () => {
    const seeded = await seed();
    workbookReturns([["Hours"], [412]]);
    const svc = deliverableRunService(db);
    const { run } = await svc.openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });

    const ask = (await db.select().from(agentFactRequests))[0]!;
    await call(
      createApp(
        (app) => app.use("/api", agentFactRequestRoutes(db)),
        agentActor(seeded.company.id, seeded.producer.id),
      ),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/fact-requests/${ask.id}/answer`)
          .send({ answer: "Two schedule risks.", sourceKind: "human" }),
    );
    await svc.assemble(seeded.company.id, run.id);

    const events = await db
      .select()
      .from(workflowEvents)
      .where(eq(workflowEvents.runId, run.id));
    const types = new Set(events.map((event) => event.eventType));
    expect(types.has("fact_asked"), "the ask was not measured").toBe(true);
    expect(types.has("fact_answered"), "the answer was not measured").toBe(true);
    expect(types.has("step_completed"), "the cycle's steps were not measured").toBe(true);
    expect(events.every((event) => event.pipelineId === `deliverable:${DELIVERABLE_KEY}`)).toBe(
      true,
    );

    // The events record what kind of actor acted, never which one. An agent is
    // bound 1:1 to a steward, so an agent id is a person one join later.
    const serialized = JSON.stringify(events);
    for (const identifier of [
      seeded.producer.id,
      seeded.assembler.id,
      seeded.producerSteward.principalId,
      seeded.approverOne.principalId,
    ]) {
      expect(serialized, "a person or an agent reached the measurement substrate").not.toContain(
        identifier,
      );
    }
  });

  // -- routes and boundaries ------------------------------------------------

  it("lets the assembling agent drive its own run through the routes", async () => {
    const seeded = await seed();
    workbookReturns([["Hours"], [412]]);
    const { run } = await deliverableRunService(db).openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });
    const ask = (await db.select().from(agentFactRequests))[0]!;
    await call(
      createApp(
        (app) => app.use("/api", agentFactRequestRoutes(db)),
        agentActor(seeded.company.id, seeded.producer.id),
      ),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/fact-requests/${ask.id}/answer`)
          .send({ answer: "Two schedule risks.", sourceKind: "human" }),
    );

    const assemblerApp = createApp(
      (app) => app.use("/api", deliverableRoutes(db)),
      agentActor(seeded.company.id, seeded.assembler.id),
    );
    const res = await call(assemblerApp, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${seeded.company.id}/deliverable-runs/${run.id}/assemble`)
        .send({}),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.assembled).toBe(true);
  });

  it("refuses assembly from an agent that is not this deliverable's assembler", async () => {
    const seeded = await seed();
    workbookReturns([["Hours"], [412]]);
    const { run } = await deliverableRunService(db).openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });

    const res = await call(
      createApp(
        (app) => app.use("/api", deliverableRoutes(db)),
        agentActor(seeded.company.id, seeded.bystander.id),
      ),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/deliverable-runs/${run.id}/assemble`)
          .send({}),
    );
    expect(res.status, "any agent could assemble anyone's deliverable").toBe(403);
  });

  it("shows the run and its provenance to the company", async () => {
    const seeded = await seed();
    workbookReturns([["Hours"], [412]]);
    const { run } = await deliverableRunService(db).openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });

    const res = await call(
      createApp(
        (app) => app.use("/api", deliverableRoutes(db)),
        boardActor(seeded.company.id, seeded.approverOne.principalId),
      ),
      (baseUrl) =>
        request(baseUrl).get(`/api/companies/${seeded.company.id}/deliverable-runs/${run.id}`),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.runKey).toBe("2026-W31");
    const hours = res.body.values.find((v: any) => v.factKey === "labour.hours_booked");
    expect(hours.provenance.sourceRef).toContain("WeeklyHours");
    expect(hours.provenance.method).toContain("sharepoint");
  });
});
