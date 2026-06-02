// AgentDash: auto-approve-invites — route-level integration coverage for the
// auto_approve invite flow against an embedded Postgres.
//
// Asserts the two contracts the feature introduces:
//   (a) auto_approve = true  -> human accept grants ACTIVE membership
//       immediately and the join_request is created already "approved"
//       (no pending state ever exists).
//   (b) auto_approve = false -> human accept produces a "pending_approval"
//       join_request and NO membership (the unchanged legacy flow).
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  invites,
  joinRequests,
  principalPermissionGrants,
} from "@paperclipai/db";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";
import { hashToken, createInviteToken } from "../lib/invite-tokens.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("POST /invites/:token/accept (auto_approve)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-invite-auto-approve-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(userId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).actor = {
        type: "board",
        source: "session",
        userId,
        companyIds: [],
        memberships: [],
      };
      next();
    });
    app.use(
      "/api",
      accessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        bindHost: "127.0.0.1",
        allowedHostnames: [],
      }),
    );
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Auto Approve Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedInvite(companyId: string, autoApprove: boolean) {
    const token = createInviteToken();
    await db.insert(invites).values({
      companyId,
      inviteType: "company_join",
      allowedJoinTypes: "human",
      autoApprove,
      defaultsPayload: { humanRole: "operator" },
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      invitedByUserId: "inviter-1",
    });
    return token;
  }

  it("grants active membership immediately and approves the join request when auto_approve is true", async () => {
    const companyId = await seedCompany();
    const token = await seedInvite(companyId, true);
    const userId = `user-${randomUUID()}`;
    const app = createApp(userId);

    const res = await request(app)
      .post(`/api/invites/${token}/accept`)
      .send({ requestType: "human" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("approved");
    expect(res.body.requestType).toBe("human");

    // Active membership exists for the accepting user.
    const membership = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(membership).not.toBeNull();
    expect(membership?.status).toBe("active");
    expect(membership?.membershipRole).toBe("operator");

    // Join request is already approved — never pending.
    const allRequests = await db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.companyId, companyId));
    expect(allRequests).toHaveLength(1);
    expect(allRequests[0]?.status).toBe("approved");
    expect(allRequests[0]?.approvedAt).not.toBeNull();
    expect(
      allRequests.some((row) => row.status === "pending_approval"),
    ).toBe(false);

    // The invite is consumed.
    const consumed = await db
      .select()
      .from(invites)
      .where(eq(invites.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    expect(consumed?.acceptedAt).not.toBeNull();
  });

  it("creates a pending_approval join request with no membership when auto_approve is false", async () => {
    const companyId = await seedCompany();
    const token = await seedInvite(companyId, false);
    const userId = `user-${randomUUID()}`;
    const app = createApp(userId);

    const res = await request(app)
      .post(`/api/invites/${token}/accept`)
      .send({ requestType: "human" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending_approval");

    // No membership granted yet.
    const membership = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    expect(membership).toBeNull();

    // Join request is pending.
    const joinRequest = await db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    expect(joinRequest?.status).toBe("pending_approval");
    expect(joinRequest?.approvedAt).toBeNull();
  });
});
