import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agentFactRequests,
  agentRuntimeState,
  agentStewardships,
  agentWakeupRequests,
  agents,
  approvalComments,
  approvals,
  companies,
  companyMemberships,
  companySkills,
  connections,
  createDb,
  deliverableChecks,
  deliverableFacts,
  deliverableRuns,
  deliverables,
  factCorrections,
  factValues,
  heartbeatRunEvents,
  heartbeatRuns,
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
 * AgentDash-MK Slice G9 — the derivation record.
 *
 * The record is the **by-product** of producing the deliverable, never
 * something anybody writes down. Context that is authored goes stale; context
 * that is exhaust stays current, and that is the only version of this claim
 * that survived the evidence.
 *
 * Every served figure carries its age and its last confirmation, because a
 * human at the end catches errors but not wrong foundations: a stale premise
 * passes review silently, every time, and the only defence is that the
 * staleness travels with the number instead of being available beside it.
 *
 * Read-only, opt-in, and no enforcement claimed anywhere.
 */
describe("derivation record wiring", () => {
  it("serves the MCP resources from the real server", () => {
    const source = readFileSync(
      path.join(repoRoot, "packages/mcp-server/src/index.ts"),
      "utf8",
    );
    expect(
      source.includes("readAgentDashResource("),
      "readAgentDashResource has no non-test caller; the MCP resources are unreachable",
    ).toBe(true);
    expect(source.includes("RESOURCE_TEMPLATES")).toBe(true);
  });
});

