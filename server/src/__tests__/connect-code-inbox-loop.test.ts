import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentConnectCodes,
  agents,
  approvals,
  authUsers,
  bridgeEndpoints,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { connectCodeRoutes } from "../routes/connect-codes.js";
import { bridgeRoutes } from "../routes/bridge.js";
import { hashConnectCode } from "../lib/connect-codes.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { bridgeService } from "../services/bridge.js";
import { stewardInboxService } from "../services/steward-inbox.js";

/**
 * The whole journey a steward's machine actually takes, with nothing stubbed:
 * redeem a connect code over HTTP, then use the returned bridge token — through
 * the REAL actor middleware, the one production runs — to read the inbox,
 * receive a decision handle, spend it, and be shut out after revocation.
 *
 * This exists because each piece of it was true in isolation once before while
 * the whole was false. The capability fix (#634) passed its tests while the
 * only caller of enrolment had been deleted in the same PR; the inbox suite
 * passed while no credential able to reach it could be created. Every test
 * below crosses a seam between two components, because the seams are where
 * this feature has actually broken:
 *
 *   redeem → endpoint row        (did the credential get created at all?)
 *   token → actor middleware     (does the REAL resolver accept it?)
 *   actor → capability gate      (with the capabilities redeem granted?)
 *   event → handle → decision    (does authority travel the whole pipe?)
 *   revoke → refusal             (and can the person take it back?)
 *
 * The agent-key counter-test is the security property, not a nicety: the agent
 * key minted by the SAME redemption must be refused by the inbox, or the agent
 * holds authority over the approvals meant to constrain it.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("connect code → inbox, end to end", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-connect-loop-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    // The REAL middleware, not an injected req.actor: the property under test
    // is that the token redeem returns is one this resolver accepts.
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use("/api", connectCodeRoutes(db, { deploymentMode: "authenticated" }));
    app.use("/api", bridgeRoutes(db, { autoDispatchQueuedRuns: false }));
    app.use(errorHandler);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    // Post-decision effects reach beyond this suite's own tables; cascade
    // rather than maintaining a second copy of the deletion order.
    await db.execute(sql`truncate table ${companies} cascade`);
  });

  /** The same shape production has: a stewarded agent in an MK-profile company. */
  async function seed() {
    const company = await db
      .insert(companies)
      .values({
        name: `Loop ${randomUUID()}`,
        issuePrefix: `LP${randomUUID().slice(0, 6).toUpperCase()}`,
        productProfile: "agentdash_mk",
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
        name: "Relay",
        role: "general",
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

    await db.insert(authUsers).values({
      id: steward.principalId,
      name: "Loop Steward",
      email: `steward-${steward.principalId.slice(0, 8)}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // The steward creates a code from their signed-in session; this seeds the
    // row that create route writes, creator recorded.
    const code = "KVTX8F02";
    await db.insert(agentConnectCodes).values({
      companyId: company.id,
      agentId: agent.id,
      codeHash: hashConnectCode(code),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      createdByUserId: steward.principalId,
    });

    return { company, steward, agent, code };
  }

  async function redeem(code: string) {
    const res = await request(app)
      .post("/api/connect/redeem")
      .send({ code, deviceName: "chris-laptop" });
    expect(res.status).toBe(200);
    return res.body as { apiKey: string; bridgeToken: string; bridgeEndpointId: string };
  }

  const sync = (token: string) =>
    request(app)
      .post("/api/bridge/inbox/sync")
      .set("authorization", `Bearer ${token}`)
      .send({ includeDigest: true });

  it("a redeemed code yields a token the real middleware accepts on the inbox", async () => {
    const { code } = await seed();
    const paired = await redeem(code);
    expect(paired.bridgeToken).toBeTruthy();

    const res = await sync(paired.bridgeToken);
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.digest).toBeTruthy();
    // Every sync says whose inbox it is, so a wrong-person machine is visible
    // to its reader instead of needing a trip through the server source.
    expect(res.body.owner).toEqual({
      name: "Loop Steward",
      email: expect.stringContaining("@example.test"),
    });
  });

  /**
   * The security property. Both credentials came out of the same redemption;
   * only the person-bound one may reach the person's inbox. If this ever
   * passes with 200, an agent's own key reads its steward's approvals and
   * receives their decision handles.
   */
  it("the agent key from the same redemption is refused by the inbox", async () => {
    const { code } = await seed();
    const paired = await redeem(code);

    const res = await sync(paired.apiKey);
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThanOrEqual(403);
    expect(res.body.events).toBeUndefined();
  });

  it("an approval travels: event → sync → handle → decision", async () => {
    const { company, agent, code } = await seed();
    const paired = await redeem(code);

    // The production producer path: an approval opens, the event is recorded.
    const approval = await db
      .insert(approvals)
      .values({
        companyId: company.id,
        type: "connector_send",
        requestedByAgentId: agent.id,
        status: "pending",
        payload: { summary: "send the drafted note" },
        revision: 1,
      })
      .returning()
      .then((rows) => rows[0]!);
    await stewardInboxService(db).recordApprovalEvent(approval.id, "approval.opened");

    const synced = await sync(paired.bridgeToken);
    expect(synced.status).toBe(200);
    expect(synced.body.events).toHaveLength(1);
    const item = synced.body.events[0];
    expect(item.refId).toBe(approval.id);
    // The pointer travels; the payload must not.
    expect(JSON.stringify(item.payload)).not.toContain("drafted note");
    // And the decision handles arrive with it.
    expect(item.actions).toMatchObject({ approve: expect.any(String), reject: expect.any(String) });

    const decided = await request(app)
      .post("/api/bridge/inbox/decide")
      .set("authorization", `Bearer ${paired.bridgeToken}`)
      .send({ token: item.actions.approve });
    expect(decided.status).toBe(200);

    const [after] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(after?.status).toBe("approved");
  });

  /**
   * A spent handle decides nothing the second time. The service is explicit
   * that replay is "an outcome to render, not a fault" — a steward who
   * double-clicks gets told "already approved", not accused of lacking
   * permission — so the contract is HTTP 200 with ok:false, and the property
   * that matters is that the decision applied exactly once.
   */
  it("renders a spent handle as already-decided and applies nothing twice", async () => {
    const { company, agent, code } = await seed();
    const paired = await redeem(code);
    const approval = await db
      .insert(approvals)
      .values({
        companyId: company.id,
        type: "connector_send",
        requestedByAgentId: agent.id,
        status: "pending",
        payload: {},
        revision: 1,
      })
      .returning()
      .then((rows) => rows[0]!);
    await stewardInboxService(db).recordApprovalEvent(approval.id, "approval.opened");
    const synced = await sync(paired.bridgeToken);
    const handle = synced.body.events[0].actions.approve;

    const first = await request(app)
      .post("/api/bridge/inbox/decide")
      .set("authorization", `Bearer ${paired.bridgeToken}`)
      .send({ token: handle });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/api/bridge/inbox/decide")
      .set("authorization", `Bearer ${paired.bridgeToken}`)
      .send({ token: handle });
    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(false);
    // The exact sentence varies by which check catches the replay first; the
    // stable part of the contract is "not applied, go sync".
    expect(second.body.reason).toMatch(/sync again/i);

    // The ground truth: decided exactly once, still at the decided status.
    const [after] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(after?.status).toBe("approved");
  });

  it("a revoked endpoint's token stops working, immediately", async () => {
    const { company, steward, code } = await seed();
    const paired = await redeem(code);
    expect((await sync(paired.bridgeToken)).status).toBe(200);

    await bridgeService(db).revokeEndpoint(
      company.id,
      paired.bridgeEndpointId,
      steward.principalId,
    );

    const res = await sync(paired.bridgeToken);
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThanOrEqual(403);

    // And the row records who took it back.
    const [endpoint] = await db
      .select()
      .from(bridgeEndpoints)
      .where(eq(bridgeEndpoints.id, paired.bridgeEndpointId));
    expect(endpoint?.revokedAt).toBeTruthy();
    expect(endpoint?.revokedByUserId).toBe(steward.principalId);
  });
});
