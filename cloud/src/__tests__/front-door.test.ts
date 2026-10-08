// SC-7 (GH #768): the front door — /api/cloud/* — against embedded Postgres,
// a capturing mailer, a fake MX resolver, a fake Turnstile and, end to end, a
// fake provisioner in the real job runner.
import { randomBytes } from "node:crypto";
import http from "node:http";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { encryptField, sha256Hex } from "../crypto.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { accounts, boxEvents, boxes, emailTokens, inviteCodes, jobs, signupRequests, waitlist } from "../db/schema.js";
import { hasMx, isDisposableDomain, normaliseEmail } from "../front-door/email-policy.js";
import type { MailMessage } from "../front-door/mailer.js";
import { inviteService } from "../invites.js";
import { frontDoor, type FrontDoor, MAX_SLUG_HOLDS } from "../front-door/service.js";
import { logMailer, emails } from "../front-door/mailer.js";
import { pruneRateEvents } from "../front-door/rate-limit.js";
import { type JobHandler, JobRunner } from "../jobs/runner.js";
import { createLogger } from "../logger.js";
import { settingsService } from "../settings.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";

// The capabilities module is frozen in production; this suite swaps in a mutable stand-in.
const caps = vi.hoisted(() => ({ claimTrackingReady: false, failBeforeQueue: false, terminalBeforeQueue: null as "failed" | "pending_delete" | "cleanup" | null }));
vi.mock("../capabilities.js", () => ({ capabilities: caps }));
vi.mock("../jobs/queue.js", async importOriginal => {
  const original = await importOriginal<typeof import("../jobs/queue.js")>();
  return { ...original, requestProvision: async (...args: Parameters<typeof original.requestProvision>) => {
    if (caps.failBeforeQueue) { caps.failBeforeQueue = false; throw new Error("synthetic interruption after admission commit"); }
    if (caps.terminalBeforeQueue) {
      const state = caps.terminalBeforeQueue;
      caps.terminalBeforeQueue = null;
      const [connection, boxId] = args;
      await connection.update(boxes).set({ state: "provisioning" }).where(eq(boxes.id, boxId));
      if (state === "pending_delete") {
        await connection.update(boxes).set({ state: "awaiting_claim" }).where(eq(boxes.id, boxId));
        await connection.update(boxes).set({ state: "active" }).where(eq(boxes.id, boxId));
      } else await connection.update(boxes).set({ state: "failed" }).where(eq(boxes.id, boxId));
      await connection.update(boxes).set({ state }).where(eq(boxes.id, boxId));
    }
    return await original.requestProvision(...args);
  } };
});

// supertest given a bare app starts and stops a server per request on an
// ephemeral port, which intermittently reset or crossed connections when a
// port was reused at once. Every app here listens once, for the whole suite.
http.globalAgent = new http.Agent({ keepAlive: false });
const servers: http.Server[] = [];
type AppT = ReturnType<typeof createApp>;
type Target = AppT | http.Server;
async function serve(app: AppT): Promise<http.Server> {
  const server = app.listen(0, "127.0.0.1");
  // Wait until it listens: supertest calls listen() itself (and later close())
  // on a server that has no address yet, which reset requests mid-flight.
  await new Promise<void>((r) => server.once("listening", () => r()));
    servers.push(server);
  return server;
}
const ADMIN = randomBytes(32).toString("hex");
const IP_HEADER = "x-agentdash-client-ip";
const PROXY_HEADER = "x-agentdash-edge-proxy";
// A CSPRNG-shaped proxy secret (config refuses weak ones).
const PROXY_SECRET = randomBytes(32).toString("hex");
let pg: TestDatabase;
let db: CloudDb;
let close: () => Promise<void>;
const logLines: string[] = [];
const log = createLogger({ write: (l) => logLines.push(l), level: "debug" });
const mail: MailMessage[] = [];
let clockOffsetMs = 0;
let turnstileAnswer = true;
let seq = 0;

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: pg.url,
    CLOUD_DATA_KEY: "44".repeat(32),
    CLOUD_ADMIN_TOKEN: ADMIN,
    CLOUD_ADMIN_ALLOWED_IPS: "127.0.0.1,::1",
    CLOUD_PUBLIC_SITE_URL: "https://www.agentdash.test",
    CLOUD_VERCEL_PROXY_SECRET: PROXY_SECRET,
    CLOUD_DISPOSABLE_DOMAINS_EXTRA: "throwaway.test",
    ...extra,
  });
}

const TURNSTILE = { CLOUD_TURNSTILE_SECRET_KEY: "turnstile-secret-for-tests", CLOUD_TURNSTILE_SITE_KEY: "site-key-for-tests" };

