import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAdmin } from "../admin/run.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { accounts, boxes, jobs, waitlist } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createLogger } from "../logger.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";

// A CSPRNG-shaped bearer (config refuses low-entropy values, GH #778).
const ADMIN = randomBytes(32).toString("hex");
let pg: TestDatabase;
let db: CloudDb;
let close: () => Promise<void>;
const logLines: string[] = [];
const log = createLogger({ write: (l) => logLines.push(l), level: "debug" });

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: pg.url,
    CLOUD_DATA_KEY: "33".repeat(32),
    CLOUD_ADMIN_TOKEN: ADMIN,
    CLOUD_ADMIN_ALLOWED_IPS: "127.0.0.1,::1",
    RAILWAY_API_TOKEN: "railway-token-fake-for-tests-000",
    CLOUD_RAILWAY_WORKSPACE_ID: "ws-test",
    CLOUD_CONTROL_RELEASE: "test-release",
    ...extra,
  });
}

beforeAll(async () => {
  pg = await startTestDatabase();
  await migrateCloudDb(pg.url);
  ({ db, close } = createCloudDb(pg.url));
});

afterAll(async () => {
  await close?.();
  await pg?.stop();
});

describe("GET /health", () => {
  it("answers 200 with the database up", async () => {
    const res = await request(createApp({ db, config: config(), log })).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "cloud-control", release: "test-release", db: "ok" });
  });

  it("answers 503 when the database is unreachable", async () => {
    const dead = createCloudDb("postgres://nobody:nothing@127.0.0.1:1/none", { max: 1 });
    const res = await request(createApp({ db: dead.db, config: config(), log })).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.db).toBe("down");
    await dead.close();
  });
});

describe("/internal (operator surface)", () => {
  it("refuses without the admin bearer", async () => {
    const app = createApp({ db, config: config(), log });
    expect((await request(app).get("/internal/settings")).status).toBe(401);
    expect((await request(app).get("/internal/settings").set("authorization", "Bearer wrong")).status).toBe(401);
    expect((await request(app).get("/internal/settings").set("authorization", ADMIN)).status).toBe(401);
  });

  it("refuses a caller outside the IP allow-list even with the bearer", async () => {
    const app = createApp({ db, config: config({ CLOUD_ADMIN_ALLOWED_IPS: "203.0.113.0/24" }), log });
    const res = await request(app).get("/internal/settings").set("authorization", `Bearer ${ADMIN}`);
    expect(res.status).toBe(403);
    const none = createApp({ db, config: config({ CLOUD_ADMIN_ALLOWED_IPS: "" }), log });
    expect((await request(none).get("/internal/settings").set("authorization", `Bearer ${ADMIN}`)).status).toBe(403);
  });

  it("reads the client IP from X-Real-IP only when configured to", async () => {
    const edge = createApp({ db, config: config({ CLOUD_ADMIN_ALLOWED_IPS: "203.0.113.7", CLOUD_CLIENT_IP_SOURCE: "x-real-ip" }), log });
    const ok = await request(edge).get("/internal/settings").set("authorization", `Bearer ${ADMIN}`).set("x-real-ip", "203.0.113.7");
    expect(ok.status).toBe(200);
    const socket = createApp({ db, config: config({ CLOUD_ADMIN_ALLOWED_IPS: "203.0.113.7" }), log });
    const spoof = await request(socket).get("/internal/settings").set("authorization", `Bearer ${ADMIN}`).set("x-real-ip", "203.0.113.7");
    expect(spoof.status).toBe(403);
  });

  it("serves settings, boxes and waitlist approval with the bearer", async () => {
    const app = createApp({ db, config: config(), log });
    const auth = { authorization: `Bearer ${ADMIN}` };
    const s = await request(app).get("/internal/settings").set(auth);
    expect(s.body).toMatchObject({ waitlist_mode: true, daily_cap: 10, max_concurrent_jobs: 3 });
    expect((await request(app).put("/internal/settings/daily_cap").set(auth).send({ value: "12" })).body).toEqual({ key: "daily_cap", value: 12 });
    expect((await request(app).put("/internal/settings/daily_cap").set(auth).send({ value: "lots" })).status).toBe(400);
    expect((await request(app).put("/internal/settings/nope").set(auth).send({ value: 1 })).status).toBe(404);
    expect((await request(app).get("/internal/boxes").set(auth)).body).toEqual({ boxes: [] });
    const [w] = await db.insert(waitlist).values({ email: "queue@example.com" }).returning();
    const listed = await request(app).get("/internal/waitlist").set(auth);
    expect(listed.body.waitlist.map((r: { id: string }) => r.id)).toContain(w!.id);
    const approved = await request(app).post(`/internal/waitlist/${w!.id}/approve`).set(auth);
    expect(approved.body.waitlist).toMatchObject({ id: w!.id, state: "approved", approvedBy: "admin-cli" });
    expect((await request(app).post(`/internal/waitlist/${w!.id}/approve`).set(auth)).status).toBe(404);
    expect((await request(app).post(`/internal/waitlist/not-a-uuid/approve`).set(auth)).status).toBe(400);
  });

  it("never logs the admin bearer or the Railway token", () => {
    const all = logLines.join("\n");
    expect(all).not.toContain(ADMIN);
    expect(all).not.toContain("railway-token-fake-for-tests-000");
  });
});

