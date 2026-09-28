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
import { accounts, boxEvents, boxes, emailTokens, jobs, waitlist } from "../db/schema.js";
import { hasMx, isDisposableDomain, normaliseEmail } from "../front-door/email-policy.js";
import type { MailMessage } from "../front-door/mailer.js";
import { frontDoor, type FrontDoor } from "../front-door/service.js";
import { type JobHandler, JobRunner } from "../jobs/runner.js";
import { createLogger } from "../logger.js";
import { settingsService } from "../settings.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";

// The capabilities module is frozen in production; this suite swaps in a mutable stand-in.
const caps = vi.hoisted(() => ({ claimTrackingReady: false }));
vi.mock("../capabilities.js", () => ({ capabilities: caps }));

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
const IP_HEADER = "x-test-client-ip";
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
    CLOUD_PUBLIC_CLIENT_IP_HEADER: IP_HEADER,
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
    .set(IP_HEADER, w.ip)
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
  return await request(app).post("/api/cloud/verify").set(IP_HEADER, ip).send({ token });
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

  it("caps the connecting address too, so a forged client-IP header does not escape the limits", async () => {
    const { app } = await build({ ...TURNSTILE, CLOUD_PROXY_SIGNUPS_PER_HOUR: "2" });
    // All requests connect from 127.0.0.1 (the "proxy"); each forges a new client IP.
    // Earlier tests already used the proxy's budget, so the ceiling is hit at once or within two.
    const results = [];
    for (let i = 0; i < 3; i++) results.push((await signup(app, who())).status);
    expect(results).toContain(429);
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
    expect(lastMailTo(w.email, "approved").text).toContain("will be created shortly");
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
    expect(res.body).toEqual({ turnstileSiteKey: "site-key-for-tests", signupOpen: true, waitlist: true, edgeDomain: "agentdash.cloud" });
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
  it("signup, verify, approve, provision, ready email with the claim link, progress page shows it", async () => {
    caps.claimTrackingReady = true;
    await setSetting("provisioning_enabled", true);
    await setSetting("waitlist_mode", true);
    await setSetting("daily_cap", 1000);
    const { app, fd, cfg } = await build();
    const w = who();

    expect((await request(app).get(`/api/cloud/slug-available?slug=${w.slug}`)).body).toEqual({ slug: w.slug, available: true });
    expect((await signup(app, w)).status).toBe(202);
    const v = await verify(app, tokenFrom(lastMailTo(w.email, "verify")));
    const cookie = cookieOf(v);
    expect(v.body.reason).toBe("waitlist_mode");
    expect((await request(app).get(`/api/cloud/slug-available?slug=${w.slug}`)).body.available).toBe(false);

    const [entry] = await db.select().from(waitlist).where(eq(waitlist.email, w.email));
    await request(app).post(`/internal/waitlist/${entry!.id}/approve`).set("authorization", `Bearer ${ADMIN}`).expect(200);
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
    const resend = await request(app).post("/api/cloud/resend").set("cookie", cookie).set(IP_HEADER, w.ip).send({});
    expect(resend.status).toBe(202);
    expect(lastMailTo(w.email, "ready").text).toContain(claimUrl);

    // /find mails the workspaces for a known, verified address only.
    const find = await request(app).post("/api/cloud/find").set(IP_HEADER, w.ip).send({ email: w.email, turnstileToken: "tok" });
    expect(find.status).toBe(202);
    expect(lastMailTo(w.email, "find").text).toContain(`${w.slug}: https://${w.slug}.agentdash.cloud`);
    mail.length = 0;
    const stranger = await request(app).post("/api/cloud/find").set(IP_HEADER, w.ip).send({ email: "nobody@nowhere.test", turnstileToken: "tok" });
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
    const res = await request(app).post("/api/cloud/resend").set(IP_HEADER, w.ip).send({ email: w.email });
    expect(res.status).toBe(202);
    const second = tokenFrom(lastMailTo(w.email, "verify"));
    expect(second).not.toBe(first);
    mail.length = 0;
    await request(app).post("/api/cloud/resend").set(IP_HEADER, w.ip).send({ email: "nobody@nowhere.test" }).expect(202);
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