const fakeTurnstileFetch = (async (url: string | URL | Request) => {
  if (!String(url).includes("challenges.cloudflare.com")) throw new Error(`unexpected fetch ${String(url)}`);
  return new Response(JSON.stringify({ success: turnstileAnswer }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

async function build(extra: Record<string, string> = TURNSTILE): Promise<{ app: http.Server; fd: FrontDoor; cfg: ReturnType<typeof config> }> {
  const cfg = config(extra);
  const fd = frontDoor({
    db,
    log,
    config: cfg,
    mailer: { send: async (m) => void mail.push(m) },
    fetch: fakeTurnstileFetch,
    resolveMx: async (domain) => {
      if (domain.startsWith("nomx.")) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return [{ exchange: `mx.${domain}` }];
    },
    now: () => new Date(Date.now() + clockOffsetMs),
  });
  return { app: await serve(createApp({ db, config: cfg, log, frontDoor: fd })), fd, cfg };
}

/** A fresh identity per test so the per-IP, per-domain and per-email counts never collide. */
function who(opts: { freemail?: boolean } = {}) {
  const n = ++seq;
  const tag = `${n}${Date.now() % 100000}`;
  return {
    email: opts.freemail ? `person${tag}@gmail.com` : `founder@co${tag}.test`,
    slug: `ws${tag}`.slice(0, 16),
    ip: `198.51.${n % 250}.${(Math.floor(Date.now() / 1000) + n) % 250}`,
  };
}

async function signup(app: Target, w: { email: string; slug: string; ip: string }, over: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/cloud/signup")
    .set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, w.ip)
    .send({ email: w.email, workspaceName: "Acme Robotics", slug: w.slug, acceptTerms: true, turnstileToken: "tok", ...over });
  lastSignup = { status: res.status, body: res.body, who: w };
  return res;
}

let lastSignup: unknown = null;
function lastMailTo(email: string, kind?: MailMessage["kind"]): MailMessage {
  const m = [...mail].reverse().find((x) => x.to === email && (!kind || x.kind === kind));
  if (!m) throw new Error(`no ${kind ?? ""} mail to ${email}; got ${mail.map((x) => `${x.kind}:${x.to}`).join(", ")}; last signup answered ${JSON.stringify(lastSignup)}`);
  return m;
}

function tokenFrom(m: MailMessage): string {
  const match = /\/start\/verify#token=([A-Za-z0-9_-]+)/.exec(m.text);
  if (!match) throw new Error(`no magic link in ${m.kind} mail`);
  return match[1]!;
}

async function verify(app: Target, token: string, ip = "203.0.113.9") {
  return await request(app).post("/api/cloud/verify").set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, ip).send({ token });
}

function cookieOf(res: request.Response): string {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const c = raw?.find((x) => x.startsWith("agd_cloud_session="));
  if (!c) throw new Error("no session cookie");
  return c.split(";")[0]!;
}

async function setSetting(key: Parameters<ReturnType<typeof settingsService>["set"]>[0], value: unknown) {
  await settingsService(db).set(key, value, "test");
}

beforeAll(async () => {
  pg = await startTestDatabase();
  await migrateCloudDb(pg.url);
  ({ db, close } = createCloudDb(pg.url));
});

afterAll(async () => {
  await Promise.all(servers.map((sv) => new Promise<void>((r) => sv.close(() => r()))));
  await close?.();
  await pg?.stop();
});

beforeEach(async () => {
  mail.length = 0;
  clockOffsetMs = 0;
  turnstileAnswer = true;
  caps.claimTrackingReady = false;
  caps.failBeforeQueue = false;
  caps.terminalBeforeQueue = null;
  await db.execute(sql`truncate settings`);
  await db.execute(sql`update jobs set state = 'dead' where state in ('queued', 'running', 'failed')`);
});

describe("email policy", () => {
  it("normalises addresses and refuses junk", () => {
    expect(normaliseEmail("  Founder@Acme.COM ")).toBe("founder@acme.com");
    expect(normaliseEmail("not-an-email")).toBeNull();
    expect(normaliseEmail("a@b")).toBeNull();
    expect(normaliseEmail(42)).toBeNull();
  });

  it("knows disposable domains and their subdomains, with operator overrides", () => {
    expect(isDisposableDomain("mailinator.com")).toBe(true);
    expect(isDisposableDomain("eu.mailinator.com")).toBe(true);
    expect(isDisposableDomain("acme.com")).toBe(false);
    expect(isDisposableDomain("throwaway.test", { extra: ["throwaway.test"] })).toBe(true);
    expect(isDisposableDomain("mailinator.com", { allow: ["mailinator.com"] })).toBe(false);
  });

  it("needs an MX record; a failed or null-MX lookup counts as none", async () => {
    expect(await hasMx("acme.test", { resolve: async () => [{ exchange: "mx.acme.test" }] })).toBe(true);
    expect(await hasMx("acme.test", { resolve: async () => [{ exchange: "." }] })).toBe(false);
    expect(await hasMx("acme.test", { resolve: async () => { throw new Error("ENOTFOUND"); } })).toBe(false);
    expect(await hasMx("acme.test", { resolve: () => new Promise(() => {}), timeoutMs: 20 })).toBe(false);
  });
});

describe("POST /api/cloud/signup", () => {
  it("accepts a good signup and mails a single-use magic link; nothing else is created yet", async () => {
    const { app } = await build();
    const w = who();
    const res = await signup(app, w);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    const m = lastMailTo(w.email, "verify");
    expect(m.text).toContain(`https://www.agentdash.test/start/verify#token=`);
    expect(m.text).toContain(w.slug);
    const [acct] = await db.select().from(accounts).where(eq(accounts.email, w.email));
    expect(acct!.status).toBe("pending_verification");
    expect(await db.select().from(boxes).where(eq(boxes.slug, w.slug))).toHaveLength(0);
    // Only the token's hash is stored.
    const [tok] = await db.select().from(emailTokens).where(eq(emailTokens.accountId, acct!.id));
    expect(tok!.tokenHash).toBe(sha256Hex(tokenFrom(m)));
    expect(logLines.join("\n")).not.toContain(tokenFrom(m));
  });

  it("validates the form: email, name, terms, slug", async () => {
    const { app } = await build();
    const w = who();
    expect((await signup(app, w, { email: "nope" })).body.code).toBe("invalid_email");
    expect((await signup(app, w, { workspaceName: "" })).body.code).toBe("invalid_name");
    expect((await signup(app, w, { acceptTerms: false })).body.code).toBe("terms_required");
    expect((await signup(app, { ...who(), slug: "www" })).body.code).toBe("slug_reserved");
    expect((await signup(app, { ...who(), slug: "Bad Slug!" })).body.code).toBe("slug_invalid");
  });

  it("refuses a failed Turnstile check when Turnstile is configured", async () => {
    const { app } = await build();
    turnstileAnswer = false;
    const res = await signup(app, who());
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("bot_check_failed");
  });

  it("refuses disposable addresses and domains without MX", async () => {
    const { app } = await build();
    const a = await signup(app, { ...who(), email: "x@mailinator.com" });
    expect(a.status).toBe(400);
    expect(a.body.code).toBe("disposable_email");
    expect((await signup(app, { ...who(), email: "x@throwaway.test" })).body.code).toBe("disposable_email");
    const b = await signup(app, { ...who(), email: "x@nomx.example.test" });
    expect(b.body.code).toBe("no_mx");
  });

  it("limits one address to 3 signups an hour", async () => {
    const { app } = await build();
    const ip = `192.0.2.${seq % 250}`;
    for (let i = 0; i < 3; i++) expect((await signup(app, { ...who(), ip })).status).toBe(202);
    const fourth = await signup(app, { ...who(), ip });
    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe("rate_limited");
  });

  it("believes the client-IP header only with the proxy secret (GH #836 review)", async () => {
    const { app } = await build();
    // Forged header, no secret: every request is keyed by the real (socket) address, 127.0.0.1,
    // so rotating the forged address does not escape the 3-an-hour limit.
    await db.execute(sql`insert into rate_events (bucket, key) select 'signup_ip', '127.0.0.1' from generate_series(1, 3)`);
    const forged = await request(app).post("/api/cloud/signup").set(IP_HEADER, "203.0.113.77")
      .send({ email: who().email, workspaceName: "Acme", slug: who().slug, acceptTerms: true, turnstileToken: "tok" });
    expect(forged.status).toBe(429);
    const wrong = await request(app).post("/api/cloud/signup").set(PROXY_HEADER, "not-the-secret").set(IP_HEADER, "203.0.113.78")
      .send({ email: who().email, workspaceName: "Acme", slug: who().slug, acceptTerms: true, turnstileToken: "tok" });
    expect(wrong.status).toBe(429);
    // With the secret, the header's address is the key.
    const w = who();
    expect((await signup(app, w)).status).toBe(202);
    const rows = (await db.execute(sql`select ip from signup_requests order by created_at desc limit 1`)) as unknown as Array<{ ip: string }>;
    expect(rows[0]!.ip).toBe(w.ip);
  });

  it("ignores the client-IP header entirely when no proxy secret is configured", async () => {
    const { app } = await build({ ...TURNSTILE, CLOUD_VERCEL_PROXY_SECRET: "" });
    const res = await request(app).post("/api/cloud/signup").set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, "203.0.113.79")
      .send({ email: who().email, workspaceName: "Acme", slug: who().slug, acceptTerms: true, turnstileToken: "tok" });
    expect(res.status).toBe(429); // keyed by 127.0.0.1, which the previous test filled
  });

  it("refuses a slug another pending signup holds, and a slug a box has", async () => {
    const { app } = await build();
    const a = who();
    expect((await signup(app, a)).status).toBe(202);
    const clash = await signup(app, { ...who(), slug: a.slug });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("slug_taken");
    // Once the first link expires, the name is free again.
    clockOffsetMs = 31 * 60_000;
    expect((await signup(app, { ...who(), slug: a.slug })).status).toBe(202);
  });

  it("answers 503 (never 202) when email is not configured", async () => {
    const cfg = config(TURNSTILE);
    const app = await serve(createApp({ db, config: cfg, log })); // no Resend key: the unconfigured mailer
    expect((await request(app).get("/api/cloud/config")).body.signupOpen).toBe(false);
    const res = await signup(app, who());
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("signup_unavailable");
  });
});

describe("magic links", () => {
  it("are single use: the second use is refused", async () => {
    const { app } = await build();
    const w = who();
    await signup(app, w);
    const token = tokenFrom(lastMailTo(w.email, "verify"));
    const first = await verify(app, token);
    expect(first.status).toBe(200);
    expect(cookieOf(first)).toMatch(/^agd_cloud_session=/);
    const second = await verify(app, token);
    expect(second.status).toBe(410);
    expect(second.body.code).toBe("link_used");
  });

  it("expire after 30 minutes", async () => {
    const { app } = await build();
    const w = who();
    await signup(app, w);
    const token = tokenFrom(lastMailTo(w.email, "verify"));
    clockOffsetMs = 31 * 60_000;
    const res = await verify(app, token);
    expect(res.status).toBe(410);
    expect(res.body.code).toBe("link_expired");
    expect(await db.select().from(boxes).where(eq(boxes.slug, w.slug))).toHaveLength(0);
  });

  it("GET /verify never uses the token; it hands the browser to the page, token in the fragment", async () => {
    const { app } = await build();
    const w = who();
    await signup(app, w);
    const token = tokenFrom(lastMailTo(w.email, "verify"));
    const res = await request(app).get(`/api/cloud/verify?token=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`https://www.agentdash.test/start/verify#token=${token}`);
    expect((await verify(app, token)).status).toBe(200);
  });

  it("refuse garbage", async () => {
    const { app } = await build();
    expect((await verify(app, "short")).body.code).toBe("link_invalid");
    expect((await verify(app, "A".repeat(43))).body.code).toBe("link_invalid");
  });
});

describe("while provisioning is gated (claimTrackingReady=false)", () => {
  it("a verified signup waits on the list, nothing is queued, and the person is told", async () => {
    const { app } = await build();
    // Even an operator who stored provisioning_enabled=true before the gate cannot open it.
    await db.execute(sql`insert into settings (key, value) values ('provisioning_enabled', 'true'::jsonb), ('waitlist_mode', 'false'::jsonb)`);
    const w = who();
    await signup(app, w);
    const res = await verify(app, tokenFrom(lastMailTo(w.email, "verify")));
    expect(res.body).toMatchObject({ ok: true, outcome: "box_requested", provisioning: "waitlisted", reason: "kill_switch" });
    const [box] = await db.select().from(boxes).where(eq(boxes.slug, w.slug));
    expect(box!.state).toBe("waitlisted");
    expect(await db.select().from(jobs).where(eq(jobs.boxId, box!.id))).toHaveLength(0);
    expect(lastMailTo(w.email, "waitlisted").text).toContain(w.slug);

    const mine = await request(app).get("/api/cloud/boxes/mine").set("cookie", cookieOf(res));
    expect(mine.status).toBe(200);
    expect(mine.body.boxes[0]).toMatchObject({ slug: w.slug, phase: "waitlisted", claimUrl: null });
  });

  it("an operator's approval leaves the box approved-pending: still no job", async () => {
    const { app } = await build();
    const w = who();
    await signup(app, w);
    const v = await verify(app, tokenFrom(lastMailTo(w.email, "verify")));
    const [entry] = await db.select().from(waitlist).where(eq(waitlist.email, w.email));
    const approve = await request(app).post(`/internal/waitlist/${entry!.id}/approve`).set("authorization", `Bearer ${ADMIN}`);
    expect(approve.status).toBe(200);
    expect(approve.body.provisioning).toEqual([{ slug: w.slug, outcome: "waitlisted", reason: "kill_switch" }]);
    expect(lastMailTo(w.email, "approved").text).toContain("when capacity is available");
    const mine = await request(app).get("/api/cloud/boxes/mine").set("cookie", cookieOf(v));
    expect(mine.body.boxes[0].phase).toBe("approved");
    const [box] = await db.select().from(boxes).where(eq(boxes.slug, w.slug));
    expect(await db.select().from(jobs).where(eq(jobs.boxId, box!.id))).toHaveLength(0);
    // The release pass does nothing while the gate is shut.
    const release = await request(app).post("/internal/waitlist/release").set("authorization", `Bearer ${ADMIN}`);
    expect(release.body.released.every((r: { outcome: string }) => r.outcome === "waitlisted")).toBe(true);
    expect(await db.select().from(jobs).where(eq(jobs.boxId, box!.id))).toHaveLength(0);
  });

  it("the public config says new signups wait", async () => {
    const { app } = await build();
    const res = await request(app).get("/api/cloud/config");
    expect(res.body).toEqual({ turnstileSiteKey: "site-key-for-tests", signupOpen: true, invitationCodesEnabled: true, waitlist: true, edgeDomain: "agentdash.cloud" });
  });
});

describe("with provisioning open (capability mocked on)", () => {
  beforeEach(async () => {
    caps.claimTrackingReady = true;
    await setSetting("provisioning_enabled", true);
  });

  it("the kill switch sends signups to the waitlist", async () => {
    const { app } = await build();
    await setSetting("provisioning_enabled", false);
    await setSetting("waitlist_mode", false);
    const w = who();
    await signup(app, w);
    const res = await verify(app, tokenFrom(lastMailTo(w.email, "verify")));
    expect(res.body.reason).toBe("kill_switch");
  });

  it("waitlist mode: the job starts only after `admin waitlist approve`", async () => {
    const { app } = await build();
    await setSetting("waitlist_mode", true);
    await setSetting("daily_cap", 1000);
    const w = who();
    await signup(app, w);
    const res = await verify(app, tokenFrom(lastMailTo(w.email, "verify")));
    expect(res.body.reason).toBe("waitlist_mode");
    const [box] = await db.select().from(boxes).where(eq(boxes.slug, w.slug));
    expect(await db.select().from(jobs).where(eq(jobs.boxId, box!.id))).toHaveLength(0);
    const [entry] = await db.select().from(waitlist).where(eq(waitlist.email, w.email));
    const approve = await request(app).post(`/internal/waitlist/${entry!.id}/approve`).set("authorization", `Bearer ${ADMIN}`);
    expect(approve.body.provisioning[0].outcome).toBe("queued");
    expect(await db.select().from(jobs).where(eq(jobs.boxId, box!.id))).toHaveLength(1);
    expect(lastMailTo(w.email, "approved").text).toContain("creating your workspace");
  });

  it("the daily cap overflows to the waitlist, and approved-pending boxes are released when there is room", async () => {
    const { app, fd } = await build();
    await setSetting("waitlist_mode", false);
    const today = (await db.execute(sql`select count(*)::int as n from jobs where kind = 'provision' and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`)) as unknown as Array<{ n: number }>;
    await setSetting("daily_cap", today[0]!.n + 1);
    const a = who();
    await signup(app, a);
    expect((await verify(app, tokenFrom(lastMailTo(a.email, "verify")))).body.provisioning).toBe("queued");
    const b = who();
    await signup(app, b);
    const over = await verify(app, tokenFrom(lastMailTo(b.email, "verify")));
    expect(over.body).toMatchObject({ provisioning: "waitlisted", reason: "daily_cap" });
    // An operator approves it; the cap still holds, so it stays approved-pending ...
    const [entry] = await db.select().from(waitlist).where(eq(waitlist.email, b.email));
    await request(app).post(`/internal/waitlist/${entry!.id}/approve`).set("authorization", `Bearer ${ADMIN}`);
    const [boxB] = await db.select().from(boxes).where(eq(boxes.slug, b.slug));
    expect(boxB!.state).toBe("waitlisted");
    // ... until there is room.
    await setSetting("daily_cap", 1000);
    const released = await fd.releaseApproved();
    expect(released).toContainEqual({ slug: b.slug, outcome: "queued" });
  });

  it("without Turnstile configured, a signup is accepted but only an operator can let it through", async () => {
    const { app } = await build({});
    await setSetting("waitlist_mode", false);
    await setSetting("daily_cap", 1000);
    expect((await request(app).get("/api/cloud/config")).body).toMatchObject({ turnstileSiteKey: null, waitlist: true });
    const w = who();
    await signup(app, w, { turnstileToken: undefined });
    const res = await verify(app, tokenFrom(lastMailTo(w.email, "verify")));
    expect(res.body).toMatchObject({ provisioning: "waitlisted", reason: "needs_approval" });
    const [entry] = await db.select().from(waitlist).where(eq(waitlist.email, w.email));
    const approve = await request(app).post(`/internal/waitlist/${entry!.id}/approve`).set("authorization", `Bearer ${ADMIN}`);
    expect(approve.body.provisioning[0].outcome).toBe("queued");
  });

  it("one Free box per verified email", async () => {
    const { app } = await build();
    await setSetting("waitlist_mode", false);
    await setSetting("daily_cap", 1000);
    const w = who();
    await signup(app, w);
    await verify(app, tokenFrom(lastMailTo(w.email, "verify")));
    const again = await signup(app, { ...who(), email: w.email });
    expect(again.status).toBe(202); // same answer: no hint either way
    const m = lastMailTo(w.email);
    expect(m.kind).toBe("already_have_box");
    const res = await verify(app, tokenFrom(m));
    expect(res.body.outcome).toBe("signed_in");
    const [acct] = await db.select().from(accounts).where(eq(accounts.email, w.email));
    expect(await db.select().from(boxes).where(eq(boxes.accountId, acct!.id))).toHaveLength(1);
  });

  it("one box a day from one address", async () => {
    const { app } = await build();
    await setSetting("waitlist_mode", false);
    await setSetting("daily_cap", 1000);
    const ip = `192.0.2.${200 + (seq % 50)}`;
    const a = { ...who(), ip };
    await signup(app, a);
    await verify(app, tokenFrom(lastMailTo(a.email, "verify")));
    const b = await signup(app, { ...who(), ip });
    expect(b.status).toBe(429);
    expect(b.body.code).toBe("ip_daily_limit");
  });

  it("five boxes a day for one company domain; freemail domains are exempt", async () => {
    const { app } = await build();
    await setSetting("waitlist_mode", false);
    await setSetting("daily_cap", 1000);
    const domain = `bigco${Date.now() % 100000}.test`;
    for (let i = 0; i < 5; i++) {
      const w = { ...who(), email: `p${i}@${domain}` };
      expect((await signup(app, w)).status).toBe(202);
      expect((await verify(app, tokenFrom(lastMailTo(w.email, "verify")))).status).toBe(200);
    }
    const sixth = await signup(app, { ...who(), email: `p6@${domain}` });
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe("domain_daily_limit");
    expect((await signup(app, who({ freemail: true }))).status).toBe(202);
  });
});

describe("end to end with a fake provisioner", () => {
  it.each(["manual", "invitation"])("signup, verify, %s approval, provision, ready email with the claim link, progress page shows it", async mode => {
    caps.claimTrackingReady = true;
    await setSetting("provisioning_enabled", true);
    await setSetting("waitlist_mode", true);
    await setSetting("daily_cap", 1000);
    const { app, fd, cfg } = await build();
    const w = who();

    expect((await request(app).get(`/api/cloud/slug-available?slug=${w.slug}`)).body).toEqual({ slug: w.slug, available: true });
    const invitation = mode === "invitation" ? await inviteService(db, cfg.dataKeys).addHosted("fake delivery", "test", null) : null;
    expect((await signup(app, w, invitation ? { invitationCode: invitation.code } : {})).status).toBe(202);
    const v = await verify(app, tokenFrom(lastMailTo(w.email, "verify")));
    const cookie = cookieOf(v);
    if (mode === "manual") expect(v.body.reason).toBe("waitlist_mode");
    else expect(v.body.provisioning).toBe("queued");
    expect((await request(app).get(`/api/cloud/slug-available?slug=${w.slug}`)).body.available).toBe(false);

    const [entry] = await db.select().from(waitlist).where(eq(waitlist.email, w.email));
    if (mode === "manual") await request(app).post(`/internal/waitlist/${entry!.id}/approve`).set("authorization", `Bearer ${ADMIN}`).expect(200);
    const during = await request(app).get("/api/cloud/boxes/mine").set("cookie", cookie);
    expect(during.body.boxes[0]).toMatchObject({ phase: "provisioning", stepIndex: 0, slow: false });

    // The fake provisioner does what the real one's last steps do: claim code, host, awaiting_claim, box_ready.
    const CODE = `AGD-${randomBytes(13).toString("hex").toUpperCase()}`;
    const fake: JobHandler = {
      kind: "provision",
      steps: [
        {
          name: "variables",
          timeoutMs: 10_000,
          async run(ctx) {
            const box = await ctx.box();
            await ctx.db.update(boxes).set({
              claimCodeEnc: encryptField(cfg.dataKeys, CODE, "boxes.claim_code_enc"),
              claimCodeHash: sha256Hex(CODE),
              claimExpiresAt: new Date(Date.now() + 7 * 86_400_000),
              upstreamHost: `web-${box.slug}.up.railway.app`,
              publicUrl: `https://${box.slug}.agentdash.cloud`,
            }).where(eq(boxes.id, box.id));
          },
        },
        {
          name: "publish",
          timeoutMs: 10_000,
          async run(ctx) {
            const box = await ctx.box();
            await ctx.db.update(boxes).set({ state: "awaiting_claim" }).where(eq(boxes.id, box.id));
            await ctx.db.insert(boxEvents).values({ boxId: box.id, kind: "box_ready", actor: "provisioner" });
          },
        },
      ],
    };
    const runner = new JobRunner({ db, log, handlers: [fake] });
    let ran = await runner.runOnce();
    while (ran) ran = await runner.runOnce();
    const [box] = await db.select().from(boxes).where(eq(boxes.slug, w.slug));
    expect(box!.state).toBe("awaiting_claim");

    expect(await fd.sendReadyEmails()).toBeGreaterThanOrEqual(1);
    const ready = lastMailTo(w.email, "ready");
    // No release reads the email from the fragment yet (CLAIM_EMAIL_IN_FRAGMENT_SINCE is null), so ?email=.
    const claimUrl = `https://${w.slug}.agentdash.cloud/claim?email=${encodeURIComponent(w.email)}#code=${CODE}`;
    expect(ready.text).toContain(claimUrl);
    // Once per box.
    mail.length = 0;
    await fd.sendReadyEmails();
    expect(mail.filter((m) => m.to === w.email)).toHaveLength(0);

    const after = await request(app).get("/api/cloud/boxes/mine").set("cookie", cookie);
    expect(after.body).toMatchObject({ email: w.email, boxes: [{ slug: w.slug, phase: "ready", claimUrl, url: `https://${w.slug}.agentdash.cloud` }] });
    expect(after.headers["cache-control"]).toBe("no-store");

    // "Resend my link" re-mails the claim link and never touches the box.
    const resend = await request(app).post("/api/cloud/resend").set("cookie", cookie).set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, w.ip).send({});
    expect(resend.status).toBe(202);
    expect(lastMailTo(w.email, "ready").text).toContain(claimUrl);

    // /find mails the workspaces for a known, verified address only.
    const find = await request(app).post("/api/cloud/find").set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, w.ip).send({ email: w.email, turnstileToken: "tok" });
    expect(find.status).toBe(202);
    expect(lastMailTo(w.email, "find").text).toContain(`${w.slug}: https://${w.slug}.agentdash.cloud`);
    mail.length = 0;
    const stranger = await request(app).post("/api/cloud/find").set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, w.ip).send({ email: "nobody@nowhere.test", turnstileToken: "tok" });
    expect(stranger.status).toBe(202);
    expect(mail).toHaveLength(0);
    // Nothing secret reached the log.
    expect(logLines.join("\n")).not.toContain(CODE);
  });
});

