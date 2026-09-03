import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  bridgeEndpoints,
  bridgeTasks,
  channelCallbackTokens,
  companies,
  companyMemberships,
  createDb,
  stewardInboxEvents,
  stewardInboxSequences,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { bridgeRoutes } from "../routes/bridge.js";
import { agentService } from "../services/index.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { bridgeService } from "../services/bridge.js";
import { stewardInboxDecisionService } from "../services/steward-inbox-decisions.js";
import { companyService } from "../services/companies.js";
import { stewardInboxService, STEWARD_INBOX_CAPABILITY } from "../services/steward-inbox.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const repoRoot = path.resolve(import.meta.dirname, "../../..");

/**
 * AgentDash-MK: the steward inbox, stages 1 and 2.
 *
 * The property these tests defend, in one line: **an update that was recorded
 * is delivered exactly once and cannot be skipped.** Everything below is some
 * consequence of that — gap-free positions so `seq > cursor` is exact, a
 * cursor that only a client can advance, and a clamp so no client can
 * acknowledge its way past events it never saw.
 */

describe("steward inbox caller existence", () => {
  /**
   * The lesson from Teams delivery, applied before it can be repeated: a
   * function only its own tests call has never run in production, and coverage
   * on it says nothing. Read from disk so deleting the caller fails here.
   */
  function sourceFilesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const absolute = path.join(dir, entry);
      if (statSync(absolute).isDirectory()) {
        if (entry === "__tests__" || entry === "node_modules") continue;
        out.push(...sourceFilesUnder(absolute));
        continue;
      }
      if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(absolute);
    }
    return out;
  }

  const definingFile = path.join(repoRoot, "server/src/services/steward-inbox.ts");

  it.each(["recordApprovalEvent", "syncForEndpoint", "acknowledge"])(
    "%s is called from production code outside its own module",
    (fnName) => {
      const callers = sourceFilesUnder(path.join(repoRoot, "server/src"))
        .filter((file) => file !== definingFile)
        .filter((file) => new RegExp(`\\.${fnName}\\s*\\(`).test(readFileSync(file, "utf8")))
        .map((file) => path.relative(repoRoot, file));
      expect(
        callers,
        `${fnName} has no non-test caller; it is tested code that has never run`,
      ).not.toHaveLength(0);
    },
  );

  /**
   * Stage 2 is a widening of a security boundary, so the boundary is asserted
   * from its source rather than described in prose. The three original routes
   * must survive; the two new ones must be present and nothing else added.
   */
  /**
   * The digest and the board's decision surface must rank the same approval the
   * same way. Two copies of a ranking drift silently -- nobody notices until
   * the surfaces disagree about what is urgent, and by then each has users who
   * trust it. Read from disk so a reintroduced copy fails here.
   */
  it("keeps exactly one approval risk classifier", () => {
    const files = sourceFilesUnder(path.join(repoRoot, "server/src"));
    const definers = files
      .filter((file) => /function summarizeApprovalRisk|function summarizeRisk/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(repoRoot, file));
    expect(definers).toEqual(["server/src/services/approval-risk.ts"]);

    // And both surfaces reach for it.
    for (const consumer of [
      "server/src/routes/agentdash-mk-inbox.ts",
      "server/src/services/steward-inbox.ts",
    ]) {
      expect(
        readFileSync(path.join(repoRoot, consumer), "utf8"),
        `${consumer} should use the shared classifier`,
      ).toContain("summarizeApprovalRisk");
    }
  });

  it("widens the bridge route allowlist by exactly the three inbox routes", () => {
    const source = readFileSync(path.join(repoRoot, "server/src/middleware/auth.ts"), "utf8");
    const block = source.match(/const BRIDGE_ENDPOINT_ROUTES = new Set\(\[([\s\S]*?)\]\);/);
    expect(block, "BRIDGE_ENDPOINT_ROUTES must remain a literal set").toBeTruthy();
    const routes = [...block![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(routes.sort()).toEqual(
      [
        "/api/bridge/poll",
        "/api/bridge/result",
        "/api/bridge/decline",
        "/api/bridge/inbox/sync",
        "/api/bridge/inbox/ack",
        "/api/bridge/inbox/decide",
      ].sort(),
    );
  });
});

