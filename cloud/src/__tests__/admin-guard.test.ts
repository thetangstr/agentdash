// GH #778: the operator surface's guard. X-Real-IP is refused from the
// private network, repeated failures lock the caller out, and settings
// changes and refusals are written to the append-only operator_audit table.
import { randomBytes } from "node:crypto";
import type { Request } from "express";
import request from "supertest";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FailureLimiter, fromPrivateNetwork } from "../auth.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { operatorAudit } from "../db/schema.js";
import { createLogger } from "../logger.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";

const ADMIN = randomBytes(32).toString("hex");
let pg: TestDatabase;
let db: CloudDb;
let close: () => Promise<void>;
const logLines: string[] = [];
const log = createLogger({ write: (l) => logLines.push(l), level: "debug" });

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: pg.url,
    CLOUD_DATA_KEY: "66".repeat(32),
    CLOUD_ADMIN_TOKEN: ADMIN,
    CLOUD_ADMIN_ALLOWED_IPS: "127.0.0.1,::1,203.0.113.7",
    ...extra,
  });
}

async function refusals() {
  return await db.select().from(operatorAudit).where(eq(operatorAudit.kind, "admin_refused")).orderBy(operatorAudit.id);
}

/** The audit write is fire-and-forget; give it a moment to land. */
async function settle() {
  await new Promise((r) => setTimeout(r, 150));
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

describe("fromPrivateNetwork (unit)", () => {
  const fake = (remoteAddress: string | undefined) => ({ socket: { remoteAddress }, headers: {} }) as unknown as Request;
  const cfg = (source: "socket" | "x-real-ip", cidrs = "fc00::/7,10.0.0.0/8") =>
    loadConfig({ DATABASE_URL: "postgres://x@y/z", CLOUD_DATA_KEY: "66".repeat(32), CLOUD_ADMIN_TOKEN: ADMIN, CLOUD_CLIENT_IP_SOURCE: source, CLOUD_PRIVATE_NETWORK_CIDRS: cidrs });

  it("flags a private-network socket only when X-Real-IP is the source", () => {
    expect(fromPrivateNetwork(fake("fd12:abcd::5"), cfg("x-real-ip"))).toBe(true);
    expect(fromPrivateNetwork(fake("::ffff:10.2.3.4"), cfg("x-real-ip"))).toBe(true);
    expect(fromPrivateNetwork(fake("34.1.2.3"), cfg("x-real-ip"))).toBe(false);
    expect(fromPrivateNetwork(fake(undefined), cfg("x-real-ip"))).toBe(true);
    expect(fromPrivateNetwork(fake("fd12:abcd::5"), cfg("socket"))).toBe(false);
    expect(fromPrivateNetwork(fake("fd12:abcd::5"), cfg("x-real-ip", "none"))).toBe(false);
  });
});

describe("FailureLimiter (unit)", () => {
  it("locks after N failures for the window, then forgets", () => {
    let t = 0;
    const l = new FailureLimiter(3, 1000, () => t);
    expect(l.fail("a")).toBe(1);
    expect(l.fail("a")).toBe(2);
    expect(l.lockedFor("a")).toBe(0);
    expect(l.fail("a")).toBe(3);
    expect(l.lockedFor("a")).toBe(1000);
    expect(l.lockedFor("b")).toBe(0);
    t = 400;
    expect(l.lockedFor("a")).toBe(600);
    t = 1000;
    expect(l.lockedFor("a")).toBe(0);
    expect(l.fail("a")).toBe(1);
    l.succeed("a");
    expect(l.fail("a")).toBe(1);
  });

  it("stays bounded under a scan from many addresses", () => {
    const l = new FailureLimiter(3, 1000, () => 0, 100);
    for (let i = 0; i < 1000; i++) l.fail(`10.0.${i >> 8}.${i & 255}`);
    // Only the most recent 100 are remembered.
    expect(l.lockedFor("10.0.0.0")).toBe(0);
    for (let i = 0; i < 2; i++) l.fail("10.0.3.231");
    expect(l.lockedFor("10.0.3.231")).toBe(1000);
  });
});

describe("X-Real-IP from the private network", () => {
  it("is refused even with an allow-listed X-Real-IP and the right bearer, and audited", async () => {
    // Supertest connects from loopback; treat loopback as "the private network" here.
    const app = createApp({ db, config: config({ CLOUD_CLIENT_IP_SOURCE: "x-real-ip", CLOUD_PRIVATE_NETWORK_CIDRS: "127.0.0.0/8,::1/128" }), log });
    const res = await request(app).get("/internal/settings").set("authorization", `Bearer ${ADMIN}`).set("x-real-ip", "203.0.113.7");
    expect(res.status).toBe(403);
    await settle();
    const [last] = await db.select().from(operatorAudit).orderBy(desc(operatorAudit.id)).limit(1);
    expect(last).toMatchObject({ kind: "admin_refused", actor: "unauthenticated", ip: null });
    expect(last!.detail).toMatchObject({ reason: "private_network", path: "/settings", method: "GET" });
    expect(["127.0.0.1", "::1"]).toContain((last!.detail as { socketIp: string }).socketIp);
  });

  it("is accepted from a socket outside the private network", async () => {
    const app = createApp({ db, config: config({ CLOUD_CLIENT_IP_SOURCE: "x-real-ip", CLOUD_PRIVATE_NETWORK_CIDRS: "fc00::/7,10.0.0.0/8" }), log });
    const res = await request(app).get("/internal/settings").set("authorization", `Bearer ${ADMIN}`).set("x-real-ip", "203.0.113.7");
    expect(res.status).toBe(200);
  });
});

describe("brute-force limit on /internal", () => {
  let t = 0;
  beforeEach(() => {
    t = 1_000_000;
  });

  it("locks an IP out after repeated bad bearers, even for the right bearer, until the window passes", async () => {
    const cfg = config({ CLOUD_ADMIN_MAX_FAILURES: "3", CLOUD_ADMIN_LOCKOUT_SECONDS: "60" });
    const limiter = new FailureLimiter(cfg.adminMaxFailures, cfg.adminLockoutMs, () => t);
    const app = createApp({ db, config: cfg, log, admin: { limiter, now: () => t } });
    const before = (await refusals()).length;
    const guess = `Bearer ${randomBytes(32).toString("hex")}`;
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get("/internal/settings").set("authorization", guess)).status).toBe(401);
    }
    const locked = await request(app).get("/internal/settings").set("authorization", `Bearer ${ADMIN}`);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBe(60);
    t += 60_000;
    expect((await request(app).get("/internal/settings").set("authorization", `Bearer ${ADMIN}`)).status).toBe(200);
    await settle();
    const rows = (await refusals()).slice(before);
    // Three audited refusals (the third marks the lockout); the 429 writes
    // nothing. Audit writes are asynchronous, so compare without order.
    expect(rows.map((r) => (r.detail as { reason: string }).reason).sort()).toEqual(["bad_bearer", "bad_bearer", "locked_out"]);
    for (const r of rows) expect(["127.0.0.1", "::1"]).toContain(r.ip);
    expect(JSON.stringify(rows)).not.toContain(guess.slice(7));
    expect(JSON.stringify(rows)).not.toContain(ADMIN);
  });

  it("caps audited refusals per minute across callers; refusals still happen", async () => {
    const cfg = config({ CLOUD_ADMIN_ALLOWED_IPS: "203.0.113.0/24", CLOUD_ADMIN_MAX_FAILURES: "1000" });
    const app = createApp({ db, config: cfg, log, admin: { maxAuditsPerMinute: 2, now: () => t } });
    const before = (await refusals()).length;
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get("/internal/settings").set("authorization", `Bearer ${ADMIN}`)).status).toBe(403);
    }
    await settle();
    expect((await refusals()).length - before).toBe(2);
    t += 60_000;
    expect((await request(app).get("/internal/boxes")).status).toBe(403);
    await settle();
    expect((await refusals()).length - before).toBe(3);
  });
});

describe("setting changes through /internal", () => {
  it("are audited with the caller IP and the old and new value", async () => {
    const app = createApp({ db, config: config(), log });
    const res = await request(app).put("/internal/settings/provisioning_enabled").set("authorization", `Bearer ${ADMIN}`).send({ value: true });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(operatorAudit).where(eq(operatorAudit.kind, "setting_changed")).orderBy(desc(operatorAudit.id)).limit(1);
    expect(row).toMatchObject({ actor: "admin-cli", detail: { setting: "provisioning_enabled", from: false, to: true } });
    expect(["127.0.0.1", "::1"]).toContain(row!.ip);
  });

  it("never log the bearer", () => {
    expect(logLines.join("\n")).not.toContain(ADMIN);
  });
});