describe("the rest of the public surface", () => {
  it("boxes/mine needs a session", async () => {
    const { app } = await build();
    const res = await request(app).get("/api/cloud/boxes/mine");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("no_session");
    expect((await request(app).get("/api/cloud/boxes/mine").set("cookie", "agd_cloud_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(401);
  });

  it("resend by email re-mails the verify link of a pending signup, and nothing for a stranger", async () => {
    const { app } = await build();
    const w = who();
    await signup(app, w);
    const first = tokenFrom(lastMailTo(w.email, "verify"));
    const res = await request(app).post("/api/cloud/resend").set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, w.ip).send({ email: w.email });
    expect(res.status).toBe(202);
    const second = tokenFrom(lastMailTo(w.email, "verify"));
    expect(second).not.toBe(first);
    mail.length = 0;
    await request(app).post("/api/cloud/resend").set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, w.ip).send({ email: "nobody@nowhere.test" }).expect(202);
    expect(mail).toHaveLength(0);
  });

  it("refuses non-JSON posts and malformed JSON", async () => {
    const { app } = await build();
    expect((await request(app).post("/api/cloud/signup").type("form").send("email=a@b.c")).status).toBe(415);
    expect((await request(app).post("/api/cloud/signup").set("content-type", "application/json").send("{bad")).status).toBe(400);
  });

  it("slug-available explains why a name is not available", async () => {
    const { app } = await build();
    expect((await request(app).get("/api/cloud/slug-available?slug=admin")).body).toMatchObject({ available: false, reason: "reserved" });
    expect((await request(app).get("/api/cloud/slug-available?slug=A")).body).toMatchObject({ available: false, reason: "invalid" });
    expect((await request(app).get("/api/cloud/slug-available?slug=this-name-is-too-long")).body).toMatchObject({ available: false, reason: "invalid" });
  });

  it("find refuses a failed bot check", async () => {
    const { app } = await build();
    turnstileAnswer = false;
    const res = await request(app).post("/api/cloud/find").send({ email: "a@acme.test", turnstileToken: "x" });
    expect(res.body.code).toBe("bot_check_failed");
  });
});

describe("security review fixes (GH #836)", () => {
  it("reserves mail-provider labels and impersonation names", async () => {
    const { app } = await build();
    for (const slug of ["send", "bounce", "email", "click", "smtp", "mail", "anthropic", "openai", "google", "microsoft", "support", "billing", "security", "status"]) {
      expect((await request(app).get(`/api/cloud/slug-available?slug=${slug}`)).body.available, slug).toBe(false);
    }
  });

  it(`caps how often one email or address can hold the same unconfirmed name (${MAX_SLUG_HOLDS})`, async () => {
    const { app } = await build();
    const base = who();
    for (let i = 0; i < MAX_SLUG_HOLDS; i++) {
      clockOffsetMs = i * 31 * 60_000; // each earlier hold has expired
      expect((await signup(app, { ...base, ip: `192.0.2.${100 + i}` })).status).toBe(202);
    }
    clockOffsetMs = MAX_SLUG_HOLDS * 31 * 60_000;
    const res = await signup(app, { ...base, ip: "192.0.2.199" });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("slug_hold_limit");
    // Another person may still take the name once the holds have lapsed.
    expect((await signup(app, { ...who(), slug: base.slug })).status).toBe(202);
  });

  it("resend never stretches a hold past two hours from the signup", async () => {
    const { app } = await build();
    const w = who();
    await signup(app, w);
    clockOffsetMs = 2 * 3_600_000 + 60_000;
    mail.length = 0;
    await request(app).post("/api/cloud/resend").set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, w.ip).send({ email: w.email }).expect(202);
    expect(mail).toHaveLength(0);
  });

  it("prunes rate_events older than the longest window, keeping recent ones", async () => {
    await db.execute(sql`insert into rate_events (bucket, key, created_at) values ('prune_t', 'old', now() - interval '2 hours'), ('prune_t', 'new', now())`);
    expect(await pruneRateEvents(db)).toBeGreaterThanOrEqual(1);
    const left = (await db.execute(sql`select key from rate_events where bucket = 'prune_t'`)) as unknown as Array<{ key: string }>;
    expect(left.map((r) => r.key)).toEqual(["new"]);
  });

  it("refuses the log mail transport outside localhost, and redacts links in it", async () => {
    expect(() => config({ CLOUD_MAIL_TRANSPORT: "log" })).toThrow(/localhost/);
    expect(config({ CLOUD_MAIL_TRANSPORT: "log", CLOUD_PUBLIC_SITE_URL: "http://localhost:5173" }).frontDoor.mailTransport).toBe("log");
    const lines: string[] = [];
    const devLog = createLogger({ write: (l) => lines.push(l), level: "debug" });
    const token = "T".repeat(43);
    await logMailer(devLog).send(emails.verify("a@acme.test", { link: `http://localhost:5173/start/verify#token=${token}`, slug: "acme" }));
    expect(lines.join("\n")).not.toContain(token);
    expect(lines.join("\n")).toContain("#token=[redacted]");
  });

  it("find and resend answer before the email is sent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const cfg = config(TURNSTILE);
    const slowMail: MailMessage[] = [];
    const fd = frontDoor({
      db, log, config: cfg, fetch: fakeTurnstileFetch,
      resolveMx: async (d) => [{ exchange: `mx.${d}` }],
      mailer: { send: async (m) => { await gate; slowMail.push(m); } },
    });
    const app = await serve(createApp({ db, config: cfg, log, frontDoor: fd }));
    const w = who();
    // A verified account with a box, to make /find send something.
    const [acct] = await db.insert(accounts).values({ email: w.email, status: "pending_verification" }).returning();
    await db.update(accounts).set({ status: "active" }).where(eq(accounts.id, acct!.id));
    await db.insert(boxes).values({ accountId: acct!.id, slug: w.slug });
    const res = await request(app).post("/api/cloud/find").set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, w.ip).send({ email: w.email, turnstileToken: "tok" });
    expect(res.status).toBe(202);
    expect(slowMail).toHaveLength(0); // answered while the send is still pending
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(slowMail.map((m) => m.kind)).toEqual(["find"]);
  });

  it("slug holds count over a rolling day, so the cap lifts", async () => {
    const { app } = await build();
    const base = who();
    for (let i = 0; i < MAX_SLUG_HOLDS; i++) {
      clockOffsetMs = i * 31 * 60_000;
      expect((await signup(app, { ...base, ip: `192.0.2.${150 + i}` })).status).toBe(202);
    }
    clockOffsetMs = MAX_SLUG_HOLDS * 31 * 60_000;
    expect((await signup(app, { ...base, ip: "192.0.2.198" })).body.code).toBe("slug_hold_limit");
    // A day later (after the rate windows too), the same person may try again.
    await db.execute(sql`update signup_requests set created_at = created_at - interval '25 hours' where slug = ${base.slug}`);
    await db.execute(sql`update rate_events set created_at = created_at - interval '25 hours' where key = ${base.email}`);
    expect((await signup(app, { ...base, ip: "192.0.2.197" })).status).toBe(202);
  });

  it("GET /proxy-check reports only whether the proxy secret vouched for the request", async () => {
    const { app } = await build();
    const yes = await request(app).get("/api/cloud/proxy-check").set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, "198.51.100.44");
    expect(yes.status).toBe(200);
    expect(yes.body).toEqual({ trustedProxy: true });
    expect((await request(app).get("/api/cloud/proxy-check").set(IP_HEADER, "198.51.100.44")).body).toEqual({ trustedProxy: false });
    expect((await request(app).get("/api/cloud/proxy-check").set(PROXY_HEADER, "wrong").set(IP_HEADER, "198.51.100.44")).body).toEqual({ trustedProxy: false });
    expect(JSON.stringify(yes.body)).not.toContain("198.51.100.44");
    // Rate limited per address.
    let last = 200;
    for (let i = 0; i < 31; i++) last = (await request(app).get("/api/cloud/proxy-check").set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, "198.51.100.45")).status;
    expect(last).toBe(429);
  });
});

