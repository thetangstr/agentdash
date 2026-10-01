// SC-10 (GH #771): fleet health, alerts, the Free idle policy, suspend and
// wake, the spend alarm. Embedded Postgres migrated with the real role split,
// a fake Railway API, a fake clock and fake mail and alert transports. No
// real Railway, Resend or box is ever called.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAdmin } from "../admin/run.js";
import { createCloudDb, migrateWithRoles, type CloudDb } from "../db/client.js";
import { accounts, boxEvents, boxes, boxHealth, boxHealthChecks, boxIdleNotices, fleetAlerts, jobs, monitorReadings, operatorAudit, type BoxState } from "../db/schema.js";
import { createEdgeServer } from "../edge/proxy.js";
import { pgRouteSource, RouteTable } from "../edge/routes.js";
import { EdgeStats } from "../edge/stats.js";
import { encryptField, parseKeyring } from "../crypto.js";
import type { MailMessage, Mailer } from "../front-door/mailer.js";
import type { Alert, Alerter } from "../jobs/alerts.js";
import { JobRunner } from "../jobs/runner.js";
import { createLogger } from "../logger.js";
import { alertCenter, ALERT_FLAP_WINDOW_MS, ALERT_REPEAT_MS } from "../monitor/alert-center.js";
import { checkCertificates, checkRouter5xx, checkSpend } from "../monitor/checks.js";
import { HEALTH_FAILURE_THRESHOLD, pollFleetHealth } from "../monitor/health.js";
import { DAY_MS, sweepIdle } from "../monitor/idle.js";
import { loadMonitorConfig, pruneFleetHistory, runExclusive } from "../monitor/service.js";
import { boxProjectDescription } from "../railway/names.js";
import { boxHealthReport, fleetStatus, operatorSuspend, operatorWake } from "../monitor/status.js";
import { resumeHandler, suspendHandler } from "../monitor/suspend.js";
import { parseSettingValue, SETTING_DEFAULTS, settingsService } from "../settings.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";
import { FAKE_WORKSPACE } from "./fake-railway.js";
import { FakeRailwayBoxes } from "./fake-railway-boxes.js";

const RUNTIME_PW = "rtpw0123456789abcdefABCDEF0123"; // synthetic
const EDGE_PW = "edgepw0123456789abcdefABCDEF01"; // synthetic
const KEYS = parseKeyring("66".repeat(32));
const EDGE_DOMAIN = "agentdash.cloud";

let tdb: TestDatabase;
let db: CloudDb;
let close: () => Promise<void>;
let edgeSql: postgres.Sql;
let runtimeSql: postgres.Sql;
const logLines: string[] = [];
const log = createLogger({ write: (l) => logLines.push(l), level: "debug" });
const sent: Alert[] = [];
const alerter: Alerter = { send: async (a) => void sent.push(a) };
let seq = 0;

/** A fake clock the tests move by hand. */
const clock = { t: new Date("2026-10-01T12:00:00Z").getTime() };
const now = () => new Date(clock.t);
const advance = (ms: number) => void (clock.t += ms);