describe("/internal jobs and failed-box actions (GH #764)", () => {
  it("lists jobs, retries a failed box at its step, abandons it, and approval provisions a waitlisted box", async () => {
    const app = createApp({ db, config: config(), log });
    const auth = { authorization: `Bearer ${ADMIN}` };
    const [acct] = await db.insert(accounts).values({ email: "failed-box@example.test" }).returning();
    const [box] = await db.insert(boxes).values({ accountId: acct!.id, slug: "failedbox" }).returning();
    for (const s of ["provisioning", "failed"] as const) await db.update(boxes).set({ state: s }).where(eq(boxes.id, box!.id));
    const [job] = await db.insert(jobs).values({ boxId: box!.id, kind: "provision" }).returning();
    for (const s of ["running", "failed"] as const) await db.update(jobs).set({ state: s, step: "deploy", attempt: 5 }).where(eq(jobs.id, job!.id));

    const listed = await request(app).get("/internal/jobs?state=failed").set(auth);
    expect(listed.body.jobs.map((j: { id: string }) => j.id)).toContain(job!.id);
    expect((await request(app).get("/internal/jobs?state=nope").set(auth)).status).toBe(400);
    expect((await request(app).post("/internal/boxes/Not_A_Slug/retry").set(auth)).status).toBe(400);
    expect((await request(app).post("/internal/boxes/nosuchbox/retry").set(auth)).status).toBe(404);

    const retried = await request(app).post("/internal/boxes/failedbox/retry").set(auth);
    expect(retried.body).toEqual({ slug: "failedbox", jobId: job!.id, step: "deploy" });
    expect((await request(app).post("/internal/boxes/failedbox/retry").set(auth)).status).toBe(409);

    // Back to failed, then abandon.
    await db.update(jobs).set({ state: "running" }).where(eq(jobs.id, job!.id));
    await db.update(jobs).set({ state: "failed" }).where(eq(jobs.id, job!.id));
    await db.update(boxes).set({ state: "failed" }).where(eq(boxes.id, box!.id));
    const abandoned = await request(app).post("/internal/boxes/failedbox/abandon").set(auth);
    expect(abandoned.status).toBe(200);
    expect(abandoned.body.deleteJobId).toBeTruthy();

    // Approval of a waitlisted box queues it when provisioning is on.
    await request(app).put("/internal/settings/provisioning_enabled").set(auth).send({ value: true });
    const [acct2] = await db.insert(accounts).values({ email: "waiting-box@example.test" }).returning();
    const [box2] = await db.insert(boxes).values({ accountId: acct2!.id, slug: "waitingbox", state: "waitlisted" }).returning();
    const [w] = await db.insert(waitlist).values({ accountId: acct2!.id, email: "waiting-box@example.test" }).returning();
    const approved = await request(app).post(`/internal/waitlist/${w!.id}/approve`).set(auth);
    expect(approved.body.provisioning).toEqual([{ slug: "waitingbox", outcome: "queued" }]);
    const [b2] = await db.select().from(boxes).where(eq(boxes.id, box2!.id));
    expect(b2!.state).toBe("provisioning");
    await request(app).put("/internal/settings/provisioning_enabled").set(auth).send({ value: false });
  });
});

describe("admin CLI", () => {
  let server: Server;
  let url: string;
  beforeAll(async () => {
    server = createApp({ db, config: config(), log }).listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function io() {
    const out: string[] = [];
    const err: string[] = [];
    let calls = 0;
    return {
      out,
      err,
      calls: () => calls,
      io: {
        out: (l: string) => out.push(l),
        err: (l: string) => err.push(l),
        fetch: ((...args: Parameters<typeof fetch>) => {
          calls += 1;
          return fetch(...args);
        }) as typeof fetch,
      },
    };
  }

  it("refuses to run without the admin bearer and makes no request", async () => {
    const t = io();
    const code = await runAdmin(["settings", "get"], { CLOUD_CONTROL_URL: url }, t.io);
    expect(code).toBe(2);
    expect(t.calls()).toBe(0);
    expect(t.err.join("")).toMatch(/CLOUD_ADMIN_TOKEN/);
  });

  it("fails with a wrong bearer", async () => {
    const t = io();
    expect(await runAdmin(["settings", "get"], { CLOUD_CONTROL_URL: url, CLOUD_ADMIN_TOKEN: "wrong" }, t.io)).toBe(1);
    expect(t.err.join("")).toMatch(/401/);
  });

  it("gets and sets settings, lists boxes and the waitlist, approves", async () => {
    const env = { CLOUD_CONTROL_URL: url, CLOUD_ADMIN_TOKEN: ADMIN };
    let t = io();
    expect(await runAdmin(["settings", "set", "rollout_paused", "true"], env, t.io)).toBe(0);
    t = io();
    expect(await runAdmin(["settings", "get", "rollout_paused"], env, t.io)).toBe(0);
    expect(JSON.parse(t.out.join(""))).toEqual({ key: "rollout_paused", value: true });
    t = io();
    expect(await runAdmin(["boxes", "list"], env, t.io)).toBe(0);
    const [w] = await db.insert(waitlist).values({ email: "cli@example.com" }).returning();
    t = io();
    expect(await runAdmin(["waitlist", "list"], env, t.io)).toBe(0);
    expect(t.out.join("")).toContain(w!.id);
    t = io();
    expect(await runAdmin(["waitlist", "approve", w!.id], env, t.io)).toBe(0);
    t = io();
    expect(await runAdmin(["jobs", "list"], env, t.io)).toBe(0);
    expect(JSON.parse(t.out.join(""))).toHaveProperty("jobs");
    t = io();
    expect(await runAdmin(["boxes", "retry", "nosuchbox"], env, t.io)).toBe(1);
    expect(t.err.join("")).toMatch(/404/);
    t = io();
    expect(await runAdmin(["bogus"], env, t.io)).toBe(64);
  });
});