// Hosted admission uses only fake mail, ephemeral Postgres and queue jobs.
describe("hosted invitation admission", () => {
  async function hosted(app: Target) {
    const r = await request(app).post("/internal/invites/hosted").set("authorization", `Bearer ${ADMIN}`).send({ label: "synthetic beta" });
    expect(r.status).toBe(201);
    return r.body as { id: string; code: string };
  }
  const redeem = (app: Target, cookie: string | null, code: unknown, ip = who().ip) => {
    const req = request(app).post("/api/cloud/invitation/redeem").set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, ip);
    if (cookie) req.set("cookie", cookie);
    return req.send({ code });
  };
  async function waiting(app: Target) {
    const w = who();
    expect((await signup(app, w)).status).toBe(202);
    const v = await verify(app, tokenFrom(lastMailTo(w.email, "verify")));
    expect(v.status).toBe(200);
    const [box] = await db.select().from(boxes).where(eq(boxes.slug, w.slug));
    return { w, cookie: cookieOf(v), box: box! };
  }
  async function open() {
    caps.claimTrackingReady = true;
    await setSetting("provisioning_enabled", true);
    await setSetting("waitlist_mode", true);
    await setSetting("daily_cap", 1000);
  }

  it("keeps signup unconsumed and no-code waitlisted, then approves one verified hosted box without Turnstile", async () => {
    const { app, cfg } = await build({});
    await open();
    const a = await waiting(app);
    expect(a.box.state).toBe("waitlisted");
    const c = await hosted(app);
    const w = who();
    expect((await signup(app, w, { invitationCode: c.code })).status).toBe(202);
    const [proof] = await db.select().from(signupRequests).where(eq(signupRequests.slug, w.slug));
    expect(proof!.hostedInviteId).toBe(c.id);
    const [pending] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, c.id));
    expect(pending!.consumedAt).toBeNull();
    expect(await db.select().from(boxes).where(eq(boxes.slug, w.slug))).toHaveLength(0);
    expect(await inviteService(db, cfg.dataKeys).isValid(c.code)).toBe(false);
    const v = await verify(app, tokenFrom(lastMailTo(w.email, "verify")));
    expect(v.body).toMatchObject({ provisioning: "queued" });
    const [box] = await db.select().from(boxes).where(eq(boxes.slug, w.slug));
    const [used] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, c.id));
    expect(used).toMatchObject({ purpose: "hosted_beta", consumedByAccountId: box!.accountId, consumedBoxId: box!.id });
    expect(used!.consumedAt).toBeInstanceOf(Date);
    const [entitlement] = await db.select().from(waitlist).where(eq(waitlist.accountId, box!.accountId));
    expect(entitlement!.state).toBe("approved");
    expect(await db.select().from(jobs).where(eq(jobs.boxId, box!.id))).toHaveLength(1);
    expect((await verify(app, tokenFrom(lastMailTo(w.email, "verify")))).body.code).toBe("link_used");
    expect(logLines.join("\n")).not.toContain(c.code);
    expect(JSON.stringify(await db.select().from(inviteCodes))).not.toContain(c.code);
    expect(JSON.stringify(await db.execute(sql`select detail from operator_audit`))).not.toContain(c.code);
    expect(mail.map(m => m.text).join("\n")).not.toContain(c.code);
    expect((await request(app).get("/api/cloud/config")).body.invitationCodesEnabled).toBe(true);
  });

  it("rejects malformed, oversized, wrong-purpose, revoked, expired and used signup codes", async () => {
    const { app, cfg } = await build();
    const legacy = await inviteService(db, cfg.dataKeys).add("self hosted", "test", null);
    for (const code of [42, "x".repeat(121), "wrong-code", legacy.code]) {
      expect((await signup(app, who(), { invitationCode: code })).body.code).toBe("invitation_unavailable");
    }
    const c = await hosted(app);
    await db.update(inviteCodes).set({ expiresAt: new Date(0) }).where(eq(inviteCodes.id, c.id));
    expect((await signup(app, who(), { invitationCode: c.code })).body.code).toBe("invitation_unavailable");
    const revoked = await hosted(app);
    await inviteService(db, cfg.dataKeys).revoke(revoked.id, "test", null);
    expect((await signup(app, who(), { invitationCode: revoked.code })).body.code).toBe("invitation_unavailable");
    const used = await hosted(app);
    const a = await waiting(app);
    expect((await redeem(app, a.cookie, used.code)).status).toBe(200);
    expect((await signup(app, who(), { invitationCode: used.code })).body.code).toBe("invitation_unavailable");
  });

  it("rechecks revocation and rolls back email token/account/box on refusal", async () => {
    const { app, cfg } = await build();
    const c = await hosted(app);
    const w = who();
    await signup(app, w, { invitationCode: c.code });
    const t = tokenFrom(lastMailTo(w.email, "verify"));
    await inviteService(db, cfg.dataKeys).revoke(c.id, "test", null);
    const v = await verify(app, t);
    expect(v.body.code).toBe("invitation_unavailable");
    const [token] = await db.select().from(emailTokens).where(eq(emailTokens.tokenHash, sha256Hex(t)));
    expect(token!.usedAt).toBeNull();
    const [acct] = await db.select().from(accounts).where(eq(accounts.email, w.email));
    expect(acct!.status).toBe("pending_verification");
    expect(await db.select().from(boxes).where(eq(boxes.slug, w.slug))).toHaveLength(0);
    await db.update(inviteCodes).set({ revokedAt: null }).where(eq(inviteCodes.id, c.id));
    expect((await verify(app, t)).status).toBe(200);
  });

  it("resend preserves proof, and concurrent links for one email create one box and consume only one invitation", async () => {
    const { app } = await build();
    const c = await hosted(app);
    const w = who();
    await signup(app, w, { invitationCode: c.code });
    const oldToken = tokenFrom(lastMailTo(w.email, "verify"));
    expect((await request(app).post("/api/cloud/resend").set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, w.ip).send({ email: w.email })).status).toBe(202);
    const freshToken = tokenFrom(lastMailTo(w.email, "verify"));
    expect(freshToken).not.toBe(oldToken);
    const [proof] = await db.select().from(signupRequests).where(eq(signupRequests.slug, w.slug));
    expect(proof!.hostedInviteId).toBe(c.id);
    // The replaced link cannot create a box; the current request retains its invitation.
    await verify(app, freshToken);
    const [box] = await db.select().from(boxes).where(eq(boxes.slug, w.slug));
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.id, c.id)))[0]!.consumedBoxId).toBe(box!.id);
    const extra = await hosted(app);
    const another = who();
    const first = who();
    const second = who();
    await signup(app, another, { invitationCode: extra.code });
    const t1 = tokenFrom(lastMailTo(another.email, "verify"));
    const secondCode = await hosted(app);
    await signup(app, { ...second, email: another.email }, { invitationCode: secondCode.code });
    const t2 = tokenFrom(lastMailTo(another.email, "verify"));
    const result = await Promise.all([verify(app, t1, first.ip), verify(app, t2, second.ip)]);
    expect(result.map(r => r.status)).toEqual([200, 200]);
    const [acct] = await db.select().from(accounts).where(eq(accounts.email, another.email));
    expect(await db.select().from(boxes).where(eq(boxes.accountId, acct!.id))).toHaveLength(1);
    const invitations = await db.select().from(inviteCodes).where(sql`${inviteCodes.id} in (${extra.id}, ${secondCode.id})`);
    expect(invitations.filter(i => i.consumedAt)).toHaveLength(1);
  });

  it("concurrent accounts redeem exactly once; original-box retries are idempotent and strangers cannot redeem", async () => {
    const { app } = await build();
    const a = await waiting(app);
    const b = await waiting(app);
    const c = await hosted(app);
    const rs = await Promise.all([redeem(app, a.cookie, c.code), redeem(app, b.cookie, c.code)]);
    expect(rs.map(r => r.status).sort()).toEqual([200, 400]);
    const winner = rs[0]!.status === 200 ? a : b;
    const loser = winner === a ? b : a;
    const notifications = mail.filter(m => m.kind === "approved" && m.to === winner.w.email).length;
    expect((await redeem(app, winner.cookie, c.code)).body).toMatchObject({ ok: true, provisioning: "waitlisted" });
    expect(mail.filter(m => m.kind === "approved" && m.to === winner.w.email)).toHaveLength(notifications);
    expect((await redeem(app, loser.cookie, c.code)).body.code).toBe("invitation_unavailable");
    expect((await redeem(app, null, c.code)).body.code).toBe("no_session");
    const [row] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, c.id));
    expect(row!.consumedBoxId).toBe(winner.box.id);
    expect(await db.select().from(boxes).where(eq(boxes.accountId, winner.box.accountId))).toHaveLength(1);
    expect((await request(app).get("/api/cloud/boxes/mine").set("cookie", winner.cookie)).body.boxes[0]).toMatchObject({ slug: winner.w.slug, phase: "approved" });
    await db.update(accounts).set({ status: "blocked" }).where(eq(accounts.id, winner.box.accountId));
    expect((await redeem(app, winner.cookie, c.code)).status).toBe(401);
    await db.update(accounts).set({ status: "deleted" }).where(eq(accounts.id, loser.box.accountId));
    expect((await redeem(app, loser.cookie, c.code)).status).toBe(401);
  });

  it.each(["kill_switch", "claim_tracking", "daily_cap"])("preserves approval across %s deferral, then releases exactly once", async gate => {
    const { app, fd } = await build({});
    const a = await waiting(app);
    await open();
    if (gate === "kill_switch") await setSetting("provisioning_enabled", false);
    if (gate === "claim_tracking") caps.claimTrackingReady = false;
    if (gate === "daily_cap") await setSetting("daily_cap", 0);
    const c = await hosted(app);
    expect((await redeem(app, a.cookie, c.code)).body).toMatchObject({ provisioning: "waitlisted", reason: gate === "claim_tracking" ? "kill_switch" : gate });
    const [entry] = await db.select().from(waitlist).where(eq(waitlist.accountId, a.box.accountId));
    expect(entry!.state).toBe("approved");
    expect(lastMailTo(a.w.email, "approved").text).toContain("when capacity is available");
    expect(await db.select().from(jobs).where(eq(jobs.boxId, a.box.id))).toHaveLength(0);
    await open();
    expect(await fd.releaseApproved(1000)).toContainEqual({ slug: a.w.slug, outcome: "queued" });
    await fd.releaseApproved(1000);
    expect(await db.select().from(jobs).where(eq(jobs.boxId, a.box.id))).toHaveLength(1);
    expect((await redeem(app, a.cookie, c.code)).body.provisioning).toBe("already_started");
    const spare = await hosted(app);
    expect((await redeem(app, a.cookie, spare.code)).body.provisioning).toBe("already_started");
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.id, spare.id)))[0]!.consumedAt).toBeNull();
  });

  it("rolls back code, link, account, box and approval after an injected transaction failure", async () => {
    const { app } = await build();
    const c = await hosted(app);
    const w = who();
    await signup(app, w, { invitationCode: c.code });
    const token = tokenFrom(lastMailTo(w.email, "verify"));
    await db.execute(sql`create function reject_invite_test_event() returns trigger language plpgsql as $$ begin if NEW.kind = 'box_created' then raise exception 'synthetic precommit failure'; end if; return NEW; end $$`);
    await db.execute(sql`create trigger reject_invite_test_event before insert on box_events for each row execute function reject_invite_test_event()`);
    try {
      expect((await verify(app, token)).status).toBe(500);
      expect((await db.select().from(inviteCodes).where(eq(inviteCodes.id, c.id)))[0]!.consumedAt).toBeNull();
      expect((await db.select().from(emailTokens).where(eq(emailTokens.tokenHash, sha256Hex(token))))[0]!.usedAt).toBeNull();
      const [acct] = await db.select().from(accounts).where(eq(accounts.email, w.email));
      expect(acct!.status).toBe("pending_verification");
      expect(await db.select().from(waitlist).where(eq(waitlist.accountId, acct!.id))).toHaveLength(0);
      expect(await db.select().from(boxes).where(eq(boxes.slug, w.slug))).toHaveLength(0);
    } finally {
      await db.execute(sql`drop trigger reject_invite_test_event on box_events`);
      await db.execute(sql`drop function reject_invite_test_event()`);
    }
    expect((await verify(app, token)).status).toBe(200);
  });

  it("recovers a process gap after durable approval but before queue delivery", async () => {
    const { app, fd } = await build({});
    await open();
    const c = await hosted(app);
    const w = who();
    await signup(app, w, { invitationCode: c.code });
    const token = tokenFrom(lastMailTo(w.email, "verify"));
    caps.failBeforeQueue = true;
    expect((await verify(app, token)).status).toBe(500);
    const [box] = await db.select().from(boxes).where(eq(boxes.slug, w.slug));
    expect(box!.state).toBe("waitlisted");
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.id, c.id)))[0]!.consumedBoxId).toBe(box!.id);
    expect((await db.select().from(waitlist).where(eq(waitlist.accountId, box!.accountId)))[0]!.state).toBe("approved");
    expect(await db.select().from(jobs).where(eq(jobs.boxId, box!.id))).toHaveLength(0);
    expect(await fd.releaseApproved(1000)).toContainEqual({ slug: w.slug, outcome: "queued" });
    await fd.releaseApproved(1000);
    expect(await db.select().from(jobs).where(eq(jobs.boxId, box!.id))).toHaveLength(1);
    expect((await verify(app, token)).body.code).toBe("link_used");
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, box!.accountId));
    expect(acct!.status).toBe("active");
    // A new authenticated find link recovers progress after the interrupted response.
    await fd.find({ email: w.email }, { ip: who().ip, viaProxy: true });
    expect((await verify(app, tokenFrom(lastMailTo(w.email, "find")))).status).toBe(200);
  });

  it("two invited accounts racing for the last daily slot retain one queued and one approved-pending box", async () => {
    const { app } = await build();
    const a = await waiting(app);
    const b = await waiting(app);
    await open();
    const [today] = await db.execute(sql`select count(*)::int as n from jobs where kind = 'provision' and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`);
    await setSetting("daily_cap", Number(today!.n) + 1);
    const ca = await hosted(app), cb = await hosted(app);
    const rs = await Promise.all([redeem(app, a.cookie, ca.code), redeem(app, b.cookie, cb.code)]);
    expect(rs.map(r => r.body.provisioning).sort()).toEqual(["queued", "waitlisted"]);
    expect(rs.find(r => r.body.provisioning === "waitlisted")!.body.reason).toBe("daily_cap");
    for (const x of [a, b]) expect((await db.select().from(waitlist).where(eq(waitlist.accountId, x.box.accountId)))[0]!.state).toBe("approved");
  });

  it("does not reuse an old box approval to admit a replacement box", async () => {
    const { app, fd } = await build();
    const a = await waiting(app);
    const oldCode = await hosted(app);
    expect((await redeem(app, a.cookie, oldCode.code)).status).toBe(200);
    await db.update(boxes).set({ state: "deleted" }).where(eq(boxes.id, a.box.id));
    const c = await hosted(app);
    const w = { ...who(), email: a.w.email };
    await signup(app, w, { invitationCode: c.code });
    expect((await verify(app, tokenFrom(lastMailTo(w.email, "verify")))).status).toBe(200);
    const [replacement] = await db.select().from(boxes).where(eq(boxes.slug, w.slug));
    const [used] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, c.id));
    expect(used!.consumedBoxId).toBe(replacement!.id);
    await open();
    const released = await fd.releaseApproved(1000);
    expect(released.filter(x => x.slug === w.slug)).toHaveLength(1);
  });

  it("keeps replacement no-code progress on the waitlist after an old invited box was deleted", async () => {
    const { app, fd } = await build();
    const a = await waiting(app);
    const c = await hosted(app);
    await redeem(app, a.cookie, c.code);
    await db.update(boxes).set({ state: "deleted" }).where(eq(boxes.id, a.box.id));
    const w = { ...who(), email: a.w.email };
    await signup(app, w);
    const v = await verify(app, tokenFrom(lastMailTo(w.email, "verify")));
    expect(v.body.provisioning).toBe("waitlisted");
    expect((await request(app).get("/api/cloud/boxes/mine").set("cookie", cookieOf(v))).body.boxes[0]).toMatchObject({ slug: w.slug, phase: "waitlisted" });
    await open();
    expect(await fd.releaseApproved(1000)).not.toContainEqual({ slug: w.slug, outcome: "queued" });
  });

  it("an invited pending link for an existing waiting box approves and emails that original box name", async () => {
    const { app } = await build();
    const first = who();
    await signup(app, first);
    const t1 = tokenFrom(lastMailTo(first.email, "verify"));
    const second = { ...who(), email: first.email };
    const c = await hosted(app);
    await signup(app, second, { invitationCode: c.code });
    const t2 = tokenFrom(lastMailTo(first.email, "verify"));
    expect((await verify(app, t1)).status).toBe(200);
    expect((await verify(app, t2)).body).toMatchObject({ outcome: "existing", provisioning: "waitlisted" });
    const [box] = await db.select().from(boxes).where(eq(boxes.slug, first.slug));
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.id, c.id)))[0]!.consumedBoxId).toBe(box!.id);
    expect(lastMailTo(first.email, "approved").text).toContain(first.slug);
    expect(lastMailTo(first.email, "approved").text).not.toContain(second.slug);
    expect(await db.select().from(boxes).where(eq(boxes.accountId, box!.accountId))).toHaveLength(1);
  });

  it.each(["failed", "pending_delete", "cleanup"] as const)("returns authenticated existing progress for a second invited link when its original box is %s", async state => {
    const { app } = await build();
    const first = who();
    await signup(app, first);
    const t1 = tokenFrom(lastMailTo(first.email, "verify"));
    const c = await hosted(app);
    await signup(app, { ...who(), email: first.email }, { invitationCode: c.code });
    const t2 = tokenFrom(lastMailTo(first.email, "verify"));
    expect((await verify(app, t1)).status).toBe(200);
    const [box] = await db.select().from(boxes).where(eq(boxes.slug, first.slug));
    await db.update(boxes).set({ state: "provisioning" }).where(eq(boxes.id, box!.id));
    if (state === "pending_delete") {
      await db.update(boxes).set({ state: "awaiting_claim" }).where(eq(boxes.id, box!.id));
      await db.update(boxes).set({ state: "active" }).where(eq(boxes.id, box!.id));
    } else await db.update(boxes).set({ state: "failed" }).where(eq(boxes.id, box!.id));
    await db.update(boxes).set({ state }).where(eq(boxes.id, box!.id));
    const v = await verify(app, t2);
    expect(v.status).toBe(200);
    expect(v.body).toEqual({ ok: true, outcome: "existing" });
    const progress = await request(app).get("/api/cloud/boxes/mine").set("cookie", cookieOf(v));
    expect(progress.status).toBe(200);
    expect(progress.body.boxes).toHaveLength(1);
    expect(progress.body.boxes[0]).toMatchObject({ slug: first.slug, phase: state === "failed" ? "failed" : "closing" });
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.id, c.id)))[0]!.consumedAt).toBeNull();
    expect(await db.select().from(boxes).where(eq(boxes.accountId, box!.accountId))).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.boxId, box!.id))).toHaveLength(0);
  });

  it.each(["failed", "pending_delete", "cleanup"] as const)("preserves the committed session when a parallel box lifecycle reaches %s before queueing", async state => {
    const { app } = await build();
    const first = who();
    await signup(app, first);
    const t1 = tokenFrom(lastMailTo(first.email, "verify"));
    const c = await hosted(app);
    await signup(app, { ...who(), email: first.email }, { invitationCode: c.code });
    const t2 = tokenFrom(lastMailTo(first.email, "verify"));
    await verify(app, t1);
    caps.terminalBeforeQueue = state;
    const v = await verify(app, t2);
    expect(v.status).toBe(200);
    expect(v.body).toEqual({ ok: true, outcome: "existing" });
    const progress = await request(app).get("/api/cloud/boxes/mine").set("cookie", cookieOf(v));
    expect(progress.status).toBe(200);
    expect(progress.body.boxes[0].phase).toBe(state === "failed" ? "failed" : "closing");
    const [box] = await db.select().from(boxes).where(eq(boxes.slug, first.slug));
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.id, c.id)))[0]!.consumedBoxId).toBe(box!.id);
    expect(await db.select().from(boxes).where(eq(boxes.accountId, box!.accountId))).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.boxId, box!.id))).toHaveLength(0);
  });

  it("rejects blocked/unverified accounts and ignores client account/box/approval claims", async () => {
    const { app, fd } = await build();
    const a = await waiting(app);
    const b = await waiting(app);
    const c = await hosted(app);
    const r = await request(app).post("/api/cloud/invitation/redeem").set("cookie", a.cookie).set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, who().ip).send({ code: c.code, accountId: b.box.accountId, boxId: b.box.id, approved: true });
    expect(r.status).toBe(200);
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.id, c.id)))[0]!.consumedBoxId).toBe(a.box.id);
    const unused = await hosted(app);
    await db.update(accounts).set({ emailVerifiedAt: null }).where(eq(accounts.id, b.box.accountId));
    expect((await redeem(app, b.cookie, unused.code)).body.code).toBe("no_session");
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.id, unused.id)))[0]!.consumedAt).toBeNull();
    const w = who();
    await signup(app, w, { invitationCode: unused.code });
    const token = tokenFrom(lastMailTo(w.email, "verify"));
    await db.update(accounts).set({ status: "blocked" }).where(eq(accounts.email, w.email));
    expect((await fd.verify(token)).ok).toBe(false);
    expect((await db.select().from(emailTokens).where(eq(emailTokens.tokenHash, sha256Hex(token))))[0]!.usedAt).toBeNull();
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.id, unused.id)))[0]!.consumedAt).toBeNull();
  });

  it("rate limits authenticated code guesses durably and requires JSON", async () => {
    const { app } = await build();
    const a = await waiting(app);
    const ip = who().ip;
    for (let i = 0; i < 10; i++) expect((await redeem(app, a.cookie, "wrong-code", ip)).status).toBe(400);
    expect((await redeem(app, a.cookie, "wrong-code", ip)).body.code).toBe("rate_limited");
    expect((await request(app).post("/api/cloud/invitation/redeem").set("cookie", a.cookie).type("form").send({ code: "anything" })).status).toBe(415);
  });
});