function asUser(user: string, password: string): string {
  const u = new URL(tdb.url);
  u.username = user;
  u.password = password;
  return u.toString();
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await migrateWithRoles(tdb.url, { runtimePassword: RUNTIME_PW, edgePassword: EDGE_PW });
  ({ db, close } = createCloudDb(tdb.url));
  edgeSql = postgres(asUser("cloud_edge", EDGE_PW), { max: 2, onnotice: () => {} });
  runtimeSql = postgres(asUser("cloud_app", RUNTIME_PW), { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await edgeSql?.end({ timeout: 5 });
  await runtimeSql?.end({ timeout: 5 });
  await close?.();
  await tdb?.stop();
});

beforeEach(async () => {
  sent.length = 0;
  clock.t = new Date("2026-10-01T12:00:00Z").getTime();
  await db.execute(sql`truncate settings`);
  await db.execute(sql`update jobs set state = 'dead' where state in ('queued', 'running', 'failed')`);
  // Leave earlier tests' boxes out of fleet-wide passes (and the spend count).
  await db.execute(sql`update boxes set state = 'pending_delete' where state in ('active', 'suspended')`);
  await db.execute(sql`update boxes set state = 'deleted' where state = 'pending_delete'`);
  await db.execute(sql`truncate fleet_alerts, edge_stats, monitor_readings`);
});

async function setting(key: Parameters<ReturnType<typeof settingsService>["set"]>[0], value: unknown) {
  await settingsService(db).set(key, value, "test");
}

async function makeBox(state: BoxState, extra: Partial<typeof boxes.$inferInsert> = {}) {
  const n = ++seq;
  const [acct] = await db.insert(accounts).values({ email: `owner${n}@example.test` }).returning();
  const [box] = await db.insert(boxes).values({ accountId: acct!.id, slug: `mon${n}box` }).returning();
  const path: Record<string, BoxState[]> = {
    active: ["provisioning", "awaiting_claim", "active"],
    suspended: ["provisioning", "awaiting_claim", "active", "suspended"],
    awaiting_claim: ["provisioning", "awaiting_claim"],
  };
  for (const s of path[state] ?? []) await db.update(boxes).set({ state: s }).where(eq(boxes.id, box!.id));
  await db.update(boxes).set({ upstreamHost: `web-mon${n}.up.railway.app`, ...extra }).where(eq(boxes.id, box!.id));
  const [fresh] = await db.select().from(boxes).where(eq(boxes.id, box!.id));
  return { ...fresh!, email: acct!.email };
}

const boxRow = async (id: string) => (await db.select().from(boxes).where(eq(boxes.id, id)))[0]!;

/** A fetch for box health: per-host answers, default healthy. */
function healthFetch(answers: Map<string, number | "down">): typeof fetch {
  return (async (input: string | URL | Request) => {
    const host = new URL(String(input instanceof Request ? input.url : input)).host;
    const a = answers.get(host) ?? 200;
    if (a === "down") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    return new Response(JSON.stringify(a === 200 ? { status: "ok", releaseTag: "v2026.930.0" } : { error: "x" }), { status: a, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function recordingMailer(opts: { fail?: boolean } = {}): Mailer & { messages: MailMessage[] } {
  const messages: MailMessage[] = [];
  return {
    messages,
    async send(m) {
      if (opts.fail) throw new Error("Resend answered HTTP 500");
      messages.push(m);
    },
  };
}

// ---------------------------------------------------------------------------

describe("alert center: dedupe, reminders, flap suppression, recovery", () => {
  it("notifies once, reminds after 6 h, recovers once, and suppresses a quick flap until it lasts", async () => {
    const alerts = alertCenter({ db, alerter, log, now });
    const a: Alert = { kind: "box_unhealthy", subject: "box x down", slug: "x" };
    expect(await alerts.fire("k1", a)).toBe("notified");
    advance(60_000);
    expect(await alerts.fire("k1", a)).toBe("suppressed");
    expect(sent).toHaveLength(1);
    advance(ALERT_REPEAT_MS);
    expect(await alerts.fire("k1", a)).toBe("reminded");
    expect(sent.at(-1)!.subject).toMatch(/^still failing: /);

    advance(60_000);
    expect(await alerts.resolve("k1")).toBe(true);
    expect(sent.at(-1)).toMatchObject({ resolved: true, subject: "resolved: box x down" });
    expect(await alerts.resolve("k1")).toBe(false); // already resolved: no second notice
    const count = sent.length;

    // Comes straight back within the flap window of the last notice: suppressed.
    // (The reminder above was 1 min before the resolve, so it is recent.)
    advance(60_000);
    expect(await alerts.fire("k1", a)).toBe("suppressed");
    expect(sent).toHaveLength(count);
    // A quiet recovery for an episode that was never notified.
    expect(await alerts.resolve("k1")).toBe(true);
    expect(sent).toHaveLength(count);
    // Flapping again, then it stays down past the flap window: now it is notified.
    advance(60_000);
    expect(await alerts.fire("k1", a)).toBe("suppressed");
    advance(ALERT_FLAP_WINDOW_MS);
    expect(await alerts.fire("k1", a)).toBe("notified");
    expect(sent).toHaveLength(count + 1);
    const [row] = await db.select().from(fleetAlerts).where(eq(fleetAlerts.key, "k1"));
    expect(row).toMatchObject({ state: "firing", suppressedCount: 3 });
  });
});

describe("health poller (spec §6.3)", () => {
  it("an induced failure alerts after exactly 3 polls, then recovers with one notice", async () => {
    const box = await makeBox("active");
    const answers = new Map<string, number | "down">();
    const alerts = alertCenter({ db, alerter, log, now });
    const deps = { db, log, alerts, edgeDomain: EDGE_DOMAIN, fetch: healthFetch(answers), now };

    expect(await pollFleetHealth(deps, "direct")).toMatchObject({ checked: 1, ok: 1 });
    let [h] = await db.select().from(boxHealth).where(eq(boxHealth.boxId, box.id));
    expect(h).toMatchObject({ status: "ok", consecutiveFailures: 0, release: "v2026.930.0" });
    expect((await boxRow(box.id)).lastHealth).toMatchObject({ status: "ok", path: "direct", releaseTag: "v2026.930.0" });

    answers.set(box.upstreamHost!, "down");
    for (let i = 1; i < HEALTH_FAILURE_THRESHOLD; i++) {
      advance(60_000);
      await pollFleetHealth(deps, "direct");
      expect(sent.filter((a) => a.kind === "box_unhealthy")).toHaveLength(0);
    }
    [h] = await db.select().from(boxHealth).where(eq(boxHealth.boxId, box.id));
    expect(h).toMatchObject({ status: "ok", consecutiveFailures: 2 }); // a blip is not an outage
    advance(60_000);
    await pollFleetHealth(deps, "direct");
    const fired = sent.filter((a) => a.kind === "box_unhealthy");
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ slug: box.slug, boxId: box.id });
    expect(fired[0]!.subject).toMatch(/failed 3 health checks in a row \(Railway host\)/);
    [h] = await db.select().from(boxHealth).where(eq(boxHealth.boxId, box.id));
    expect(h).toMatchObject({ status: "failing", consecutiveFailures: 3 });
    expect(h!.lastError).toMatch(/unreachable/);

    // Still down: deduplicated.
    advance(60_000);
    await pollFleetHealth(deps, "direct");
    expect(sent.filter((a) => a.kind === "box_unhealthy")).toHaveLength(1);

    answers.delete(box.upstreamHost!);
    advance(60_000);
    expect(await pollFleetHealth(deps, "direct")).toMatchObject({ recovered: 1 });
    expect(sent.at(-1)).toMatchObject({ resolved: true, kind: "box_unhealthy" });
    const history = await db.select().from(boxHealthChecks).where(eq(boxHealthChecks.boxId, box.id));
    expect(history.map((c) => c.ok)).toEqual([true, false, false, false, false, true]);
  });

  it("polls the router path on the slug host, and skips boxes with a live suspend, resume or upgrade job", async () => {
    const box = await makeBox("active");
    const busy = await makeBox("active");
    await db.insert(jobs).values({ boxId: busy.id, kind: "upgrade" });
    const seen: string[] = [];
    const f = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as typeof fetch;
    const r = await pollFleetHealth({ db, log, alerts: alertCenter({ db, alerter, log, now }), edgeDomain: EDGE_DOMAIN, fetch: f, now }, "router");
    expect(r).toMatchObject({ checked: 1, skipped: 1 });
    expect(seen).toEqual([`https://${box.slug}.${EDGE_DOMAIN}/api/health`]);
    // A 200 without status ok is a failure.
    const notOk = (async () => new Response(JSON.stringify({ status: "starting" }), { status: 200 })) as typeof fetch;
    expect(await pollFleetHealth({ db, log, alerts: alertCenter({ db, alerter, log, now }), edgeDomain: EDGE_DOMAIN, fetch: notOk, now }, "direct")).toMatchObject({ failed: 1 });
  });
});

describe("router 5xx and certificates", () => {
  it("alerts above 1 percent with enough traffic, from counts the router writes through its own role", async () => {
    // The router's role can call the function but not touch the table.
    await edgeSql`select edge_record_stats('replica-a', 150, 1)`;
    await expect(edgeSql`select count(*) from edge_stats`).rejects.toMatchObject({ code: "42501" });
    const alerts = alertCenter({ db, alerter, log });
    expect(await checkRouter5xx({ db, alerts })).toMatchObject({ requests: 150, serverErrors: 1, alerting: false });
    await edgeSql`select edge_record_stats('replica-b', 50, 3)`;
    const r = await checkRouter5xx({ db, alerts });
    expect(r).toMatchObject({ requests: 200, serverErrors: 4, alerting: true });
    expect(sent.at(-1)).toMatchObject({ kind: "router_5xx" });
    expect(sent.at(-1)!.subject).toMatch(/2\.00%/);
    // Garbage from a replica is clamped: never negative, never more errors than requests.
    await edgeSql`select edge_record_stats('replica-c', -5, 99)`;
    const [c] = await db.execute(sql`select requests, server_errors from edge_stats where replica = 'replica-c'`) as unknown as Array<{ requests: number; server_errors: number }>;
    expect(c).toEqual({ requests: 0, server_errors: 0 });
    // Below the minimum traffic, no alert: the old window has passed.
    await db.execute(sql`update edge_stats set created_at = now() - interval '1 hour'`);
    await edgeSql`select edge_record_stats('replica-a', 10, 5)`;
    expect(await checkRouter5xx({ db, alerts })).toMatchObject({ requests: 10, alerting: false });
    expect(sent.at(-1)).toMatchObject({ kind: "router_5xx", resolved: true });
  });

  it("counts the router's own responses: a waking page is not an error, a box 5xx and a dead box are", async () => {
    const stats = new EdgeStats();
    const upstream = http.createServer((req, res) => {
      res.writeHead(req.url === "/boom" ? 500 : 200).end("x");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const port = (upstream.address() as AddressInfo).port;
    const routes = {
      lookup: async (slug: string) =>
        slug === "sleepy"
          ? { slug, state: "suspended", upstreamHost: null, edgeSecret: null }
          : slug === "deadbox"
            ? { slug, state: "active", upstreamHost: "127.0.0.1:1", edgeSecret: { reveal: () => "s" } as never }
            : { slug, state: "active", upstreamHost: `127.0.0.1:${port}`, edgeSecret: { reveal: () => "s" } as never },
    };
    const edge = createEdgeServer({ routes, edgeDomain: EDGE_DOMAIN, log, clientIpSource: "socket", upstreamProtocol: "http", recordResponse: (e) => stats.record(e) });
    await new Promise<void>((r) => edge.listen(0, "127.0.0.1", r));
    const edgePort = (edge.address() as AddressInfo).port;
    const get = (host: string, path = "/") =>
      new Promise<number>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port: edgePort, path, headers: { host } }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on("error", reject);
      });
    try {
      expect(await get(`sleepy.${EDGE_DOMAIN}`)).toBe(503);
      expect(await get(`okbox.${EDGE_DOMAIN}`)).toBe(200);
      expect(await get(`okbox.${EDGE_DOMAIN}`, "/boom")).toBe(500);
      expect(await get(`deadbox.${EDGE_DOMAIN}`)).toBe(502);
      expect(stats.pending).toEqual({ requests: 4, serverErrors: 2 });
      await expect(stats.flush(async () => Promise.reject(new Error("db down")))).rejects.toThrow();
      expect(stats.pending).toEqual({ requests: 4, serverErrors: 2 }); // kept for the next flush
      let written: number[] = [];
      expect(await stats.flush(async (a, b) => void (written = [a, b]))).toBe(true);
      expect(written).toEqual([4, 2]);
      expect(stats.pending).toEqual({ requests: 0, serverErrors: 0 });
    } finally {
      await new Promise((r) => edge.close(r));
      await new Promise((r) => upstream.close(r));
    }
  });

  it("alerts on a certificate under 14 days, recovers after renewal, and never pages on an unreadable one", async () => {
    const alerts = alertCenter({ db, alerter, log, now });
    const expiry = new Map<string, Date | Error>([
      ["www.agentdash.cloud", new Date(clock.t + 10 * DAY_MS)],
      ["edge.agentdash.cloud", new Error("ETIMEDOUT")],
    ]);
    const read = async (host: string) => {
      const v = expiry.get(host)!;
      if (v instanceof Error) throw v;
      return { validTo: v };
    };
    const hosts = ["www.agentdash.cloud", "edge.agentdash.cloud"];
    const r = await checkCertificates({ db, alerts, log, hosts, read, now });
    expect(r).toEqual([
      { host: "www.agentdash.cloud", daysLeft: 10, error: null, alerting: true },
      { host: "edge.agentdash.cloud", daysLeft: null, error: "ETIMEDOUT", alerting: false },
    ]);
    expect(sent.filter((a) => a.kind === "cert_expiry")).toHaveLength(1);
    expiry.set("www.agentdash.cloud", new Date(clock.t + 80 * DAY_MS));
    await checkCertificates({ db, alerts, log, hosts, read, now });
    expect(sent.at(-1)).toMatchObject({ kind: "cert_expiry", resolved: true });
  });

  it("chooses certificate hosts from the environment", () => {
    expect(loadMonitorConfig({}, { edgeDomain: EDGE_DOMAIN, edgeLive: false }).certHosts).toEqual(["www.agentdash.cloud"]);
    expect(loadMonitorConfig({}, { edgeDomain: EDGE_DOMAIN, edgeLive: true }).certHosts).toEqual(["www.agentdash.cloud", "edge.agentdash.cloud"]);
    expect(loadMonitorConfig({ CLOUD_CERT_CHECK_HOSTS: "none" }, { edgeDomain: EDGE_DOMAIN, edgeLive: true }).certHosts).toEqual([]);
    expect(() => loadMonitorConfig({ CLOUD_CERT_CHECK_HOSTS: "https://x" }, { edgeDomain: EDGE_DOMAIN, edgeLive: true })).toThrow(/not a host name/);
  });
});

describe("spend alarm (spec §5.1)", () => {
  it("is 'not available' with no estimate configured, and never invents a number", async () => {
    const alerts = alertCenter({ db, alerter, log, now });
    const r = await checkSpend({ db, alerts, log, now });
    expect(r.reading).toMatchObject({ available: false, source: "none" });
    expect(r.tripped).toBe(false);
    const [reading] = await db.select().from(monitorReadings).where(eq(monitorReadings.kind, "spend"));
    expect(reading!.value).toBeNull();
    expect(sent).toHaveLength(0);
    // An alarm that cannot be evaluated says so.
    await setting("spend_alarm_usd", 100);
    await checkSpend({ db, alerts, log, now });
    expect(sent.at(-1)).toMatchObject({ kind: "spend_alarm" });
    expect(sent.at(-1)!.subject).toMatch(/no spend reading is available/);
  });

  it("trips the kill switch (audited) and pages above the alarm; resolves below it without turning provisioning back on", async () => {
    await makeBox("active");
    await makeBox("active");
    await makeBox("suspended");
    await setting("spend_estimate_box_usd", 7);
    await setting("spend_estimate_suspended_box_usd", "1.5");
    await setting("spend_alarm_usd", 10);
    await db.execute(sql`insert into settings (key, value, updated_by) values ('provisioning_enabled', 'true'::jsonb, 'test') on conflict (key) do update set value = 'true'::jsonb`);
    const alerts = alertCenter({ db, alerter, log, now });
    const r = await checkSpend({ db, alerts, log, now });
    expect(r.reading).toMatchObject({ available: true, source: "estimate", monthlyUsd: 15.5, basis: { runningBoxes: 2, suspendedBoxes: 1 } });
    expect(r).toMatchObject({ tripped: true, killSwitchTurnedOff: true });
    expect(await settingsService(db).get("provisioning_enabled")).toBe(false);
    const audit = await db.select().from(operatorAudit).where(eq(operatorAudit.actor, "spend-alarm"));
    expect(audit[0]!.detail).toMatchObject({ setting: "provisioning_enabled", from: true, to: false });
    expect(sent.at(-1)).toMatchObject({ kind: "spend_alarm" });
    expect(sent.at(-1)!.detail).toMatch(/provisioning was turned OFF/);

    await setting("spend_alarm_usd", 50);
    expect(await checkSpend({ db, alerts, log, now })).toMatchObject({ tripped: false });
    expect(sent.at(-1)).toMatchObject({ kind: "spend_alarm", resolved: true });
    expect(await settingsService(db).get("provisioning_enabled")).toBe(false);
  });
});

describe("Free idle policy (spec §5.2)", () => {
  const idleAt = (days: number) => new Date(clock.t - days * DAY_MS);
  const deps = (mailer: Mailer) => ({ db, log, alerts: alertCenter({ db, alerter, log, now }), mailer, edgeDomain: EDGE_DOMAIN, now });
  const suspendJobs = async (boxId: string) => db.select().from(jobs).where(sql`${jobs.boxId} = ${boxId} and ${jobs.kind} = 'suspend' and ${jobs.state} = 'queued'`);

  it("does nothing while idle_suspend_enabled and idle_delete_enabled are off (the defaults)", async () => {
    expect(SETTING_DEFAULTS).toMatchObject({ idle_suspend_enabled: false, idle_delete_enabled: false, spend_alarm_usd: null });
    const box = await makeBox("active", { lastHumanRequestAt: idleAt(40) });
    const mail = recordingMailer();
    expect(await sweepIdle(deps(mail))).toMatchObject({ examined: 0 });
    expect(mail.messages).toHaveLength(0);
    expect(await suspendJobs(box.id)).toHaveLength(0);
  });

  it("warns at day 14, suspends at day 21, and walks the box through suspend, warning at 45 and deletion at 60", async () => {
    await setting("idle_suspend_enabled", true);
    const box = await makeBox("active", { lastHumanRequestAt: idleAt(13), masterKeyEscrow: "sealed-escrow-ciphertext" });
    const mail = recordingMailer();

    expect(await sweepIdle(deps(mail))).toMatchObject({ suspendWarned: 0 });
    advance(DAY_MS); // day 14
    expect(await sweepIdle(deps(mail))).toMatchObject({ suspendWarned: 1 });
    expect(mail.messages).toHaveLength(1);
    expect(mail.messages[0]).toMatchObject({ kind: "idle_suspend_warning", to: box.email });
    expect(mail.messages[0]!.text).toContain(`https://${box.slug}.agentdash.cloud`);
    expect(mail.messages[0]!.text).toMatch(/October 9, 2026/); // day 21 (idle since September 18)
    await sweepIdle(deps(mail)); // no second email for the same idle period
    expect(mail.messages).toHaveLength(1);

    advance(6 * DAY_MS); // day 20
    expect(await sweepIdle(deps(mail))).toMatchObject({ suspendQueued: 0 });
    advance(DAY_MS); // day 21
    expect(await sweepIdle(deps(mail))).toMatchObject({ suspendQueued: 1 });
    const [job] = await suspendJobs(box.id);
    expect(job!.payload).toMatchObject({ reason: "idle", requestedBy: "idle-policy" });

    // The job runs (see the suspend and wake suite); here the box is simply suspended.
    await db.update(jobs).set({ state: "dead" }).where(eq(jobs.id, job!.id));
    await db.update(boxes).set({ state: "suspended", suspendedAt: now() }).where(eq(boxes.id, box.id));

    // Deletion is a separate switch.
    advance(24 * DAY_MS); // day 45
    expect(await sweepIdle(deps(mail))).toMatchObject({ deleteWarned: 0 });
    await setting("idle_delete_enabled", true);
    expect(await sweepIdle(deps(mail))).toMatchObject({ deleteWarned: 1 });
    expect(mail.messages.at(-1)).toMatchObject({ kind: "idle_delete_warning" });
    expect(mail.messages.at(-1)!.text).toMatch(/November 17, 2026/); // day 60
    advance(14 * DAY_MS); // day 59
    expect(await sweepIdle(deps(mail))).toMatchObject({ deleteStarted: 0 });
    advance(DAY_MS); // day 60
    expect(await sweepIdle(deps(mail))).toMatchObject({ deleteStarted: 1 });
    const after = await boxRow(box.id);
    expect(after.state).toBe("pending_delete");
    expect(after.deleteAfter!.getTime()).toBe(clock.t + 30 * DAY_MS);
    expect(sent.at(-1)!.subject).toMatch(/entered the deletion flow after 60 idle days/);
    const notices = await db.select().from(boxIdleNotices).where(eq(boxIdleNotices.boxId, box.id));
    expect(notices.map((n) => n.kind).sort()).toEqual(["delete_warning", "suspend_warning"]);
  });

  it("exempts Pro and trialing boxes", async () => {
    await setting("idle_suspend_enabled", true);
    await setting("idle_delete_enabled", true);
    const pro = await makeBox("active", { planTier: "pro", lastHumanRequestAt: idleAt(90) });
    const trial = await makeBox("active", { planTier: "trialing", lastHumanRequestAt: idleAt(90) });
    const proSuspended = await makeBox("suspended", { planTier: "pro", lastHumanRequestAt: idleAt(90), masterKeyEscrow: "x" });
    const mail = recordingMailer();
    expect(await sweepIdle(deps(mail))).toMatchObject({ examined: 0 });
    expect(mail.messages).toHaveLength(0);
    for (const b of [pro, trial]) expect(await suspendJobs(b.id)).toHaveLength(0);
    expect((await boxRow(proSuspended.id)).state).toBe("suspended");
  });

  it("enabled late: a long-idle box is warned first and suspended only 7 days after the email", async () => {
    await setting("idle_suspend_enabled", true);
    const box = await makeBox("active", { lastHumanRequestAt: idleAt(40) });
    const mail = recordingMailer();
    expect(await sweepIdle(deps(mail))).toMatchObject({ suspendWarned: 1, suspendQueued: 0 });
    expect(mail.messages[0]!.text).toMatch(/October 8, 2026/); // now + 7 days, not the past
    advance(6 * DAY_MS);
    expect(await sweepIdle(deps(mail))).toMatchObject({ suspendQueued: 0 });
    advance(DAY_MS);
    expect(await sweepIdle(deps(mail))).toMatchObject({ suspendQueued: 1 });
    expect(await suspendJobs(box.id)).toHaveLength(1);
  });

  it("a failed email means no suspension; use after the warning starts a new idle period", async () => {
    await setting("idle_suspend_enabled", true);
    const box = await makeBox("active", { lastHumanRequestAt: idleAt(30) });
    expect(await sweepIdle(deps(recordingMailer({ fail: true })))).toMatchObject({ suspendWarned: 0 });
    advance(10 * DAY_MS);
    expect(await sweepIdle(deps(recordingMailer({ fail: true })))).toMatchObject({ suspendQueued: 0 });
    expect(await suspendJobs(box.id)).toHaveLength(0);

    const mail = recordingMailer();
    await sweepIdle(deps(mail)); // warned now
    // The owner comes back two days later: the router records the visit.
    advance(2 * DAY_MS);
    await db.update(boxes).set({ lastHumanRequestAt: now() }).where(eq(boxes.id, box.id));
    advance(8 * DAY_MS);
    expect(await sweepIdle(deps(mail))).toMatchObject({ suspendQueued: 0, suspendWarned: 0 }); // 8 idle days only
    advance(6 * DAY_MS); // 14 days since the visit
    expect(await sweepIdle(deps(mail))).toMatchObject({ suspendWarned: 1 });
    expect(mail.messages).toHaveLength(2);
  });

  it("never moves a box to pending_delete while it is waking (queued resume, router visit, operator wake)", async () => {
    await setting("idle_delete_enabled", true);
    const mail = recordingMailer();
    const dueBox = async () => {
      const b = await makeBox("suspended", { lastHumanRequestAt: idleAt(50), suspendedAt: idleAt(29), masterKeyEscrow: "sealed" });
      return b;
    };
    const a = await dueBox(); // a resume already queued (e.g. a wake still deploying)
    const b = await dueBox(); // a visit through the router
    const c = await dueBox(); // an operator wake
    await sweepIdle(deps(mail)); // deletion warnings
    advance(15 * DAY_MS);
    const [wake] = await db.insert(jobs).values({ boxId: a.id, kind: "resume" }).returning();
    await db.update(jobs).set({ state: "running", lockedBy: "w", lockedUntil: new Date(Date.now() + 60_000) }).where(eq(jobs.id, wake!.id));
    const [visited] = await edgeSql`select edge_request_resume(${b.slug}) as ok`;
    expect(visited!.ok).toBe(true);
    await operatorWake(db, c.slug, "test-operator");
    expect(await sweepIdle(deps(mail))).toMatchObject({ deleteStarted: 0 });
    for (const x of [a, b, c]) expect((await boxRow(x.id)).state).toBe("suspended");
    // The visit and the operator wake restarted the idle clock.
    expect((await boxRow(b.id)).lastHumanRequestAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((await boxRow(c.id)).lastHumanRequestAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // Control: with no wake, the same box does enter deletion.
    await db.update(jobs).set({ state: "dead" }).where(eq(jobs.boxId, a.id));
    expect(await sweepIdle(deps(mail))).toMatchObject({ deleteStarted: 1 });
    expect((await boxRow(a.id)).state).toBe("pending_delete");
  });

  it("does not enter deletion without the master key escrow; ops is told instead", async () => {
    await setting("idle_delete_enabled", true);
    const box = await makeBox("suspended", { lastHumanRequestAt: idleAt(50), suspendedAt: idleAt(29) });
    const mail = recordingMailer();
    await sweepIdle(deps(mail));
    advance(15 * DAY_MS);
    expect(await sweepIdle(deps(mail))).toMatchObject({ blocked: 1, deleteStarted: 0 });
    expect((await boxRow(box.id)).state).toBe("suspended");
    expect(sent.at(-1)).toMatchObject({ kind: "idle_policy", slug: box.slug });
    expect(sent.at(-1)!.subject).toMatch(/no master key escrow/);
  });
});

describe("suspend and wake (jobs, the router's wake page, the operator)", () => {
  function fakeWithBox(slug: string) {
    const fake = new FakeRailwayBoxes();
    fake.resolvers.unshift(
      {
        match: /deployments\(first:10/,
        op: "deploymentsList",
        resolve: (v) => {
          const i = v.i as { serviceId: string };
          return { deployments: { edges: [...fake.svc(i.serviceId).deployments].reverse().map((d) => ({ node: { id: d.id, status: d.status, createdAt: d.createdAt } })) } };
        },
      },
      {
        match: /deploymentRemove\(/,
        op: "deploymentRemove",
        resolve: (v) => {
          for (const s of fake.services.values()) for (const d of s.deployments) if (d.id === v.id) d.status = "REMOVED";
          return { deploymentRemove: true };
        },
      },
    );
    const project = fake.addProject({ name: `agentdash-box-${slug}`, workspaceId: FAKE_WORKSPACE });
    const env = fake.nextId("env");
    fake.envs.set(project.id, env);
    const web = { id: fake.nextId("svc"), projectId: project.id, name: "web", source: { image: "ghcr.io/x/y@sha256:ab" }, settings: {}, variables: {}, domains: [] as string[], deployments: [] as Array<{ id: string; status: string; createdAt: string; commitSha: string | null }>, triggers: [] };
    web.domains.push(`web-${slug}.up.railway.app`);
    fake.services.set(web.id, web);
    fake.deploy(web, null);
    return { fake, project, env, web };
  }

  async function railwayBox(state: BoxState, extra: Partial<typeof boxes.$inferInsert> = {}) {
    const n = ++seq;
    const slug = `wake${n}box`;
    const { fake, project, env, web } = fakeWithBox(slug);
    const [acct] = await db.insert(accounts).values({ email: `wake${n}@example.test` }).returning();
    const [b] = await db.insert(boxes).values({ accountId: acct!.id, slug }).returning();
    project.description = boxProjectDescription(b!.id);
    for (const s of ["provisioning", "awaiting_claim", "active", ...(state === "suspended" ? ["suspended"] : [])] as BoxState[]) {
      await db.update(boxes).set({ state: s }).where(eq(boxes.id, b!.id));
    }
    await db
      .update(boxes)
      .set({ projectId: project.id, environmentId: env, webServiceId: web.id, upstreamHost: web.domains[0], edgeSecretEnc: encryptField(KEYS, "edge-secret-fake-0123456789", "boxes.edge_secret_enc"), ...extra })
      .where(eq(boxes.id, b!.id));
    return { box: await boxRow(b!.id), fake, web, project };
  }

  function runner(fake: FakeRailwayBoxes) {
    const client = fake.client();
    return new JobRunner({
      db,
      log,
      alerter,
      handlers: [
        suspendHandler({ client, workspaceId: FAKE_WORKSPACE }),
        resumeHandler({ client, workspaceId: FAKE_WORKSPACE, fetch: fake.http, sleep: async () => {}, pollMs: 1 }),
      ],
    });
  }

  it("suspends a box (web deployment removed, data kept) and wakes it through the router's waking page", async () => {
    const { box, fake, web } = await railwayBox("active", { lastHumanRequestAt: new Date(Date.now() - 30 * DAY_MS) });
    const { jobId } = await operatorSuspend(db, box.slug, "test-operator");
    const r = runner(fake);
    expect(await r.runOnce()).toBe(jobId);
    expect((await db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!.state).toBe("succeeded");
    const suspended = await boxRow(box.id);
    expect(suspended.state).toBe("suspended");
    expect(suspended.suspendedAt).not.toBeNull();
    expect(web.deployments.map((d) => d.status)).toEqual(["REMOVED"]);
    expect(fake.ops()).toContain("deploymentRemove");
    expect(fake.ops()).not.toContain("projectDelete");

    // A visitor reaches the router: the waking page, and the router queues the resume.
    const table = new RouteTable({ source: pgRouteSource(edgeSql), dataKeys: KEYS, log });
    await table.refresh();
    const edge = createEdgeServer({
      routes: table,
      edgeDomain: EDGE_DOMAIN,
      log,
      clientIpSource: "socket",
      requestResume: async (slug) => void (await edgeSql`select edge_request_resume(${slug})`),
    });
    await new Promise<void>((res) => edge.listen(0, "127.0.0.1", res));
    const port = (edge.address() as AddressInfo).port;
    const page = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/", headers: { host: `${box.slug}.${EDGE_DOMAIN}` } }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on("error", reject);
    });
    await new Promise((res) => edge.close(res));
    expect(page.status).toBe(503);
    expect(page.body).toMatch(/Waking your workspace/);
    let resume: typeof jobs.$inferSelect | undefined;
    for (let i = 0; i < 50 && !resume; i++) {
      [resume] = await db.select().from(jobs).where(sql`${jobs.boxId} = ${box.id} and ${jobs.kind} = 'resume'`);
      if (!resume) await new Promise((res) => setTimeout(res, 20));
    }
    expect(resume!.payload).toMatchObject({ requestedBy: "edge" });

    const started = Date.now();
    expect(await r.runOnce()).toBe(resume!.id);
    expect((await db.select().from(jobs).where(eq(jobs.id, resume!.id)))[0]!.state).toBe("succeeded");
    const woken = await boxRow(box.id);
    expect(woken.state).toBe("active");
    expect(woken.suspendedAt).toBeNull();
    // The wake restarts the idle clock, so the next sweep does not pause it again.
    expect(woken.lastHumanRequestAt!.getTime()).toBeGreaterThanOrEqual(started - 1000);
    expect(web.deployments.map((d) => d.status)).toEqual(["REMOVED", "SUCCESS"]);
    // Same project and services: data (Postgres, volumes) was never touched.
    expect(fake.ops().filter((o) => /Create|Delete/.test(o))).toEqual([]);
    const events = await db.select({ kind: boxEvents.kind }).from(boxEvents).where(eq(boxEvents.boxId, box.id));
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["suspend_requested", "box_suspended", "box_resumed"]));
  });

  it("an idle suspend fails (box untouched) when the Free box moved to Pro after the sweep queued it", async () => {
    const { box, fake, web } = await railwayBox("active", { lastHumanRequestAt: new Date(Date.now() - 30 * DAY_MS) });
    const [job] = await db
      .insert(jobs)
      .values({ boxId: box.id, kind: "suspend", payload: { reason: "idle", requestedBy: "idle-policy", idleSince: box.lastHumanRequestAt!.toISOString() } })
      .returning();
    await db.update(boxes).set({ planTier: "pro" }).where(eq(boxes.id, box.id));
    await runner(fake).runOnce();
    expect((await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]!.state).toBe("dead");
    expect((await boxRow(box.id)).state).toBe("active");
    expect(web.deployments.map((d) => d.status)).toEqual(["SUCCESS"]);
    expect(fake.ops()).not.toContain("deploymentRemove");
  });

  it("refuses to suspend a project that does not carry this box's control-plane tag", async () => {
    const { box, fake, web, project } = await railwayBox("active");
    project.description = "someone else's project";
    const { jobId } = await operatorSuspend(db, box.slug, "test-operator");
    await runner(fake).runOnce();
    const [j] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(j).toMatchObject({ state: "dead" });
    expect(j!.lastError).toMatch(/control-plane tag/);
    expect((await boxRow(box.id)).state).toBe("active");
    expect(web.deployments.map((d) => d.status)).toEqual(["SUCCESS"]);
  });

  it("an idle suspend is dropped when the box was used after the sweep queued it", async () => {
    const { box, fake, web } = await railwayBox("active", { lastHumanRequestAt: new Date() });
    await db.insert(jobs).values({ boxId: box.id, kind: "suspend", payload: { reason: "idle", requestedBy: "idle-policy", idleSince: new Date(Date.now() - 22 * DAY_MS).toISOString() } });
    await runner(fake).runOnce();
    expect((await boxRow(box.id)).state).toBe("active");
    expect(web.deployments.map((d) => d.status)).toEqual(["SUCCESS"]);
  });

  it("a wake waits for a suspend still in flight; operators can only wake suspended boxes and suspend active ones", async () => {
    const { box, fake } = await railwayBox("suspended", { suspendedAt: new Date() });
    await db.insert(jobs).values({ boxId: box.id, kind: "suspend", state: "queued", runAfter: new Date(Date.now() + 3_600_000) });
    const { jobId } = await operatorWake(db, box.slug, "test-operator");
    await runner(fake).runOnce();
    const [j] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(j).toMatchObject({ state: "queued" });
    expect(j!.lastError).toMatch(/still being suspended/);
    await expect(operatorSuspend(db, box.slug, "x")).rejects.toMatchObject({ status: 409 });
    const active = await makeBox("active");
    await expect(operatorWake(db, active.slug, "x")).rejects.toMatchObject({ status: 409 });
    await expect(operatorWake(db, "nosuchbox", "x")).rejects.toMatchObject({ status: 404 });
  });
});

describe("operator surface", () => {
  it("fleet status and box health summarise the fleet without secrets", async () => {
    const box = await makeBox("active", { lastHumanRequestAt: new Date(clock.t - 15 * DAY_MS) });
    const answers = new Map<string, number | "down">([[box.upstreamHost!, 503]]);
    const alerts = alertCenter({ db, alerter, log, now });
    for (let i = 0; i < 3; i++) await pollFleetHealth({ db, log, alerts, edgeDomain: EDGE_DOMAIN, fetch: healthFetch(answers), now }, "direct");
    await checkSpend({ db, alerts, log, now });
    const s = await fleetStatus(db, { edgeLive: false, now });
    expect(s.health.direct).toMatchObject({ failing: 1 });
    expect(s.health.router).toMatch(/not polled/);
    expect(s.health.failing.find((f) => f.slug === box.slug)).toMatchObject({ consecutiveFailures: 3, lastError: "HTTP 503" });
    expect(s.alerts.list.map((a) => a.kind)).toContain("box_unhealthy");
    expect(s.spend).toMatchObject({ monthlyUsd: null, available: false });
    expect(s.idlePolicy).toMatchObject({ suspendEnabled: false, deleteEnabled: false });
    expect(s.idlePolicy.freeBoxes.idle14Plus).toBeGreaterThanOrEqual(1);

    const h = await boxHealthReport(db, box.slug, { now });
    expect(h.paths[0]).toMatchObject({ path: "direct", status: "failing", consecutiveFailures: 3 });
    expect(h.recentChecks).toHaveLength(3);
    expect(h.idle.idleDays).toBe(15);
    expect(h.idle.next).toMatch(/idle_suspend_enabled is off/);
    expect(JSON.stringify(h)).not.toMatch(/edge_secret|claim_code|escrow/i);
    await expect(boxHealthReport(db, "nosuchbox")).rejects.toMatchObject({ status: 404 });
  });

  it("admin CLI: fleet status, box health/suspend/wake, alerts list/test", async () => {
    const calls: string[] = [];
    const io = {
      out: () => {},
      err: () => {},
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(url).replace("http://localhost:3200/internal", "")}`);
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    };
    const env = { CLOUD_ADMIN_TOKEN: "t".repeat(40) };
    for (const argv of [["fleet", "status"], ["box", "health", "acme"], ["box", "suspend", "acme"], ["box", "wake", "acme"], ["alerts", "list"], ["alerts", "test"]]) {
      expect(await runAdmin(argv, env, io)).toBe(0);
    }
    expect(calls).toEqual(["GET /fleet/status", "GET /boxes/acme/health", "POST /boxes/acme/suspend", "POST /boxes/acme/wake", "GET /alerts", "POST /alerts/test"]);
    expect(await runAdmin(["box", "health"], env, io)).toBe(64);
  });

  it("validates the new settings", () => {
    expect(parseSettingValue("idle_suspend_enabled", "true")).toBe(true);
    expect(parseSettingValue("spend_alarm_usd", "250")).toBe(250);
    expect(parseSettingValue("spend_estimate_box_usd", "6.50")).toBe(6.5);
    expect(parseSettingValue("spend_alarm_usd", "null")).toBeNull();
    expect(() => parseSettingValue("spend_alarm_usd", "-1")).toThrow(/dollar amount/);
    expect(() => parseSettingValue("spend_alarm_usd", "lots")).toThrow(/dollar amount/);
  });

  it("a monitor pass runs on one replica at a time (advisory lock)", async () => {
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const first = runExclusive(db, 771_999, async () => {
      entered();
      await new Promise<void>((r) => (release = r));
    });
    await inside;
    let ran = false;
    expect(await runExclusive(db, 771_999, async () => void (ran = true))).toBe(false);
    expect(ran).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(await runExclusive(db, 771_999, async () => void (ran = true))).toBe(true);
  });

  it("closes a box's health alerts once it is no longer active", async () => {
    const box = await makeBox("active");
    const alerts = alertCenter({ db, alerter, log, now });
    const answers = new Map<string, number | "down">([[box.upstreamHost!, "down"]]);
    for (let i = 0; i < 3; i++) await pollFleetHealth({ db, log, alerts, edgeDomain: EDGE_DOMAIN, fetch: healthFetch(answers), now }, "direct");
    expect(sent.filter((a) => a.kind === "box_unhealthy")).toHaveLength(1);
    await db.update(boxes).set({ state: "suspended" }).where(eq(boxes.id, box.id));
    await pollFleetHealth({ db, log, alerts, edgeDomain: EDGE_DOMAIN, fetch: healthFetch(answers), now }, "direct");
    expect(sent.at(-1)).toMatchObject({ kind: "box_unhealthy", resolved: true });
    expect(sent.at(-1)!.detail).toMatch(/is suspended; no longer polled/);
    const [row] = await db.select().from(fleetAlerts).where(eq(fleetAlerts.key, `health:direct:${box.id}`));
    expect(row!.state).toBe("resolved");
  });

  it("history is pruned only through prune_fleet_history, never inside the last day", async () => {
    const box = await makeBox("active");
    await db.insert(boxHealthChecks).values([
      { boxId: box.id, path: "direct", ok: true, checkedAt: new Date(Date.now() - 40 * DAY_MS) },
      { boxId: box.id, path: "direct", ok: true, checkedAt: new Date(Date.now() - 3_600_000) },
    ]);
    await expect(runtimeSql`delete from box_health_checks`).rejects.toMatchObject({ code: "42501" });
    const [r] = await runtimeSql`select prune_fleet_history(0) as n`;
    expect(Number(r!.n)).toBeGreaterThanOrEqual(1);
    const left = await db.select().from(boxHealthChecks).where(eq(boxHealthChecks.boxId, box.id));
    expect(left).toHaveLength(1);
    expect(await pruneFleetHistory(db)).toBeGreaterThanOrEqual(0);
  });
});
