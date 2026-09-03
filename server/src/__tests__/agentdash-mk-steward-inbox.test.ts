import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentStewardships,
  agents,
  approvals,
  bridgeEndpoints,
  bridgeTasks,
  companies,
  companyMemberships,
  createDb,
  stewardInboxCursors,
  stewardInboxEvents,
  stewardInboxSequences,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { bridgeRoutes } from "../routes/bridge.js";
import { agentService } from "../services/index.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
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
  it("widens the bridge route allowlist by exactly the two inbox routes", () => {
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
    await db.delete(stewardInboxCursors);
    await db.delete(stewardInboxEvents);
    await db.delete(stewardInboxSequences);
    await db.delete(activityLog);
    await db.delete(bridgeTasks);
    await db.delete(bridgeEndpoints);
    await db.delete(approvals);
    await db.delete(agentStewardships);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
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
    app.use("/api", bridgeRoutes(db));
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
});
