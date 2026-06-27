// AgentDash (Test Drive): integration tests for the anonymous trial engine.
//
// Covers trialService.runTask (artifact persisted, credit deducted, typed
// CreditExhausted) with an injected dispatch seam, plus the public routes
// (POST /session -> POST /:token/run -> GET /:token, and the 402 path) with a
// module-mocked dispatch so no test ever hits the network.

import express from "express";
import request from "supertest";
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Module-mock the LLM dispatch so the route's internal trialService never calls
// out. Service-level tests inject their own dispatch and don't rely on this.
const mockDispatch = vi.hoisted(() => vi.fn());
vi.mock("../services/dispatch-llm.js", () => ({
  dispatchLLM: mockDispatch,
}));

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createDb, trialSessions, trialArtifacts, companies, companyMemberships } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import {
  trialService,
  TrialCreditExhaustedError,
  TrialAlreadyClaimedError,
} from "../services/trial.ts";
import { trialRoutes } from "../routes/trial.ts";
import { errorHandler } from "../middleware/index.js";

const SAMPLE_PAYLOAD = {
  summary: "Lead with the cost of manual dispatch.",
  touches: [
    { day: 1, channel: "email", subject: "quick idea for [Company]", body: "Hi [First Name], one thought..." },
    { day: 3, channel: "email", subject: "following up", body: "Sharing a quick number..." },
    { day: 7, channel: "linkedin", body: "Closing the loop." },
  ],
  tips: ["Personalize line one.", "Keep it under 120 words."],
};

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres trial tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Test Drive trial (integration)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-vitest-trial-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    mockDispatch.mockReset();
    mockDispatch.mockResolvedValue(JSON.stringify(SAMPLE_PAYLOAD));
  });

  // -------------------------------------------------------------------------
  // Service: runTask with injected dispatch
  // -------------------------------------------------------------------------

  it("createSession provisions a company + agent + token and runTask persists an artifact and deducts credit", async () => {
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify(SAMPLE_PAYLOAD));
    const svc = trialService(db, { dispatch });

    const session = await svc.createSession({ ipHash: "hash-1" });
    expect(session.token).toBeTruthy();
    expect(session.creditCents).toBeGreaterThan(0);
    expect(session.spentCents).toBe(0);
    expect(session.companyId).toBeTruthy();
    expect(session.agentId).toBeTruthy();

    const result = await svc.runTask(session.token, {
      useCase: "sales_outreach",
      input: { icp: "VPs of Ops at logistics SaaS" },
    });

    // Artifact persisted with structured content.
    expect(result.artifact.useCase).toBe("sales_outreach");
    expect(result.artifact.title).toContain("3-touch outreach sequence");
    expect((result.artifact.content as { touches: unknown[] }).touches).toHaveLength(3);

    // Dispatch forced onto the minimax adapter with a meter.
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [, meter, options] = dispatch.mock.calls[0];
    expect(options).toMatchObject({ adapter: "minimax" });
    expect(meter).toMatchObject({ companyId: session.companyId, agentId: session.agentId });

    // Credit deducted.
    expect(result.spentCents).toBeGreaterThan(0);
    expect(result.creditRemainingCents).toBe(session.creditCents - result.spentCents);

    // Persisted row reflects the artifact.
    const rows = await db
      .select()
      .from(trialArtifacts)
      .where(eq(trialArtifacts.trialSessionId, (await fetchSessionRow(db, session.token)).id));
    expect(rows).toHaveLength(1);
  });

  it("runTask throws TrialCreditExhaustedError (402) when credit is spent", async () => {
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify(SAMPLE_PAYLOAD));
    const svc = trialService(db, { dispatch });
    const session = await svc.createSession();

    // Drain the credit directly.
    await db
      .update(trialSessions)
      .set({ spentCents: session.creditCents })
      .where(eq(trialSessions.token, session.token));

    await expect(
      svc.runTask(session.token, { useCase: "sales_outreach", input: { icp: "x" } }),
    ).rejects.toBeInstanceOf(TrialCreditExhaustedError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("runTask rejects an unknown useCase (400) and a missing icp (400)", async () => {
    const dispatch = vi.fn().mockResolvedValue("{}");
    const svc = trialService(db, { dispatch });
    const session = await svc.createSession();

    await expect(
      svc.runTask(session.token, { useCase: "nope", input: { icp: "x" } }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      svc.runTask(session.token, { useCase: "sales_outreach", input: {} }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("runTask throws TrialNotFound (404) for an unknown token", async () => {
    const svc = trialService(db, { dispatch: vi.fn() });
    await expect(
      svc.runTask("does-not-exist", { useCase: "sales_outreach", input: { icp: "x" } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  // -------------------------------------------------------------------------
  // Routes: full POST /session -> POST /:token/run -> GET /:token flow
  // -------------------------------------------------------------------------

  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/trial", trialRoutes(db));
    app.use(errorHandler);
    return app;
  }

  // Like makeApp but injects req.actor before the trial routes so the
  // AUTHENTICATED claim route can read it (mirrors actorMiddleware in prod).
  function makeAuthedApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api/trial", trialRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("POST /session -> POST /:token/run -> GET /:token shows the artifact + reduced credit", async () => {
    const app = makeApp();

    const created = await request(app).post("/api/trial/session").send({});
    expect(created.status).toBe(201);
    expect(created.body.token).toBeTruthy();
    expect(created.body.creditCents).toBeGreaterThan(0);
    const token = created.body.token as string;

    const run = await request(app)
      .post(`/api/trial/${token}/run`)
      .send({ useCase: "sales_outreach", input: { icp: "RevOps leaders at SaaS scaleups" } });
    expect(run.status).toBe(201);
    expect(run.body.artifact.useCase).toBe("sales_outreach");
    expect(run.body.artifact.content.touches).toHaveLength(3);
    expect(run.body.spentCents).toBeGreaterThan(0);

    const got = await request(app).get(`/api/trial/${token}`);
    expect(got.status).toBe(200);
    expect(got.body.artifacts).toHaveLength(1);
    expect(got.body.session.creditRemainingCents).toBe(
      got.body.session.creditCents - got.body.session.spentCents,
    );
    expect(got.body.session.spentCents).toBeGreaterThan(0);
  });

  it("POST /:token/run returns 402 when credit is exhausted", async () => {
    const app = makeApp();
    const created = await request(app).post("/api/trial/session").send({});
    const token = created.body.token as string;

    await db
      .update(trialSessions)
      .set({ spentCents: created.body.creditCents })
      .where(eq(trialSessions.token, token));

    const run = await request(app)
      .post(`/api/trial/${token}/run`)
      .send({ useCase: "sales_outreach", input: { icp: "x" } });
    expect(run.status).toBe(402);
    expect(run.body.details?.code).toBe("trial_credit_exhausted");
  });

  it("POST /:token/run returns 404 for a bad token and 400 for an unknown useCase", async () => {
    const app = makeApp();
    const badToken = await request(app)
      .post(`/api/trial/nope/run`)
      .send({ useCase: "sales_outreach", input: { icp: "x" } });
    expect(badToken.status).toBe(404);

    const created = await request(app).post("/api/trial/session").send({});
    const token = created.body.token as string;
    const badUseCase = await request(app)
      .post(`/api/trial/${token}/run`)
      .send({ useCase: "unknown", input: { icp: "x" } });
    expect(badUseCase.status).toBe(400);
  });

  it("GET /:token returns 404 for an unknown token", async () => {
    const app = makeApp();
    const res = await request(app).get("/api/trial/does-not-exist");
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Slice 3 — Share loop
  // -------------------------------------------------------------------------

  it("shareArtifact generates + persists a token and is idempotent", async () => {
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify(SAMPLE_PAYLOAD));
    const svc = trialService(db, { dispatch });
    const session = await svc.createSession();
    const run = await svc.runTask(session.token, {
      useCase: "sales_outreach",
      input: { icp: "VPs of Ops" },
    });
    const artifactId = run.artifact.id;

    const first = await svc.shareArtifact(session.token, artifactId);
    expect(first.shareToken).toBeTruthy();
    expect(first.shareUrl).toBe(`/share/${first.shareToken}`);

    // Persisted.
    const row = await db
      .select()
      .from(trialArtifacts)
      .where(eq(trialArtifacts.id, artifactId))
      .then((rows) => rows[0]);
    expect(row?.shareToken).toBe(first.shareToken);

    // Idempotent — same token on a second call.
    const second = await svc.shareArtifact(session.token, artifactId);
    expect(second.shareToken).toBe(first.shareToken);
  });

  it("shareArtifact throws 404 for an artifact not owned by the trial", async () => {
    const svc = trialService(db, { dispatch: vi.fn() });
    const session = await svc.createSession();
    await expect(
      svc.shareArtifact(session.token, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("GET /api/trial/share/:shareToken returns the artifact (200) and 404 for unknown", async () => {
    const app = makeApp();
    const created = await request(app).post("/api/trial/session").send({});
    const token = created.body.token as string;
    const run = await request(app)
      .post(`/api/trial/${token}/run`)
      .send({ useCase: "sales_outreach", input: { icp: "RevOps leaders" } });
    const artifactId = run.body.artifact.id as string;

    const shared = await request(app).post(
      `/api/trial/${token}/artifacts/${artifactId}/share`,
    );
    expect(shared.status).toBe(201);
    expect(shared.body.shareToken).toBeTruthy();
    expect(shared.body.shareUrl).toBe(`/share/${shared.body.shareToken}`);

    const got = await request(app).get(`/api/trial/share/${shared.body.shareToken}`);
    expect(got.status).toBe(200);
    expect(got.body.title).toContain("3-touch outreach sequence");
    expect(got.body.content.touches).toHaveLength(3);
    expect(got.body.agentName).toBeTruthy();

    const missing = await request(app).get("/api/trial/share/nope-unknown-token");
    expect(missing.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Slice 4 — Claim on signup
  // -------------------------------------------------------------------------

  it("claimSession creates the owner membership, flips planTier to free, stamps the user, and bumps credit", async () => {
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify(SAMPLE_PAYLOAD));
    const svc = trialService(db, { dispatch });
    const session = await svc.createSession();
    await svc.runTask(session.token, {
      useCase: "sales_outreach",
      input: { icp: "founders" },
    });

    const userId = `user-${Math.random().toString(36).slice(2)}`;
    const claimed = await svc.claimSession(session.token, userId);
    expect(claimed.companyId).toBe(session.companyId);
    expect(claimed.companyPrefix).toBeTruthy();

    // Owner membership created.
    const membership = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, session.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
        ),
      )
      .then((rows) => rows[0]);
    expect(membership?.status).toBe("active");
    expect(membership?.membershipRole).toBe("owner");

    // planTier flipped trial -> free.
    const company = await db
      .select({ planTier: companies.planTier })
      .from(companies)
      .where(eq(companies.id, session.companyId))
      .then((rows) => rows[0]);
    expect(company?.planTier).toBe("free");

    // Session stamped + credit bumped.
    const row = await fetchSessionRow(db, session.token);
    expect(row.claimedByUserId).toBe(userId);
    expect(row.creditCents).toBeGreaterThan(session.creditCents);
  });

  it("claimSession is idempotent for the same user and rejects a different user (409)", async () => {
    const dispatch = vi.fn().mockResolvedValue(JSON.stringify(SAMPLE_PAYLOAD));
    const svc = trialService(db, { dispatch });
    const session = await svc.createSession();

    const userId = `user-${Math.random().toString(36).slice(2)}`;
    const first = await svc.claimSession(session.token, userId);
    const creditAfterFirst = (await fetchSessionRow(db, session.token)).creditCents;

    // Same user again — no extra credit, same result.
    const second = await svc.claimSession(session.token, userId);
    expect(second.companyId).toBe(first.companyId);
    const creditAfterSecond = (await fetchSessionRow(db, session.token)).creditCents;
    expect(creditAfterSecond).toBe(creditAfterFirst);

    // Different user — 409.
    await expect(
      svc.claimSession(session.token, "someone-else"),
    ).rejects.toBeInstanceOf(TrialAlreadyClaimedError);
  });

  it("POST /:token/claim binds a board actor (200) and 409s a second, different claimant", async () => {
    const created = await request(makeApp()).post("/api/trial/session").send({});
    const token = created.body.token as string;

    const appA = makeAuthedApp({ type: "board", source: "session", userId: "claimer-a" });
    const claimA = await request(appA).post(`/api/trial/${token}/claim`).send({});
    expect(claimA.status).toBe(200);
    expect(claimA.body.companyPrefix).toBeTruthy();

    // Idempotent for the same user.
    const claimAagain = await request(appA).post(`/api/trial/${token}/claim`).send({});
    expect(claimAagain.status).toBe(200);

    // Different user — 409.
    const appB = makeAuthedApp({ type: "board", source: "session", userId: "claimer-b" });
    const claimB = await request(appB).post(`/api/trial/${token}/claim`).send({});
    expect(claimB.status).toBe(409);
    expect(claimB.body.details?.code).toBe("trial_already_claimed");
  });

  it("POST /:token/claim rejects an unauthenticated (none) actor", async () => {
    const created = await request(makeApp()).post("/api/trial/session").send({});
    const token = created.body.token as string;
    const app = makeAuthedApp({ type: "none", source: "none" });
    const res = await request(app).post(`/api/trial/${token}/claim`).send({});
    expect(res.status).toBe(403);
  });
});

async function fetchSessionRow(db: ReturnType<typeof createDb>, token: string) {
  const row = await db
    .select()
    .from(trialSessions)
    .where(eq(trialSessions.token, token))
    .then((rows) => rows[0]);
  if (!row) throw new Error("session not found");
  return row;
}
