// AgentDash: real PostgreSQL/HTTP coverage for the notification-attempt boundary.
// Only outbound email and unrelated router service factories are substituted;
// transactions, advisory locks, activity inserts and rollback are real.
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import type { SendEmailInput } from "../auth/email.js";

const mail = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../auth/email.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../auth/email.js")>(),
  sendEmail: (input: SendEmailInput) => mail.send(input),
}));
vi.mock("../observability/error-sink.js", () => ({ recordServerError: vi.fn() }));
vi.mock("../services/index.js", async () => {
  const { logActivity } = await import("../services/activity-log.js");
  return {
    conversationService: () => ({}),
    agentService: () => ({}),
    accessService: () => ({}),
    companyService: () => ({}),
    agentInstructionsService: () => ({}),
    onboardingOrchestrator: () => ({}),
    cosInterview: () => ({}),
    agentProposer: () => ({}),
    agentCreatorFromProposal: () => ({}),
    cosOnboardingStateService: () => ({}),
    inviteService: () => ({}),
    OnboardingTierCapacityExceededError: class extends Error {},
    logActivity,
  };
});

import { onboardingV2Routes } from "../routes/onboarding-v2.js";
import { errorHandler } from "../middleware/error-handler.js";

type Db = ReturnType<typeof createDb>;
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(work: PromiseLike<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish while email was blocked`)), 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function appFor(db: Db, userId: string, companyIds: string[]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", userId, companyIds };
    next();
  });
  app.use("/api/onboarding", onboardingV2Routes(db));
  app.use(errorHandler);
  return app;
}

describePostgres("model-key notification reservation (embedded PostgreSQL)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let otherDb: Db;
  let failureFunctionCreated = false;
  let failureTriggerCreated = false;
  const originalPublicUrl = process.env.PAPERCLIP_PUBLIC_URL;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-model-key-reservation-");
    // Two small, independent pools expose connection occupation and cross-instance races.
    db = createDb(`${tempDb.connectionString}?max=2`);
    otherDb = createDb(`${tempDb.connectionString}?max=2`);
  }, 120_000);

  beforeEach(() => {
    mail.send.mockReset().mockResolvedValue({ status: "sent" });
    process.env.PAPERCLIP_PUBLIC_URL = "https://agentdash.example.test";
  });

  afterEach(async () => {
    if (failureTriggerCreated) {
      await db.execute(sql`drop trigger fail_model_key_reservation on activity_log`);
      failureTriggerCreated = false;
    }
    if (failureFunctionCreated) {
      await db.execute(sql`drop function fail_model_key_reservation()`);
      failureFunctionCreated = false;
    }
    await db.delete(activityLog);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    if (originalPublicUrl === undefined) delete process.env.PAPERCLIP_PUBLIC_URL;
    else process.env.PAPERCLIP_PUBLIC_URL = originalPublicUrl;
    await db?.$client.end({ timeout: 0 });
    await otherDb?.$client.end({ timeout: 0 });
    await tempDb?.cleanup();
  });

  async function seed(adminCount = 1) {
    const companyId = randomUUID();
    const requesterId = randomUUID();
    const otherRequesterId = randomUUID();
    const admins = Array.from({ length: adminCount }, (_, i) => ({
      id: randomUUID(), name: `Admin ${i + 1}`, email: `admin-${i + 1}-${companyId}@example.test`,
    }));
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Notification test", issuePrefix: `NK${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(authUsers).values([
      { id: requesterId, name: "Requester", email: `requester-${requesterId}@example.test`, createdAt: now, updatedAt: now },
      { id: otherRequesterId, name: "Other requester", email: `requester-${otherRequesterId}@example.test`, createdAt: now, updatedAt: now },
      ...admins.map((user) => ({ ...user, createdAt: now, updatedAt: now })),
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: requesterId, membershipRole: "member" },
      { companyId, principalType: "user", principalId: otherRequesterId, membershipRole: "member" },
      ...admins.map((user) => ({ companyId, principalType: "user", principalId: user.id, membershipRole: "admin" })),
    ]);
    return { companyId, requesterId, otherRequesterId, admins };
  }

  function attempts(conn: Db, companyId: string, requesterId: string) {
    return conn.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.actorId, requesterId),
      eq(activityLog.action, "model_key.requested"),
    ));
  }

  it("commits one attempt and frees the pool before slow delivery while cross-instance duplicates finish", async () => {
    const { companyId, requesterId } = await seed();
    const started = deferred();
    const release = deferred();
    const delivered: SendEmailInput[] = [];
    mail.send.mockImplementation(async (input: SendEmailInput) => {
      delivered.push(input);
      started.resolve();
      await release.promise;
      return { status: "sent" };
    });
    const app = appFor(db, requesterId, [companyId]);
    const app2 = appFor(otherDb, requesterId, [companyId]);
    const winner = request(app).post("/api/onboarding/request-model-key").send({ companyId }).then((r) => r);
    const duplicates: Array<Promise<request.Response>> = [];
    let probe: PromiseLike<unknown> | undefined;
    try {
      await bounded(started.promise, "first email");
      // More duplicates than either pool's capacity, across separate app instances.
      for (const target of [app, app, app, app2, app2, app2]) {
        duplicates.push(request(target).post("/api/onboarding/request-model-key").send({ companyId }).then((r) => r));
      }
      probe = db.execute(sql`select 1 as healthy`).then((rows) => rows);
      const [responses] = await bounded(Promise.all([Promise.all(duplicates), probe]), "duplicates and unrelated SQL");
      expect(responses.map((r) => r.status)).toEqual([429, 429, 429, 429, 429, 429]);
      expect(responses.every((r) => r.body.details.retryAfterSeconds > 0)).toBe(true);
      expect(responses.every((r) => !/already been told/i.test(r.body.error))).toBe(true);
      expect(await attempts(otherDb, companyId, requesterId)).toHaveLength(1);
      expect(delivered).toHaveLength(1);
    } finally {
      release.resolve();
      await Promise.allSettled([winner, ...duplicates, ...(probe ? [probe] : [])]);
    }
    expect((await winner).body.results).toEqual([{ name: "Admin 1", status: "sent" }]);
    expect(await attempts(otherDb, companyId, requesterId)).toHaveLength(1);
  });

  it("returns bounded in-flight 429 when another transaction is reserving the same request", async () => {
    const { companyId, requesterId } = await seed();
    const locked = deferred();
    const release = deferred();
    const key = Number.parseInt(createHash("sha256").update(`model-key-req:${companyId}:${requesterId}`).digest("hex").slice(0, 12), 16);
    const holder = otherDb.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${key})`);
      locked.resolve();
      await release.promise;
    });
    let pending: Promise<request.Response> | undefined;
    try {
      await bounded(locked.promise, "other transaction lock");
      pending = request(appFor(db, requesterId, [companyId])).post("/api/onboarding/request-model-key").send({ companyId }).then((r) => r);
      const response = await bounded(pending, "contended reservation");
      expect(response.status).toBe(429);
      expect(response.body.error).toMatch(/in progress/i);
      expect(response.body.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(await attempts(db, companyId, requesterId)).toHaveLength(0);
      expect(mail.send).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([holder, ...(pending ? [pending] : [])]);
    }
  });

  it("rolls back a failed reservation before any email leaves", async () => {
    const { companyId, requesterId } = await seed();
    await db.execute(sql`create function fail_model_key_reservation() returns trigger language plpgsql as $$
      begin if NEW.action = 'model_key.requested' then raise exception 'injected reservation failure'; end if; return NEW; end $$`);
    failureFunctionCreated = true;
    await db.execute(sql`create trigger fail_model_key_reservation after insert on activity_log
      for each row execute function fail_model_key_reservation()`);
    failureTriggerCreated = true;
    const app = appFor(db, requesterId, [companyId]);
    const failed = await request(app).post("/api/onboarding/request-model-key").send({ companyId });
    expect(failed.status).toBe(500);
    expect(await attempts(otherDb, companyId, requesterId)).toHaveLength(0);
    expect(mail.send).not.toHaveBeenCalled();
    await db.execute(sql`drop trigger fail_model_key_reservation on activity_log`);
    failureTriggerCreated = false;
    const retry = await request(app).post("/api/onboarding/request-model-key").send({ companyId });
    expect(retry.status).toBe(200);
    expect(await attempts(otherDb, companyId, requesterId)).toHaveLength(1);
  });

  it("retains the durable attempt after partial or failed delivery and reports each outcome", async () => {
    const { companyId, requesterId } = await seed(3);
    mail.send.mockResolvedValueOnce({ status: "sent" }).mockResolvedValueOnce({ status: "failed" }).mockResolvedValueOnce({ status: "skipped" });
    const response = await request(appFor(db, requesterId, [companyId])).post("/api/onboarding/request-model-key").send({ companyId });
    expect(response.status).toBe(200);
    expect(response.body.results.map((r: { status: string }) => r.status)).toEqual(["sent", "failed", "skipped"]);
    expect(JSON.stringify(response.body)).not.toContain("@example.test");
    expect(await attempts(otherDb, companyId, requesterId)).toHaveLength(1);
    // Recreated router and independent pool simulate another app seeing the durable reservation.
    const duplicate = await request(appFor(otherDb, requesterId, [companyId])).post("/api/onboarding/request-model-key").send({ companyId });
    expect(duplicate.status).toBe(429);
    expect(duplicate.body.error).toMatch(/request.*attempt/i);
    expect(mail.send).toHaveBeenCalledTimes(3);
  });

  it("retains the attempt when delivery unexpectedly throws after a recipient already received mail", async () => {
    const { companyId, requesterId } = await seed(2);
    mail.send.mockResolvedValueOnce({ status: "sent" }).mockRejectedValueOnce(new Error("unexpected delivery interruption"));
    const response = await request(appFor(db, requesterId, [companyId])).post("/api/onboarding/request-model-key").send({ companyId });
    expect(response.status).toBe(500);
    expect(await attempts(otherDb, companyId, requesterId)).toHaveLength(1);
    const duplicate = await request(appFor(otherDb, requesterId, [companyId])).post("/api/onboarding/request-model-key").send({ companyId });
    expect(duplicate.status).toBe(429);
    expect(mail.send).toHaveBeenCalledTimes(2);
  });

  it("keeps company and requester reservations independent", async () => {
    const a = await seed();
    const b = await seed();
    await db.insert(companyMemberships).values({
      companyId: b.companyId, principalType: "user", principalId: a.requesterId, membershipRole: "member",
    });
    const responses = await Promise.all([
      request(appFor(db, a.requesterId, [a.companyId])).post("/api/onboarding/request-model-key").send({ companyId: a.companyId }),
      request(appFor(otherDb, a.otherRequesterId, [a.companyId])).post("/api/onboarding/request-model-key").send({ companyId: a.companyId }),
      request(appFor(db, a.requesterId, [b.companyId])).post("/api/onboarding/request-model-key").send({ companyId: b.companyId }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await attempts(otherDb, a.companyId, a.requesterId)).toHaveLength(1);
    expect(await attempts(otherDb, a.companyId, a.otherRequesterId)).toHaveLength(1);
    expect(await attempts(otherDb, b.companyId, a.requesterId)).toHaveLength(1);
  });
});