describeEmbeddedPostgres("agentdash-mk steward inbox", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mk-inbox-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // A full reset rather than an ordered delete list. Stage 3 fires the real
    // post-decision effects, and those reach far further than this suite's own
    // tables -- a wakeup writes heartbeat runs, runtime state and environment
    // leases; a connector_send approval writes an execution row; skills get
    // synced. Enumerating that chain here would make the teardown a second,
    // worse copy of the production deletion order, and every new effect would
    // break this file rather than the code it belongs to.
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(profile: "agentdash_mk" | "default" = "agentdash_mk") {
    const company = await db
      .insert(companies)
      .values({
        name: `Inbox ${randomUUID()}`,
        issuePrefix: `IB${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: profile,
      })
      .returning()
      .then((rows) => rows[0]!);
    const owner = await db
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
    const steward = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: randomUUID(),
        status: "active",
        membershipRole: "operator",
      })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: `Agent ${randomUUID().slice(0, 8)}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
      })
      .returning()
      .then((rows) => rows[0]!);
    await agentStewardshipService(db).assign(company.id, {
      agentId: agent.id,
      userId: steward.principalId,
      assignedByUserId: owner.principalId,
    });
    return { company, owner, steward, agent };
  }

  async function makeApproval(
    companyId: string,
    agentId: string | null,
    overrides: Partial<{ revision: number; status: string; type: string }> = {},
  ) {
    return db
      .insert(approvals)
      .values({
        companyId,
        type: overrides.type ?? "connector_send",
        requestedByAgentId: agentId,
        status: overrides.status ?? "pending",
        payload: { summary: "send the drafted note" },
        revision: overrides.revision ?? 1,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  /** An approved, inbox-capable endpoint belonging to `userId`. */
  async function makeEndpoint(
    companyId: string,
    userId: string,
    capabilities: string[] = ["bridge:read", STEWARD_INBOX_CAPABILITY],
  ) {
    return db
      .insert(bridgeEndpoints)
      .values({
        companyId,
        userId,
        label: `laptop-${randomUUID().slice(0, 8)}`,
        tokenHash: `hash-${randomUUID()}`,
        capabilities,
        enrolledAt: new Date(),
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function eventsFor(companyId: string, stewardUserId: string) {
    return db
      .select()
      .from(stewardInboxEvents)
      .where(eq(stewardInboxEvents.companyId, companyId))
      .orderBy(asc(stewardInboxEvents.seq))
      .then((rows) => rows.filter((row) => row.stewardUserId === stewardUserId));
  }

  // -----------------------------------------------------------------------
  // Stage 1: the durable log
  // -----------------------------------------------------------------------

  it("addresses an approval to the human who answers for the requesting agent", async () => {
    const { company, steward, agent } = await seed();
    const inbox = stewardInboxService(db);
    const approval = await makeApproval(company.id, agent.id);

    await inbox.recordApprovalEvent(approval.id, "approval.opened");

    const rows = await eventsFor(company.id, steward.principalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seq).toBe(1);
    expect(rows[0]!.kind).toBe("approval.opened");
    expect(rows[0]!.refType).toBe("approval");
    expect(rows[0]!.refId).toBe(approval.id);
    expect(rows[0]!.agentId).toBe(agent.id);
  });

  it("carries the pointer and the standing, never the approval payload", async () => {
    const { company, steward, agent } = await seed();
    const approval = await makeApproval(company.id, agent.id);
    await stewardInboxService(db).recordApprovalEvent(approval.id, "approval.opened");

    const rows = await eventsFor(company.id, steward.principalId);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload).toEqual({ approvalType: "connector_send", revision: 1, status: "pending" });
    // The approval's own payload said "send the drafted note". Nothing that
    // reaches a local AI client may carry it.
    expect(JSON.stringify(payload)).not.toContain("drafted note");
  });

  it("records one item however many times the same transition is replayed", async () => {
    const { company, steward, agent } = await seed();
    const inbox = stewardInboxService(db);
    const approval = await makeApproval(company.id, agent.id);

    await inbox.recordApprovalEvent(approval.id, "approval.opened");
    await inbox.recordApprovalEvent(approval.id, "approval.opened");
    await inbox.recordApprovalEvent(approval.id, "approval.opened");

    const rows = await eventsFor(company.id, steward.principalId);
    expect(rows).toHaveLength(1);
    // And the swallowed duplicates consumed no position, so the next event is 2.
    await inbox.recordApprovalEvent(approval.id, "approval.resolved");
    const after = await eventsFor(company.id, steward.principalId);
    expect(after.map((row) => row.seq)).toEqual([1, 2]);
  });

  it("treats a resubmitted revision as a new item, not a duplicate", async () => {
    const { company, steward, agent } = await seed();
    const inbox = stewardInboxService(db);
    const approval = await makeApproval(company.id, agent.id);
    await inbox.recordApprovalEvent(approval.id, "approval.opened");

    await db.update(approvals).set({ revision: 2 }).where(eq(approvals.id, approval.id));
    await inbox.recordApprovalEvent(approval.id, "approval.opened");

    const rows = await eventsFor(company.id, steward.principalId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => (row.payload as { revision: number }).revision)).toEqual([1, 2]);
  });

  it("keeps positions gap-free and unique under concurrent appends", async () => {
    const { company, steward } = await seed();
    const inbox = stewardInboxService(db);

    await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        inbox.appendEvent({
          companyId: company.id,
          stewardUserId: steward.principalId,
          kind: "approval.opened",
          refType: "approval",
          refId: randomUUID(),
          dedupeKey: `concurrent:${index}`,
        }),
      ),
    );

    const rows = await eventsFor(company.id, steward.principalId);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("records nothing outside the mk profile, and nothing for an unrouted approval", async () => {
    const plain = await seed("default");
    const inbox = stewardInboxService(db);
    const plainApproval = await makeApproval(plain.company.id, plain.agent.id);
    await inbox.recordApprovalEvent(plainApproval.id, "approval.opened");
    expect(await eventsFor(plain.company.id, plain.steward.principalId)).toHaveLength(0);

    // No requesting agent: administrator business, and there is no steward to
    // address it to.
    const mk = await seed();
    const unrouted = await makeApproval(mk.company.id, null);
    await inbox.recordApprovalEvent(unrouted.id, "approval.opened");
    expect(await eventsFor(mk.company.id, mk.steward.principalId)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Stage 1: cursor and delivery semantics
  // -----------------------------------------------------------------------

  it("accumulates while a machine is away and returns the backlog in order", async () => {
    const { company, steward, agent } = await seed();
    const inbox = stewardInboxService(db);
    const endpoint = await makeEndpoint(company.id, steward.principalId);

    for (let index = 0; index < 4; index += 1) {
      const approval = await makeApproval(company.id, agent.id);
      await inbox.recordApprovalEvent(approval.id, "approval.opened");
    }

    const synced = await inbox.syncForEndpoint(endpoint.id);
    expect(synced.lastAckedSeq).toBe(0);
    expect(synced.headSeq).toBe(4);
    expect(synced.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(synced.hasMore).toBe(false);
  });

  it("returns the identical set until the client says it applied them", async () => {
    const { company, steward, agent } = await seed();
    const inbox = stewardInboxService(db);
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const approval = await makeApproval(company.id, agent.id);
    await inbox.recordApprovalEvent(approval.id, "approval.opened");

    const first = await inbox.syncForEndpoint(endpoint.id);
    const second = await inbox.syncForEndpoint(endpoint.id);
    expect(second.events).toEqual(first.events);

    await inbox.acknowledge(endpoint.id, 1);
    const third = await inbox.syncForEndpoint(endpoint.id);
    expect(third.events).toHaveLength(0);
    expect(third.lastAckedSeq).toBe(1);
  });

  it("pages a long backlog and says there is more", async () => {
    const { company, steward } = await seed();
    const inbox = stewardInboxService(db);
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    for (let index = 0; index < 5; index += 1) {
      await inbox.appendEvent({
        companyId: company.id,
        stewardUserId: steward.principalId,
        kind: "approval.opened",
        refType: "approval",
        refId: randomUUID(),
        dedupeKey: `page:${index}`,
      });
    }

    const page = await inbox.syncForEndpoint(endpoint.id, { limit: 2 });
    expect(page.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(page.hasMore).toBe(true);
    expect(page.headSeq).toBe(5);
  });

  it("never moves a cursor backwards, and acking twice is not an error", async () => {
    const { company, steward } = await seed();
    const inbox = stewardInboxService(db);
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    for (let index = 0; index < 3; index += 1) {
      await inbox.appendEvent({
        companyId: company.id,
        stewardUserId: steward.principalId,
        kind: "approval.opened",
        refType: "approval",
        refId: randomUUID(),
        dedupeKey: `back:${index}`,
      });
    }

    expect(await inbox.acknowledge(endpoint.id, 3)).toEqual({ lastAckedSeq: 3 });
    expect(await inbox.acknowledge(endpoint.id, 3)).toEqual({ lastAckedSeq: 3 });
    // A replayed old sync must not un-see anything.
    expect(await inbox.acknowledge(endpoint.id, 1)).toEqual({ lastAckedSeq: 3 });
  });

  /**
   * The one way this design could lose an update, refused at the only place it
   * could happen. A client acknowledging position 999 would otherwise skip
   * every event up to 999 the moment they were written.
   */
  it("clamps an acknowledgement to the head so future events cannot be skipped", async () => {
    const { company, steward, agent } = await seed();
    const inbox = stewardInboxService(db);
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const first = await makeApproval(company.id, agent.id);
    await inbox.recordApprovalEvent(first.id, "approval.opened");

    expect(await inbox.acknowledge(endpoint.id, 999)).toEqual({ lastAckedSeq: 1 });

    const later = await makeApproval(company.id, agent.id);
    await inbox.recordApprovalEvent(later.id, "approval.opened");
    const synced = await inbox.syncForEndpoint(endpoint.id);
    expect(synced.events.map((event) => event.seq)).toEqual([2]);
  });

  it("gives each of a person's machines its own position", async () => {
    const { company, steward } = await seed();
    const inbox = stewardInboxService(db);
    const laptop = await makeEndpoint(company.id, steward.principalId);
    const desktop = await makeEndpoint(company.id, steward.principalId);
    await inbox.appendEvent({
      companyId: company.id,
      stewardUserId: steward.principalId,
      kind: "approval.opened",
      refType: "approval",
      refId: randomUUID(),
      dedupeKey: "two-machines",
    });

    await inbox.acknowledge(laptop.id, 1);
    expect((await inbox.syncForEndpoint(laptop.id)).events).toHaveLength(0);
    // The desktop was off. It has not seen it, and still gets it.
    expect((await inbox.syncForEndpoint(desktop.id)).events.map((e) => e.seq)).toEqual([1]);
  });

  it("shows one steward nothing from another steward's stream", async () => {
    const mine = await seed();
    const theirs = await seed();
    const inbox = stewardInboxService(db);
    const myEndpoint = await makeEndpoint(mine.company.id, mine.steward.principalId);

    const theirApproval = await makeApproval(theirs.company.id, theirs.agent.id);
    await inbox.recordApprovalEvent(theirApproval.id, "approval.opened");

    expect((await inbox.syncForEndpoint(myEndpoint.id)).events).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Stage 1: the log must not become a reason things cannot be deleted
  // -----------------------------------------------------------------------

  /**
   * Both of these were live defects the moment the log was wired in: the
   * approval routes now write a row referencing an agent and a company, and
   * neither deletion path knew the table existed. Found by an unrelated
   * bridge test failing on teardown.
   */
  it("lets an agent be deleted and keeps what its steward was already told", async () => {
    const { company, steward, agent } = await seed();
    const approval = await makeApproval(company.id, agent.id);
    await stewardInboxService(db).recordApprovalEvent(approval.id, "approval.opened");

    // The approval holds the agent too, and is nulled out by the same path.
    await db.delete(approvals).where(eq(approvals.id, approval.id));
    await expect(agentService(db).remove(agent.id)).resolves.toBeTruthy();

    const rows = await eventsFor(company.id, steward.principalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentId).toBeNull();
  });

  it("purges the log when its company is deleted", async () => {
    const { company, steward, agent } = await seed();
    const approval = await makeApproval(company.id, agent.id);
    await stewardInboxService(db).recordApprovalEvent(approval.id, "approval.opened");
    expect(await eventsFor(company.id, steward.principalId)).toHaveLength(1);

    await companyService(db).remove(company.id);

    expect(
      await db.select().from(stewardInboxEvents).where(eq(stewardInboxEvents.companyId, company.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(stewardInboxSequences)
        .where(eq(stewardInboxSequences.companyId, company.id)),
    ).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Stage 2: the capability gate
  // -----------------------------------------------------------------------

  function bridgeApp(endpointId: string, companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "none",
        source: "bridge_endpoint",
        companyId,
        bridgeEndpointId: endpointId,
        companyIds: [companyId],
      };
      next();
    });
    app.use("/api", bridgeRoutes(db, { autoDispatchQueuedRuns: false }));
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

  it("refuses an endpoint that never declared the inbox capability", async () => {
    const { company, steward } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId, ["bridge:read"]);
    const app = bridgeApp(endpoint.id, company.id);

    const response = await call(app, (baseUrl) =>
      request(baseUrl).post("/api/bridge/inbox/sync").send({}),
    );
    expect(response.status).toBe(403);
    expect(response.body.error).toContain(STEWARD_INBOX_CAPABILITY);
  });

  it("serves and acknowledges over the route for a capable endpoint", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const approval = await makeApproval(company.id, agent.id);
    await stewardInboxService(db).recordApprovalEvent(approval.id, "approval.opened");
    const app = bridgeApp(endpoint.id, company.id);

    const synced = await call(app, (baseUrl) =>
      request(baseUrl).post("/api/bridge/inbox/sync").send({}),
    );
    expect(synced.status).toBe(200);
    expect(synced.body.events).toHaveLength(1);

    const acked = await call(app, (baseUrl) =>
      request(baseUrl).post("/api/bridge/inbox/ack").send({ seq: 1 }),
    );
    expect(acked.status).toBe(200);
    expect(acked.body.lastAckedSeq).toBe(1);

    const again = await call(app, (baseUrl) =>
      request(baseUrl).post("/api/bridge/inbox/sync").send({}),
    );
    expect(again.body.events).toHaveLength(0);
  });

  it("rejects an acknowledgement with no position", async () => {
    const { company, steward } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const app = bridgeApp(endpoint.id, company.id);
    const response = await call(app, (baseUrl) =>
      request(baseUrl).post("/api/bridge/inbox/ack").send({}),
    );
    expect(response.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // Stage 3: deciding from the inbox
  // -----------------------------------------------------------------------

  /** An endpoint that may also be asked to act, for the gated-task tests. */
  async function actingEndpoint(companyId: string, userId: string) {
    return makeEndpoint(companyId, userId, [
      "bridge:read",
      "bridge:act",
      STEWARD_INBOX_CAPABILITY,
    ]);
  }

  it("hands back a pair of handles for an approval its owner may decide", async () => {
    const { company, steward, agent } = await seed();
    const inbox = stewardInboxService(db);
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const approval = await makeApproval(company.id, agent.id);
    await inbox.recordApprovalEvent(approval.id, "approval.opened");

    const synced = await inbox.syncForEndpoint(endpoint.id);
    expect(synced.events[0]!.actions).toEqual({
      approve: expect.any(String),
      reject: expect.any(String),
    });
    expect(synced.events[0]!.actions!.approve).not.toBe(synced.events[0]!.actions!.reject);
  });

  it("reuses a live handle instead of minting one on every sync", async () => {
    const { company, steward, agent } = await seed();
    const inbox = stewardInboxService(db);
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const approval = await makeApproval(company.id, agent.id);
    await inbox.recordApprovalEvent(approval.id, "approval.opened");

    const first = await inbox.syncForEndpoint(endpoint.id);
    const second = await inbox.syncForEndpoint(endpoint.id);
    expect(second.events[0]!.actions).toEqual(first.events[0]!.actions);
    // Sync repeats until the client acknowledges; minting per call would leave
    // a fresh pair of live credentials behind every few seconds.
    expect(await db.select().from(channelCallbackTokens)).toHaveLength(2);
  });

  it("offers no handles for an approval already resolved", async () => {
    const { company, steward, agent } = await seed();
    const inbox = stewardInboxService(db);
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const approval = await makeApproval(company.id, agent.id, { status: "approved" });
    await inbox.recordApprovalEvent(approval.id, "approval.resolved");

    const synced = await inbox.syncForEndpoint(endpoint.id);
    expect(synced.events[0]!.actions).toBeNull();
  });

  /**
   * The test stage 3 waited on the effects extraction for. An `act` task is
   * invisible to polling until its approval clears; deciding from the inbox has
   * to release it, or the agent waits for ever on a decision that was made.
   */
  it("releases a gated bridge task when the approval is decided from the inbox", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await actingEndpoint(company.id, steward.principalId);
    const bridge = bridgeService(db);
    const task = await bridge.createTask(company.id, {
      endpointId: endpoint.id,
      requestedByAgentId: agent.id,
      taskClass: "act",
      instruction: "delete the stale branch",
    });
    await stewardInboxService(db).recordApprovalEvent(task.approvalId!, "approval.opened");

    // Withheld while it waits, which is the whole point of the gate.
    expect(await bridge.claimNextTask(endpoint.id)).toBeNull();

    const synced = await stewardInboxService(db).syncForEndpoint(endpoint.id);
    const handles = synced.events.find((event) => event.refId === task.approvalId)!.actions!;
    const outcome = await stewardInboxDecisionService(db, { autoDispatchQueuedRuns: false }).decide(endpoint.id, handles.approve);
    expect(outcome).toMatchObject({ ok: true, decision: "approved" });

    const claimed = await bridge.claimNextTask(endpoint.id);
    expect(claimed, "the approved act task was still withheld").not.toBeNull();
  });

  it("terminates a gated bridge task when the approval is rejected from the inbox", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await actingEndpoint(company.id, steward.principalId);
    const bridge = bridgeService(db);
    const task = await bridge.createTask(company.id, {
      endpointId: endpoint.id,
      requestedByAgentId: agent.id,
      taskClass: "act",
      instruction: "delete the stale branch",
    });
    await stewardInboxService(db).recordApprovalEvent(task.approvalId!, "approval.opened");

    const synced = await stewardInboxService(db).syncForEndpoint(endpoint.id);
    const handles = synced.events.find((event) => event.refId === task.approvalId)!.actions!;
    expect(await stewardInboxDecisionService(db, { autoDispatchQueuedRuns: false }).decide(endpoint.id, handles.reject)).toMatchObject({
      ok: true,
      decision: "rejected",
    });

    const row = await db
      .select()
      .from(bridgeTasks)
      .where(eq(bridgeTasks.id, task.id))
      .then((rows) => rows[0]!);
    expect(row.status).not.toBe("awaiting_approval");
    expect(await bridge.claimNextTask(endpoint.id)).toBeNull();
  });

  it("attributes the decision to the person, not the machine", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const approval = await makeApproval(company.id, agent.id);
    await stewardInboxService(db).recordApprovalEvent(approval.id, "approval.opened");
    const synced = await stewardInboxService(db).syncForEndpoint(endpoint.id);

    await stewardInboxDecisionService(db, { autoDispatchQueuedRuns: false }).decide(endpoint.id, synced.events[0]!.actions!.approve);

    const row = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(row.decidedByUserId).toBe(steward.principalId);
    expect(row.decidedByUserId).not.toBe(endpoint.id);
    // The audit record must not claim a laptop decision came from the board.
    expect(row.decisionChannel).toBe("bridge_inbox");
  });

  it("spends a handle exactly once", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const approval = await makeApproval(company.id, agent.id);
    await stewardInboxService(db).recordApprovalEvent(approval.id, "approval.opened");
    const synced = await stewardInboxService(db).syncForEndpoint(endpoint.id);
    const decisions = stewardInboxDecisionService(db, { autoDispatchQueuedRuns: false });

    expect(await decisions.decide(endpoint.id, synced.events[0]!.actions!.approve)).toMatchObject({
      ok: true,
    });
    const replay = await decisions.decide(endpoint.id, synced.events[0]!.actions!.approve);
    expect(replay.ok).toBe(false);
  });

  it("makes a handle inert on any machine but the one it was minted for", async () => {
    const { company, steward, agent } = await seed();
    const laptop = await makeEndpoint(company.id, steward.principalId);
    const desktop = await makeEndpoint(company.id, steward.principalId);
    const approval = await makeApproval(company.id, agent.id);
    await stewardInboxService(db).recordApprovalEvent(approval.id, "approval.opened");

    const synced = await stewardInboxService(db).syncForEndpoint(laptop.id);
    const laptopHandle = synced.events[0]!.actions!.approve;

    // Same person, same authority, different machine. The handle still fails.
    const stolen = await stewardInboxDecisionService(db, { autoDispatchQueuedRuns: false }).decide(desktop.id, laptopHandle);
    expect(stolen.ok).toBe(false);
  });

  it("refuses a handle minted against a revision that has since moved on", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const approval = await makeApproval(company.id, agent.id);
    await stewardInboxService(db).recordApprovalEvent(approval.id, "approval.opened");
    const synced = await stewardInboxService(db).syncForEndpoint(endpoint.id);
    const staleHandle = synced.events[0]!.actions!.approve;

    // The ask changed after the steward was shown it.
    await db.update(approvals).set({ revision: 2 }).where(eq(approvals.id, approval.id));

    const outcome = await stewardInboxDecisionService(db, { autoDispatchQueuedRuns: false }).decide(endpoint.id, staleHandle);
    expect(outcome.ok).toBe(false);
    const row = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .then((rows) => rows[0]!);
    expect(row.status).toBe("pending");
  });

  it("refuses an expired handle", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const approval = await makeApproval(company.id, agent.id);
    await stewardInboxService(db).recordApprovalEvent(approval.id, "approval.opened");
    const synced = await stewardInboxService(db).syncForEndpoint(endpoint.id);
    const handle = synced.events[0]!.actions!.approve;

    await db
      .update(channelCallbackTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(channelCallbackTokens.token, handle));

    expect(await stewardInboxDecisionService(db, { autoDispatchQueuedRuns: false }).decide(endpoint.id, handle)).toMatchObject({
      ok: false,
    });
  });

  it("refuses a decision over the route without a handle", async () => {
    const { company, steward } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const app = bridgeApp(endpoint.id, company.id);
    const response = await call(app, (baseUrl) =>
      request(baseUrl).post("/api/bridge/inbox/decide").send({}),
    );
    expect(response.status).toBe(400);
  });

  it("decides over the route for a capable endpoint", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const approval = await makeApproval(company.id, agent.id);
    await stewardInboxService(db).recordApprovalEvent(approval.id, "approval.opened");
    const app = bridgeApp(endpoint.id, company.id);

    const synced = await call(app, (baseUrl) =>
      request(baseUrl).post("/api/bridge/inbox/sync").send({}),
    );
    const handle = synced.body.events[0].actions.approve;
    const decided = await call(app, (baseUrl) =>
      request(baseUrl).post("/api/bridge/inbox/decide").send({ token: handle }),
    );
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ ok: true, decision: "approved" });
  });

  // -----------------------------------------------------------------------
  // Stage 4: the digest
  // -----------------------------------------------------------------------

  async function makeIssue(
    companyId: string,
    agentId: string | null,
    status: string,
    title = `Issue ${randomUUID().slice(0, 6)}`,
  ) {
    return db
      .insert(issues)
      .values({ companyId, title, status, assigneeAgentId: agentId })
      .returning()
      .then((rows) => rows[0]!);
  }

  it("returns no digest unless the client asks for one", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const approval = await makeApproval(company.id, agent.id);
    await stewardInboxService(db).recordApprovalEvent(approval.id, "approval.opened");

    const plain = await stewardInboxService(db).syncForEndpoint(endpoint.id);
    expect(plain.digest).toBeUndefined();

    const withDigest = await stewardInboxService(db).syncForEndpoint(endpoint.id, {
      includeDigest: true,
    });
    expect(withDigest.digest).toBeDefined();
  });

  it("orders the digest urgent approvals, then blockers, then completions", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    await makeApproval(company.id, agent.id, { type: "hire_agent" });
    await makeIssue(company.id, agent.id, "blocked");
    await makeIssue(company.id, agent.id, "done");

    const digest = await stewardInboxService(db).buildDigest(endpoint);
    // The contract is the reading order, so the key order is the assertion.
    expect(Object.keys(digest).filter((k) => k !== "agentsAnsweredFor" && k !== "truncated")).toEqual([
      "approvals",
      "blockers",
      "completions",
    ]);
    expect(digest.approvals.total).toBe(1);
    expect(digest.blockers.total).toBe(1);
    expect(digest.completions.total).toBe(1);
  });

  it("puts the riskiest approval first, and the longest wait ahead of a tie", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const older = await makeApproval(company.id, agent.id, { type: "connector_send" });
    const newer = await makeApproval(company.id, agent.id, { type: "connector_send" });
    await db
      .update(approvals)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(approvals.id, older.id));
    const risky = await makeApproval(company.id, agent.id, { type: "mandate_violation" });

    const digest = await stewardInboxService(db).buildDigest(endpoint);
    expect(digest.approvals.items.map((i: any) => i.approvalId)).toEqual([
      risky.id, // high risk beats age
      older.id, // then the longest wait
      newer.id,
    ]);
    expect((digest.approvals.items[0] as any).risk).toEqual({
      level: "high",
      reason: "Mandate violation",
    });
  });

  it("makes the digest actionable rather than only informative", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    await makeApproval(company.id, agent.id);

    const digest = await stewardInboxService(db).buildDigest(endpoint);
    expect((digest.approvals.items[0] as any).actions).toEqual({
      approve: expect.any(String),
      reject: expect.any(String),
    });
  });

  /**
   * The cap has to be visible. A digest that shows ten of fourteen blockers and
   * says nothing reads exactly like a digest of ten blockers.
   */
  it("caps the lists but never the counts, and says when it truncated", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    for (let index = 0; index < 12; index += 1) {
      await makeIssue(company.id, agent.id, "blocked");
    }
    for (let index = 0; index < 8; index += 1) {
      await makeIssue(company.id, agent.id, "done");
    }

    const digest = await stewardInboxService(db).buildDigest(endpoint);
    expect(digest.blockers.total).toBe(12);
    expect(digest.blockers.shown).toBe(10);
    expect(digest.blockers.items).toHaveLength(10);
    expect(digest.completions.total).toBe(8);
    expect(digest.completions.shown).toBe(5);
    expect(digest.truncated).toBe(true);
  });

  it("reports nothing truncated when everything fits", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    await makeIssue(company.id, agent.id, "blocked");

    const digest = await stewardInboxService(db).buildDigest(endpoint);
    expect(digest.truncated).toBe(false);
    expect(digest.blockers.shown).toBe(digest.blockers.total);
  });

  it("lists only work in the statuses each section is about", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    await makeIssue(company.id, agent.id, "in_progress");
    await makeIssue(company.id, agent.id, "backlog");
    await makeIssue(company.id, agent.id, "cancelled");

    const digest = await stewardInboxService(db).buildDigest(endpoint);
    expect(digest.blockers.total).toBe(0);
    expect(digest.completions.total).toBe(0);
  });

  /**
   * The bug class approval card delivery already hit: resolving through
   * stewardship alone returns nothing for an autonomous agent, so the person
   * actually answerable for it sees none of its work.
   */
  it("includes an autonomous agent's work for the human accountable for it", async () => {
    const { company, steward } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    const autonomous = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: `Autonomous ${randomUUID().slice(0, 6)}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        autonomy: "autonomous",
        accountableUserId: steward.principalId,
      })
      .returning()
      .then((rows) => rows[0]!);
    await makeIssue(company.id, autonomous.id, "blocked");

    const digest = await stewardInboxService(db).buildDigest(endpoint);
    expect(digest.blockers.total).toBe(1);
    expect((digest.blockers.items[0] as any).agentName).toBe(autonomous.name);
  });

  it("shows one person nothing about another person's agents", async () => {
    const mine = await seed();
    const theirs = await seed();
    const myEndpoint = await makeEndpoint(mine.company.id, mine.steward.principalId);
    await makeIssue(theirs.company.id, theirs.agent.id, "blocked");
    await makeApproval(theirs.company.id, theirs.agent.id);

    const digest = await stewardInboxService(db).buildDigest(myEndpoint);
    expect(digest.approvals.total).toBe(0);
    expect(digest.blockers.total).toBe(0);
  });

  it("answers cleanly for someone who answers for no agents", async () => {
    const { company, owner } = await seed();
    const endpoint = await makeEndpoint(company.id, owner.principalId);

    const digest = await stewardInboxService(db).buildDigest(endpoint);
    expect(digest.agentsAnsweredFor).toBe(0);
    expect(digest).toMatchObject({
      approvals: { total: 0, shown: 0 },
      blockers: { total: 0, shown: 0 },
      completions: { total: 0, shown: 0 },
      truncated: false,
    });
  });

  it("serves the digest over the route when asked", async () => {
    const { company, steward, agent } = await seed();
    const endpoint = await makeEndpoint(company.id, steward.principalId);
    await makeApproval(company.id, agent.id, { type: "hire_agent" });
    await makeIssue(company.id, agent.id, "blocked");
    const app = bridgeApp(endpoint.id, company.id);

    const plain = await call(app, (baseUrl) =>
      request(baseUrl).post("/api/bridge/inbox/sync").send({}),
    );
    expect(plain.body.digest).toBeUndefined();

    const withDigest = await call(app, (baseUrl) =>
      request(baseUrl).post("/api/bridge/inbox/sync").send({ includeDigest: true }),
    );
    expect(withDigest.status).toBe(200);
    expect(withDigest.body.digest.approvals.total).toBe(1);
    expect(withDigest.body.digest.blockers.total).toBe(1);
  });
});