describeEmbeddedPostgres("agentdash-mk derivation record", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  let msServer: Server | null = null;
  let msBaseUrl = "";
  const savedEnv: Record<string, string | undefined> = {};
  let graphValues: unknown[][] = [["Hours"], [412]];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mk-deliv-rec-");
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

  async function seed(opts: { secondDeliverable?: boolean } = {}) {
    const company = await db
      .insert(companies)
      .values({
        name: `Record ${randomUUID()}`,
        issuePrefix: `RC${randomUUID().slice(0, 6).toUpperCase()}`,
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

    await agentStewardshipService(db).assign(company.id, {
      agentId: producer.id,
      userId: producerSteward.principalId,
      assignedByUserId: owner.principalId,
    });
    await sharepointConnectorService(db).connect(
      company.id,
      producerSteward.principalId,
      "assert-producer",
    );

    const admin = createApp(
      (app) => app.use("/api", deliverableRoutes(db)),
      boardActor(company.id, owner.principalId, true),
    );

    async function defineDeliverable(key: string) {
      await call(admin, (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${company.id}/deliverables`)
          .send({
            key,
            name: `Deliverable ${key}`,
            cadence: "weekly",
            assemblerAgentId: assembler.id,
            firstApproverUserId: approverOne.principalId,
            secondApproverUserId: approverTwo.principalId,
          }),
      );
      await call(admin, (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${company.id}/deliverables/${key}/facts`)
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
    }

    await defineDeliverable(DELIVERABLE_KEY);
    if (opts.secondDeliverable) await defineDeliverable("monthly-board-packet");

    return { company, owner, producerSteward, approverOne, approverTwo, assembler, producer, admin };
  }

  /** Carry a cycle all the way to shipped, through the real routes. */
  async function shippedRun(seeded: Awaited<ReturnType<typeof seed>>) {
    const runs = deliverableRunService(db);
    const { run } = await runs.openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });
    await runs.assemble(seeded.company.id, run.id);
    await deliverableCheckService(db).runChecks(seeded.company.id, run.id);
    await deliverableReviewService(db).present(seeded.company.id, run.id);

    for (const [userId] of [
      [seeded.approverOne.principalId],
      [seeded.approverTwo.principalId],
    ]) {
      const pending = await db
        .select()
        .from(approvals)
        .where(eq(approvals.status, "pending"))
        .then((rows) => rows[0]!);
      const res = await call(
        createApp((app) => app.use("/api", approvalRoutes(db)), boardActor(seeded.company.id, userId!)),
        (baseUrl) =>
          request(baseUrl)
            .post(`/api/approvals/${pending.id}/approve`)
            .send({ revision: 1, idempotencyKey: `web-${randomUUID()}`, channel: "web" }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }

    const stored = await db
      .select()
      .from(deliverableRuns)
      .where(eq(deliverableRuns.id, run.id))
      .then((rows) => rows[0]!);
    expect(stored.status).toBe("shipped");
    return run;
  }

  // -- G9: the record -------------------------------------------------------

  it("serves one fact's derivation with its age and who last confirmed it", async () => {
    const seeded = await seed();
    await shippedRun(seeded);

    const res = await call(
      createApp(
        (app) => app.use("/api", deliverableRoutes(db)),
        boardActor(seeded.company.id, seeded.approverOne.principalId),
      ),
      (baseUrl) =>
        request(baseUrl).get(
          `/api/companies/${seeded.company.id}/fact-records/labour.hours_booked`,
        ),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.factKey).toBe("labour.hours_booked");
    expect(res.body.derivation).toContain("WeeklyHours");
    expect(JSON.stringify(res.body.current.value)).toContain("412");
    // The exact call, not a summary of it.
    expect(res.body.current.sourceRef).toContain("site-1");
    expect(res.body.current.method).toContain("sharepoint");

    // A human at the end catches errors but not wrong foundations, so the age
    // and the last confirmation travel WITH the number rather than beside it.
    expect(typeof res.body.current.ageSeconds).toBe("number");
    expect(res.body.current.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(res.body.lastConfirmedBy, "a figure was served with nobody having confirmed it")
      .not.toBeNull();
    expect(res.body.lastConfirmedBy.userId).toBe(seeded.approverTwo.principalId);
    expect(res.body.lastConfirmedBy.stage).toBe("second");
    expect(res.body.runKey).toBe("2026-W31");

    // Said plainly, in the payload a harness reads. Nothing verifies that this
    // was read and we must not imply otherwise.
    expect(String(res.body.disclaimer).toLowerCase()).toContain("read-only");
    expect(String(res.body.disclaimer)).toMatch(/not (a )?polic|nothing verifies|no enforcement/i);
  });

  it("serves the last shipped cycle with provenance and age on every figure", async () => {
    const seeded = await seed();
    await shippedRun(seeded);

    const res = await call(
      createApp(
        (app) => app.use("/api", deliverableRoutes(db)),
        boardActor(seeded.company.id, seeded.approverOne.principalId),
      ),
      (baseUrl) =>
        request(baseUrl).get(
          `/api/companies/${seeded.company.id}/deliverables/${DELIVERABLE_KEY}/latest`,
        ),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.runKey).toBe("2026-W31");
    expect(res.body.facts).toHaveLength(1);
    expect(res.body.facts[0].sourceRef).toContain("WeeklyHours");
    expect(typeof res.body.facts[0].ageSeconds).toBe("number");
    expect(res.body.approvals.first.userId).toBe(seeded.approverOne.principalId);
    expect(res.body.approvals.second.userId).toBe(seeded.approverTwo.principalId);
    expect(String(res.body.disclaimer).toLowerCase()).toContain("read-only");
  });

  it("serves nothing from a cycle that has not shipped", async () => {
    const seeded = await seed();
    const runs = deliverableRunService(db);
    const { run } = await runs.openRun(seeded.company.id, DELIVERABLE_KEY, {
      at: new Date("2026-07-30T09:00:00Z"),
    });
    await runs.assemble(seeded.company.id, run.id);

    const res = await call(
      createApp(
        (app) => app.use("/api", deliverableRoutes(db)),
        boardActor(seeded.company.id, seeded.approverOne.principalId),
      ),
      (baseUrl) =>
        request(baseUrl).get(
          `/api/companies/${seeded.company.id}/fact-records/labour.hours_booked`,
        ),
    );
    // A figure two people have not signed off is not the answer to "where does
    // this number come from"; it is a draft. Serving it would make the record
    // report figures nobody stood behind.
    expect(res.status).toBe(200);
    expect(res.body.current, JSON.stringify(res.body)).toBeNull();
    expect(res.body.derivation).toContain("WeeklyHours");
  });

  it("carries a fact's corrections into its record", async () => {
    const seeded = await seed();
    await shippedRun(seeded);
    const run = await db.select().from(deliverableRuns).then((rows) => rows[0]!);

    await call(
      createApp(
        (app) => app.use("/api", deliverableRoutes(db)),
        boardActor(seeded.company.id, seeded.approverOne.principalId),
      ),
      (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${seeded.company.id}/deliverable-runs/${run.id}/corrections`)
          .send({
            factKey: "labour.hours_booked",
            correction: { kind: "annotate", note: "excludes contractor hours since June" },
            reason: "the source double-counts contractors",
          }),
    );

    const res = await call(
      createApp(
        (app) => app.use("/api", deliverableRoutes(db)),
        boardActor(seeded.company.id, seeded.approverTwo.principalId),
      ),
      (baseUrl) =>
        request(baseUrl).get(
          `/api/companies/${seeded.company.id}/fact-records/labour.hours_booked`,
        ),
    );
    expect(res.body.corrections).toHaveLength(1);
    expect(res.body.corrections[0].active).toBe(true);
    expect(JSON.stringify(res.body.corrections[0])).toContain("contractor hours");
    // The correction is about the FACT. The record does not say whose figure
    // was wrong, because nothing in the table can answer that.
    expect(JSON.stringify(res.body.corrections[0])).not.toContain(
      seeded.approverOne.principalId,
    );
  });

  it("refuses to guess when one fact key belongs to two deliverables", async () => {
    const seeded = await seed({ secondDeliverable: true });

    const res = await call(
      createApp(
        (app) => app.use("/api", deliverableRoutes(db)),
        boardActor(seeded.company.id, seeded.approverOne.principalId),
      ),
      (baseUrl) =>
        request(baseUrl).get(
          `/api/companies/${seeded.company.id}/fact-records/labour.hours_booked`,
        ),
    );
    // Picking one would be picking the wrong number some of the time, and which
    // time is unknowable from here — the same refusal as an ambiguous worksheet.
    expect(res.status, "the record picked one of two candidate facts").toBe(409);
    expect(JSON.stringify(res.body)).toContain(DELIVERABLE_KEY);
    expect(JSON.stringify(res.body)).toContain("monthly-board-packet");

    const disambiguated = await call(
      createApp(
        (app) => app.use("/api", deliverableRoutes(db)),
        boardActor(seeded.company.id, seeded.approverOne.principalId),
      ),
      (baseUrl) =>
        request(baseUrl).get(
          `/api/companies/${seeded.company.id}/fact-records/${DELIVERABLE_KEY}%2Flabour.hours_booked`,
        ),
    );
    expect(disambiguated.status, JSON.stringify(disambiguated.body)).toBe(200);
    expect(disambiguated.body.deliverableKey).toBe(DELIVERABLE_KEY);
  });

  it("404s the record routes outside the mk profile", async () => {
    const company = await db
      .insert(companies)
      .values({
        name: `Plain ${randomUUID()}`,
        issuePrefix: `PL${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: "default",
      })
      .returning()
      .then((rows) => rows[0]!);
    const member = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: randomUUID(),
        status: "active",
        membershipRole: "owner",
      })
      .returning()
      .then((rows) => rows[0]!);

    const res = await call(
      createApp(
        (app) => app.use("/api", deliverableRoutes(db)),
        boardActor(company.id, member.principalId, true),
      ),
      (baseUrl) => request(baseUrl).get(`/api/companies/${company.id}/fact-records/anything`),
    );
    expect(res.status, "a profile-only route answered 403 instead of 404").toBe(404);
  });

  it("refuses a record read from another company", async () => {
    const first = await seed();
    const second = await seed();
    await shippedRun(first);

    const res = await call(
      createApp(
        (app) => app.use("/api", deliverableRoutes(db)),
        boardActor(second.company.id, second.approverOne.principalId),
      ),
      (baseUrl) =>
        request(baseUrl).get(
          `/api/companies/${first.company.id}/fact-records/labour.hours_booked`,
        ),
    );
    expect(res.status, "a derivation record crossed a company boundary").toBe(403);
  });
});
