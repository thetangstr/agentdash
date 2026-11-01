// Cloud MCP toolset (doc/plans/2026-10-31-cloud-mcp-toolset.md): the agent
// front door — POST /api/cloud/agent/<op> and the hosted POST /api/cloud/mcp —
// against embedded Postgres, a capturing mailer, a fake MX resolver and a fake
// box (its CLI-auth approval routes). The end-to-end journey on the fake
// Railway is agent-cloud-e2e.test.ts.
import { randomBytes } from "node:crypto";
import http from "node:http";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { decryptField, encryptField, sha256Hex } from "../crypto.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { agentHandles, boxEvents, boxes, inviteCodes, jobs, signupRequests, waitlist } from "../db/schema.js";
import { AGENT_LIMITS, CONNECT_CLIENT, CONNECT_COMMAND, MAX_CONNECT_REQUESTS } from "../front-door/agent.js";
import type { MailMessage } from "../front-door/mailer.js";
import { frontDoor } from "../front-door/service.js";
import { LIMITS } from "../front-door/rate-limit.js";
import { inviteService } from "../invites.js";
import { createLogger } from "../logger.js";
import { settingsService } from "../settings.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";
import { FakeBoxAuth } from "./fake-box-auth.js";

const caps = vi.hoisted(() => ({ claimTrackingReady: true }));
vi.mock("../capabilities.js", () => ({ capabilities: caps }));

http.globalAgent = new http.Agent({ keepAlive: false });
const servers: http.Server[] = [];
async function serve(app: ReturnType<typeof createApp>): Promise<http.Server> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  servers.push(server);
  return server;
}

const ADMIN = randomBytes(32).toString("hex");
const PROXY_SECRET = randomBytes(32).toString("hex");
const IP_HEADER = "x-agentdash-client-ip";
const PROXY_HEADER = "x-agentdash-edge-proxy";
const HANDLE_RE = /^agdh_[A-Za-z0-9_-]{43}$/;
let pg: TestDatabase;
let db: CloudDb;
let close: () => Promise<void>;
const logLines: string[] = [];
const log = createLogger({ write: (l) => logLines.push(l), level: "debug" });
const mail: MailMessage[] = [];
let clockOffsetMs = 0;
let seq = 0;
const box = new FakeBoxAuth();
const now = () => new Date(Date.now() + clockOffsetMs);

function config() {
  return loadConfig({
    DATABASE_URL: pg.url,
    CLOUD_DATA_KEY: "55".repeat(32),
    CLOUD_ADMIN_TOKEN: ADMIN,
    CLOUD_ADMIN_ALLOWED_IPS: "127.0.0.1,::1",
    CLOUD_PUBLIC_SITE_URL: "https://www.agentdash.test",
    CLOUD_VERCEL_PROXY_SECRET: PROXY_SECRET,
    // Turnstile is configured: the browser path needs it, the agent path never calls it.
    CLOUD_TURNSTILE_SECRET_KEY: "turnstile-secret-for-tests",
    CLOUD_TURNSTILE_SITE_KEY: "site-key-for-tests",
  });
}

const cfg = { current: null as ReturnType<typeof config> | null };
let app: http.Server;

async function build() {
  const c = config();
  cfg.current = c;
  const fd = frontDoor({
    db,
    log,
    config: c,
    mailer: { send: async (m) => void mail.push(m) },
    // Turnstile must never be asked on the agent path.
    fetch: (async (url: string | URL | Request) => {
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as typeof fetch,
    resolveMx: async (domain) => {
      if (domain.startsWith("nomx.")) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return [{ exchange: `mx.${domain}` }];
    },
    now,
  });
  return { server: await serve(createApp({ db, config: c, log, frontDoor: fd, agent: { boxFetch: box.fetch, now } })), fd, cfg: c };
}

function who() {
  const n = ++seq;
  const tag = `${n}${Date.now() % 100000}`;
  return { email: `founder@co${tag}.test`, slug: `ag${tag}`.slice(0, 16), ip: `198.18.${n % 250}.${(Math.floor(Date.now() / 1000) + n) % 250}` };
}

function api(op: string, body: Record<string, unknown>, ip = who().ip) {
  return request(app).post(`/api/cloud/agent/${op}`).set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, ip).send(body);
}

async function start(w: ReturnType<typeof who>, over: Record<string, unknown> = {}) {
  return await api("start", { email: w.email, slug: w.slug, acceptTerms: true, ...over }, w.ip);
}

function lastMailTo(email: string, kind?: MailMessage["kind"]): MailMessage {
  const m = [...mail].reverse().find((x) => x.to === email && (!kind || x.kind === kind));
  if (!m) throw new Error(`no ${kind ?? ""} mail to ${email}; got ${mail.map((x) => `${x.kind}:${x.to}`).join(", ")}`);
  return m;
}

function tokenFrom(m: MailMessage): string {
  const match = /\/start\/verify#token=([A-Za-z0-9_-]+)/.exec(m.text);
  if (!match) throw new Error(`no magic link in ${m.kind} mail`);
  return match[1]!;
}

/** The person clicks the link in their email (in their own browser, from their own address). */
let personSeq = 0;
async function personVerifies(email: string) {
  const ip = `203.0.${113 + Math.floor(++personSeq / 250)}.${personSeq % 250}`;
  const v = await request(app).post("/api/cloud/verify").set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, ip).send({ token: tokenFrom(lastMailTo(email, "verify")) });
  expect(v.status).toBe(200);
  return v;
}

async function status(handle: string, ip?: string) {
  return await api("status", { handle }, ip);
}

async function boxFor(slug: string) {
  return (await db.select().from(boxes).where(eq(boxes.slug, slug)))[0]!;
}

async function setSetting(key: Parameters<ReturnType<typeof settingsService>["set"]>[0], value: unknown) {
  await settingsService(db).set(key, value, "test");
}

/** A box walked to `active` the way the provisioner and the claim sweep move it. */
async function claimedBox(): Promise<{ w: ReturnType<typeof who>; handle: string; slug: string; boxId: string }> {
  const w = who();
  const invitation = await inviteService(db, cfg.current!.dataKeys).addHosted("agent test", "test", null);
  const s = await start(w, { admissionCode: invitation.code });
  expect(s.status).toBe(201);
  await personVerifies(w.email);
  const b = await boxFor(w.slug);
  expect(b.state).toBe("provisioning");
  await db.update(boxes).set({ state: "awaiting_claim" }).where(eq(boxes.id, b.id));
  await db.update(boxes).set({ state: "active", claimedAt: new Date() }).where(eq(boxes.id, b.id));
  return { w, handle: s.body.handle, slug: w.slug, boxId: b.id };
}

beforeAll(async () => {
  pg = await startTestDatabase();
  await migrateCloudDb(pg.url);
  ({ db, close } = createCloudDb(pg.url));
  ({ server: app } = await build());
});

afterAll(async () => {
  await Promise.all(servers.map((sv) => new Promise<void>((r) => sv.close(() => r()))));
  await close?.();
  await pg?.stop();
});

beforeEach(async () => {
  mail.length = 0;
  clockOffsetMs = 0;
  box.down = null;
  caps.claimTrackingReady = true;
  await db.execute(sql`truncate settings`);
  await db.execute(sql`update jobs set state = 'dead' where state in ('queued', 'running', 'failed')`);
  await setSetting("provisioning_enabled", true);
  await setSetting("daily_cap", 1000);
});

describe("start: the normal signup, on the agent channel", () => {
  it("returns a handle once and mails the PERSON the link; the handle is stored only as its hash", async () => {
    const w = who();
    const res = await start(w);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ state: "email_pending", slug: w.slug, admission: "waitlist", url: `https://${w.slug}.agentdash.cloud` });
    expect(res.body.handle).toMatch(HANDLE_RE);
    expect(new Date(res.body.handleExpiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    // The person got the ordinary verification email; the agent's answer carries no link.
    const m = lastMailTo(w.email, "verify");
    expect(JSON.stringify(res.body)).not.toContain(tokenFrom(m));
    expect(JSON.stringify(res.body)).not.toContain("/start/verify");
    // Hash at rest, nothing else.
    const rows = await db.select().from(agentHandles);
    expect(JSON.stringify(rows)).not.toContain(res.body.handle);
    const [row] = await db.select().from(agentHandles).where(eq(agentHandles.tokenHash, sha256Hex(res.body.handle)));
    expect(row).toBeTruthy();
    // Bound to exactly this signup, which is marked as having had no bot check.
    const [req] = await db.select().from(signupRequests).where(eq(signupRequests.id, row!.signupRequestId!));
    expect(req).toMatchObject({ slug: w.slug, unverifiedHuman: true, ip: w.ip });
    expect(logLines.join("\n")).not.toContain(res.body.handle);
  });

  it("refuses what browser signup refuses, and creates no handle", async () => {
    const before = (await db.select().from(agentHandles)).length;
    expect((await start(who(), { email: "nope" })).body.code).toBe("invalid_email");
    expect((await start({ ...who(), email: "x@mailinator.com" })).body.code).toBe("disposable_email");
    expect((await start({ ...who(), email: "x@nomx.example.test" })).body.code).toBe("no_mx");
    expect((await start({ ...who(), slug: "www" })).body.code).toBe("slug_reserved");
    expect((await start(who(), { acceptTerms: false })).body.code).toBe("terms_required");
    expect((await db.select().from(agentHandles)).length).toBe(before);
  });

  it("shares the per-address signup limit with the browser (3 an hour)", async () => {
    const ip = `192.0.2.${(seq % 200) + 20}`;
    for (let i = 0; i < 3; i++) expect((await start({ ...who(), ip })).status).toBe(201);
    const fourth = await start({ ...who(), ip });
    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe("rate_limited");
  });

  it("without Turnstile, agents get tighter send limits: 2 links an hour per address, and a shared hourly cap unless they carry a code", async () => {
    const email = `founder@lim${Date.now() % 100000}.test`;
    expect((await start({ ...who(), email })).status).toBe(201);
    expect((await start({ ...who(), email })).status).toBe(201);
    const third = await start({ ...who(), email });
    expect(third.status).toBe(429);
    expect(third.body.code).toBe("rate_limited");

    const saved = LIMITS.agentSignupWithoutCode.limit;
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from rate_events where bucket = 'agent_signup_nocode' and created_at > now() - interval '1 hour'`)) as unknown as Array<{ n: number }>;
    LIMITS.agentSignupWithoutCode.limit = n + 1;
    try {
      expect((await start(who())).status).toBe(201);
      const busy = await start(who());
      expect(busy.status).toBe(429);
      expect(busy.body.code).toBe("agent_signups_busy");
      // An admission code is exempt from the shared cap.
      const invitation = await inviteService(db, cfg.current!.dataKeys).addHosted("cap-exempt", "test", null);
      expect((await start(who(), { admissionCode: invitation.code })).status).toBe(201);
    } finally {
      LIMITS.agentSignupWithoutCode.limit = saved;
    }
  });

  it("answers an address that already has a workspace exactly like a new one (no account oracle)", async () => {
    const { w } = await claimedBox();
    mail.length = 0;
    const again = await start({ ...who(), email: w.email });
    const fresh = await start(who());
    expect(again.status).toBe(201);
    expect(Object.keys(again.body).sort()).toEqual(Object.keys(fresh.body).sort());
    expect(again.body.state).toBe("email_pending");
    expect(lastMailTo(w.email).kind).toBe("already_have_box");
    // Its status reads like an unverified signup, then expires like one.
    expect((await status(again.body.handle)).body.state).toBe("email_pending");
    clockOffsetMs = 31 * 60_000;
    expect((await status(again.body.handle)).body).toMatchObject({ state: "failed", reason: "verification_expired" });
    expect((await status(fresh.body.handle)).body).toMatchObject({ state: "failed", reason: "verification_expired" });
  });

  it("an address that already has a workspace holds the name like a new signup does (no slug oracle)", async () => {
    const { w } = await claimedBox();
    const known = { ...who(), email: w.email };
    const fresh = who();
    await start(known);
    await start(fresh);
    expect((await api("check-name", { slug: known.slug })).body).toMatchObject({ available: false, reason: "taken" });
    expect((await api("check-name", { slug: fresh.slug })).body).toMatchObject({ available: false, reason: "taken" });
    // The decoy carries no link: the person's resend cannot turn it into one.
    const [decoy] = await db.select().from(signupRequests).where(eq(signupRequests.slug, known.slug));
    expect(decoy!.emailTokenId).toBeNull();
  });

  it("a code is bounded per code (3 an hour) and exempts its holder from the per-address limit", async () => {
    const ip = `192.0.2.${(seq % 200) + 40}`;
    const invitation = await inviteService(db, cfg.current!.dataKeys).addHosted("bounded", "test", null);
    for (let i = 0; i < 3; i++) expect((await start({ ...who(), ip }, { admissionCode: invitation.code })).status).toBe(201);
    const fourth = await start({ ...who(), ip }, { admissionCode: invitation.code });
    expect(fourth.status).toBe(429);
    // The three coded starts took nothing from the address: three code-less ones still fit.
    for (let i = 0; i < 3; i++) expect((await start({ ...who(), ip })).status).toBe(201);
    expect((await start({ ...who(), ip })).status).toBe(429);
  });

  it("the one-box-a-day limit keys on the person's address at verification, not the agent's shared one", async () => {
    await setSetting("waitlist_mode", true);
    const agentIp = `192.0.2.${(seq % 200) + 50}`;
    const a = who();
    const b = who();
    const codeA = await inviteService(db, cfg.current!.dataKeys).addHosted("a", "test", null);
    const codeB = await inviteService(db, cfg.current!.dataKeys).addHosted("b", "test", null);
    await start({ ...a, ip: agentIp }, { admissionCode: codeA.code });
    await start({ ...b, ip: agentIp }, { admissionCode: codeB.code });
    for (const [x, personIp] of [[a, "198.51.100.101"], [b, "198.51.100.102"]] as const) {
      const v = await request(app).post("/api/cloud/verify").set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, personIp).send({ token: tokenFrom(lastMailTo(x.email, "verify")) });
      expect(v.status).toBe(200);
      expect((await boxFor(x.slug)).state).toBe("provisioning");
    }
    const [reqA] = await db.select().from(signupRequests).where(eq(signupRequests.slug, a.slug));
    expect(reqA!.ip).toBe("198.51.100.101");
  });

  it("check-name is the /start page's slug check", async () => {
    const w = who();
    expect((await api("check-name", { slug: w.slug })).body).toEqual({ slug: w.slug, available: true, url: `https://${w.slug}.agentdash.cloud` });
    expect((await api("check-name", { slug: "www" })).body).toMatchObject({ available: false, reason: "reserved" });
    expect((await api("nope", {})).status).toBe(404);
  });
});

describe("status by handle, every state", () => {
  it("email_pending → waitlisted → (approved) provisioning(step) → awaiting_claim → active, never showing the person's links", async () => {
    await setSetting("waitlist_mode", true);
    const w = who();
    const { handle } = (await start(w)).body;
    expect((await status(handle)).body).toMatchObject({ state: "email_pending", verifyBy: expect.any(String) });

    await personVerifies(w.email);
    const waiting = (await status(handle)).body;
    expect(waiting).toMatchObject({ state: "waitlisted", approved: false, reason: "awaiting_approval", gate: "waitlist_mode", slug: w.slug });

    const [entry] = await db.select().from(waitlist).where(eq(waitlist.email, w.email));
    await request(app).post(`/internal/waitlist/${entry!.id}/approve`).set("authorization", `Bearer ${ADMIN}`).expect(200);
    const b = await boxFor(w.slug);
    expect((await status(handle)).body).toMatchObject({ state: "provisioning", step: { index: 0, of: 5 }, slow: false });
    await db.update(jobs).set({ step: "deploy" }).where(eq(jobs.boxId, b.id));
    expect((await status(handle)).body).toMatchObject({ state: "provisioning", step: { index: 3, label: "Starting it up" } });

    const CODE = `AGD-${randomBytes(13).toString("hex").toUpperCase()}`;
    await db.update(boxes).set({
      state: "awaiting_claim",
      claimCodeEnc: encryptField(cfg.current!.dataKeys, CODE, "boxes.claim_code_enc"),
      claimCodeHash: sha256Hex(CODE),
      claimExpiresAt: new Date(Date.now() + 7 * 86_400_000),
    }).where(eq(boxes.id, b.id));
    const ready = await status(handle);
    expect(ready.body).toMatchObject({ state: "awaiting_claim", url: `https://${w.slug}.agentdash.cloud` });
    // The claim link and code are only ever in the person's email.
    expect(JSON.stringify(ready.body)).not.toContain(CODE);
    expect(JSON.stringify(ready.body)).not.toMatch(/#code=|\/claim/);

    await db.update(boxes).set({ state: "active", claimedAt: new Date() }).where(eq(boxes.id, b.id));
    expect((await status(handle)).body).toMatchObject({ state: "active", connected: false, url: `https://${w.slug}.agentdash.cloud` });
    await db.update(boxes).set({ state: "suspended" }).where(eq(boxes.id, b.id));
    expect((await status(handle)).body).toMatchObject({ state: "active", suspended: true });
    // A read never changes anything.
    const [row] = await db.select().from(agentHandles).where(eq(agentHandles.tokenHash, sha256Hex(handle)));
    expect(row).toMatchObject({ connectChallengeId: null, connectSealed: null, connectRequests: 0, connectedAt: null });
  });

  it("approved but held by the kill switch: waitlisted, approved_waiting_for_capacity", async () => {
    await setSetting("provisioning_enabled", false);
    const w = who();
    const invitation = await inviteService(db, cfg.current!.dataKeys).addHosted("held", "test", null);
    const { handle } = (await start(w, { admissionCode: invitation.code })).body;
    await personVerifies(w.email);
    expect((await status(handle)).body).toMatchObject({ state: "waitlisted", approved: true, reason: "approved_waiting_for_capacity", gate: "kill_switch" });
  });

  it("failed (provisioning), failed (deleted), failed (already has a workspace), failed (link expired)", async () => {
    const a = await claimedBox();
    await db.update(boxes).set({ state: "pending_delete" }).where(eq(boxes.id, a.boxId));
    await db.update(boxes).set({ state: "deleted" }).where(eq(boxes.id, a.boxId));
    expect((await status(a.handle)).body).toMatchObject({ state: "failed", reason: "workspace_deleted" });

    const w = who();
    const invitation = await inviteService(db, cfg.current!.dataKeys).addHosted("fails", "test", null);
    const { handle } = (await start(w, { admissionCode: invitation.code })).body;
    await personVerifies(w.email);
    await db.update(boxes).set({ state: "failed" }).where(eq(boxes.slug, w.slug));
    expect((await status(handle)).body).toMatchObject({ state: "failed", reason: "provisioning_failed" });

    // Two signups for one email: the second verified one makes no second box.
    const p = who();
    const first = (await start(p)).body.handle;
    const firstLink = tokenFrom(lastMailTo(p.email, "verify"));
    const second = (await start({ ...who(), email: p.email })).body.handle;
    await personVerifies(p.email);
    await request(app).post("/api/cloud/verify").set(PROXY_HEADER, PROXY_SECRET).set(IP_HEADER, "198.51.100.78").send({ token: firstLink }).expect(200);
    expect((await status(second)).body.state).toBe("waitlisted");
    expect((await status(first)).body).toMatchObject({ state: "failed", reason: "already_has_workspace" });

    const late = who();
    const lateHandle = (await start(late)).body.handle;
    clockOffsetMs = 31 * 60_000;
    expect((await status(lateHandle)).body).toMatchObject({ state: "failed", reason: "verification_expired" });
  });
});

describe("admission codes", () => {
  it("a valid code is consumed at verification and approves exactly that box", async () => {
    await setSetting("waitlist_mode", true);
    const w = who();
    const invitation = await inviteService(db, cfg.current!.dataKeys).addHosted("agent beta", "test", null);
    const s = await start(w, { admissionCode: invitation.code });
    expect(s.body.admission).toBe("admission_code");
    // Checked at start, spent only once the person verifies.
    expect((await db.select().from(inviteCodes).where(eq(inviteCodes.id, invitation.id)))[0]!.consumedAt).toBeNull();
    await personVerifies(w.email);
    const b = await boxFor(w.slug);
    const [used] = await db.select().from(inviteCodes).where(eq(inviteCodes.id, invitation.id));
    expect(used).toMatchObject({ consumedByAccountId: b.accountId, consumedBoxId: b.id });
    expect((await status(s.body.handle)).body.state).toBe("provisioning");
    // Spent: a second signup cannot use it.
    const reuse = await start(who(), { admissionCode: invitation.code });
    expect(reuse.status).toBe(400);
    expect(reuse.body.code).toBe("admission_code_unavailable");
    expect((await start(who(), { admissionCode: "AGD-HOST-NOT-A-CODE" })).body.code).toBe("admission_code_unavailable");
    expect(logLines.join("\n")).not.toContain(invitation.code);
  });

  it("without a code an agent signup always needs approval, even with the waitlist off (the Turnstile-equivalent gate)", async () => {
    await setSetting("waitlist_mode", false);
    const w = who();
    const { handle } = (await start(w)).body;
    await personVerifies(w.email);
    expect((await status(handle)).body).toMatchObject({ state: "waitlisted", reason: "awaiting_approval", gate: "needs_approval" });
    expect(await db.select().from(jobs).where(eq(jobs.boxId, (await boxFor(w.slug)).id))).toHaveLength(0);
  });
});

describe("handles", () => {
  it("unknown, malformed and expired handles are refused", async () => {
    expect((await status(`agdh_${"B".repeat(43)}`)).status).toBe(404);
    expect((await status("pcp_board_123")).status).toBe(400);
    expect((await status("")).body.code).toBe("handle_invalid");
    const { handle } = (await start(who())).body;
    clockOffsetMs = 7 * 86_400_000 + 1000;
    const r = await status(handle);
    expect(r.status).toBe(410);
    expect(r.body.code).toBe("handle_expired");
    expect((await api("connect", { handle })).status).toBe(410);
  });

  it("is rate-limited per handle, durably", async () => {
    const saved = AGENT_LIMITS.statusPerHandle.limit;
    AGENT_LIMITS.statusPerHandle.limit = 3;
    try {
      const { handle } = (await start(who())).body;
      const other = (await start(who())).body.handle;
      for (let i = 0; i < 3; i++) expect((await status(handle, who().ip)).status).toBe(200);
      const limited = await status(handle, who().ip);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe("rate_limited");
      expect((await status(other)).status).toBe(200);
    } finally {
      AGENT_LIMITS.statusPerHandle.limit = saved;
    }
  });
});

describe("connect: the person's approval on the box, delivered once", () => {
  it("is refused until the box is claimed", async () => {
    const w = who();
    const { handle } = (await start(w)).body;
    const r = await api("connect", { handle });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "not_claimed", state: "email_pending" });
    expect(box.calls).toHaveLength(0);
  });

  it("asks the box for an approval request, waits for the person, then delivers the key exactly once", async () => {
    const { handle, slug, boxId } = await claimedBox();
    const first = await api("connect", { handle });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ state: "approval_pending", boxUrl: `https://${slug}.agentdash.cloud` });
    expect(first.body.apiKey).toBeUndefined();
    const challenge = box.latest()!;
    expect(challenge).toMatchObject({ host: `${slug}.agentdash.cloud`, clientName: CONNECT_CLIENT, requestedAccess: "board" });
    // The approval page shows a code the agent shows the person too.
    expect(first.body.confirmationCode).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
    expect(challenge.command).toBe(`${CONNECT_COMMAND} (code ${first.body.confirmationCode})`);
    expect(first.body.approvalUrl).toBe(`https://${slug}.agentdash.cloud/cli-auth/${challenge.id}?token=${challenge.secret}`);
    // At rest: sealed, under the handle and the data key; the pending key is not readable with the data key alone.
    const [row] = await db.select().from(agentHandles).where(eq(agentHandles.tokenHash, sha256Hex(handle)));
    expect(row!.connectSealed).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(challenge.pendingKey);
    expect(JSON.stringify(row)).not.toContain(challenge.secret);
    const outer = decryptField(cfg.current!.dataKeys, row!.connectSealed!, `agent_handles.connect_sealed:${row!.id}`);
    expect(outer).not.toContain(challenge.pendingKey);
    expect(() => decryptField(cfg.current!.dataKeys, outer, `agent_handles.connect_sealed:${row!.id}`)).toThrow();

    // Asking again while the person decides: the same request, not a new one.
    const again = await api("connect", { handle });
    expect(again.body).toMatchObject({ state: "approval_pending", approvalUrl: first.body.approvalUrl, confirmationCode: first.body.confirmationCode });
    expect(box.challenges.size).toBeGreaterThanOrEqual(1);
    expect([...box.challenges.values()].filter((c) => c.host === `${slug}.agentdash.cloud`)).toHaveLength(1);

    // The person signs in on their box and clicks Approve.
    box.approve(challenge.id);
    const delivered = await api("connect", { handle });
    expect(delivered.body).toMatchObject({ state: "connected", boxUrl: `https://${slug}.agentdash.cloud`, apiUrl: `https://${slug}.agentdash.cloud/api`, apiKeyKind: "board" });
    expect(delivered.body.apiKey).toBe(challenge.pendingKey);
    expect(box.boardKeys.has(delivered.body.apiKey)).toBe(true);

    // Never twice.
    const later = await api("connect", { handle });
    expect(later.body).toMatchObject({ state: "connected", delivered: true });
    expect(JSON.stringify(later.body)).not.toContain(challenge.pendingKey);
    const [after] = await db.select().from(agentHandles).where(eq(agentHandles.id, row!.id));
    expect(after).toMatchObject({ connectSealed: null, connectChallengeId: null, connectRequests: 1 });
    expect(after!.connectedAt).toBeInstanceOf(Date);
    expect((await status(handle)).body).toMatchObject({ state: "active", connected: true });
    const events = await db.select().from(boxEvents).where(eq(boxEvents.boxId, boxId));
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["agent_connect_requested", "agent_connected"]));
    expect(JSON.stringify(events)).not.toContain(challenge.pendingKey);
    expect(logLines.join("\n")).not.toContain(challenge.pendingKey);
    expect(logLines.join("\n")).not.toContain(handle);
  });

  it("an approval made in time still delivers after the request's 10 minutes (the box then reports expired)", async () => {
    const { handle } = await claimedBox();
    await api("connect", { handle });
    const c = box.latest()!;
    expect(box.approve(c.id)).toBe(true);
    box.expire(c.id);
    const r = await api("connect", { handle });
    expect(r.body).toMatchObject({ state: "connected", apiKey: c.pendingKey });
  });

  it("an edge router page (a waking box) is unreachable, not an expired request", async () => {
    const { handle } = await claimedBox();
    await api("connect", { handle });
    const c = box.latest()!;
    box.down = 404;
    expect((await api("connect", { handle })).body.code).toBe("box_unreachable");
    box.down = null;
    expect((await api("connect", { handle })).body).toMatchObject({ state: "approval_pending" });
    expect(box.latest()!.id).toBe(c.id);
  });

  it("concurrent first calls make one request on the box", async () => {
    const { handle, slug } = await claimedBox();
    const answers = await Promise.all([api("connect", { handle }), api("connect", { handle }), api("connect", { handle })]);
    expect(answers.filter((a) => a.body.state === "approval_pending").length).toBeGreaterThanOrEqual(1);
    expect(answers.every((a) => a.body.state === "approval_pending" || a.body.code === "connect_in_progress")).toBe(true);
    expect([...box.challenges.values()].filter((c) => c.host === `${slug}.agentdash.cloud`)).toHaveLength(1);
    const [row] = await db.select().from(agentHandles).where(eq(agentHandles.tokenHash, sha256Hex(handle)));
    expect(row!.connectRequests).toBe(1);
  });

  it("two calls racing after approval: exactly one gets the key", async () => {
    const { handle } = await claimedBox();
    await api("connect", { handle });
    box.approve(box.latest()!.id);
    const [a, b] = await Promise.all([api("connect", { handle }), api("connect", { handle })]);
    const keys = [a.body.apiKey, b.body.apiKey].filter(Boolean);
    expect(keys).toHaveLength(1);
    expect([a.body.state, b.body.state]).toEqual(["connected", "connected"]);
  });

  it("the person's Cancel is a no: it stays declined until restart, which makes a new request", async () => {
    const { handle } = await claimedBox();
    await api("connect", { handle });
    const declinedId = box.latest()!.id;
    box.cancelByPerson(declinedId);
    expect((await api("connect", { handle })).body.state).toBe("declined");
    expect((await api("connect", { handle })).body.state).toBe("declined");
    expect(box.latest()!.id).toBe(declinedId);
    const restarted = await api("connect", { handle, restart: true });
    expect(restarted.body.state).toBe("approval_pending");
    expect(box.latest()!.id).not.toBe(declinedId);
  });

  it("an expired request is replaced by the next call; a handle makes at most five", async () => {
    const { handle } = await claimedBox();
    for (let i = 1; i <= MAX_CONNECT_REQUESTS; i++) {
      const r = await api("connect", { handle });
      expect(r.body.state, `request ${i}`).toBe("approval_pending");
      box.expire(box.latest()!.id);
    }
    const over = await api("connect", { handle });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe("connect_limit");
  });

  it("restart cancels a pending request on the box", async () => {
    const { handle } = await claimedBox();
    await api("connect", { handle });
    const old = box.latest()!;
    await api("connect", { handle, restart: true });
    expect(old.status).toBe("cancelled");
    expect(box.latest()!.id).not.toBe(old.id);
  });

  it("restart never discards a request the person already approved: it delivers instead", async () => {
    const { handle } = await claimedBox();
    await api("connect", { handle });
    const approved = box.latest()!;
    box.approve(approved.id);
    const r = await api("connect", { handle, restart: true });
    expect(r.body).toMatchObject({ state: "connected", apiKey: approved.pendingKey });
    expect(box.latest()!.id).toBe(approved.id);
  });

  it("an unreachable box records nothing", async () => {
    const { handle } = await claimedBox();
    box.down = 503;
    const r = await api("connect", { handle });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("box_unreachable");
    const [row] = await db.select().from(agentHandles).where(eq(agentHandles.tokenHash, sha256Hex(handle)));
    expect(row).toMatchObject({ connectChallengeId: null, connectRequests: 0 });
  });
});

describe("the hosted MCP endpoint, POST /api/cloud/mcp", () => {
  async function mcpClient(ip: string, origin?: string) {
    const address = app.address() as { port: number };
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/api/cloud/mcp`), {
      requestInit: { headers: { [PROXY_HEADER]: PROXY_SECRET, [IP_HEADER]: ip, ...(origin ? { origin } : {}) } },
    });
    const client = new Client({ name: "hosted-test", version: "0.0.0" });
    await client.connect(transport);
    return client;
  }
  const text = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;

  it("serves the same four tools as stdio, and runs the same signup", async () => {
    const w = who();
    const client = await mcpClient(w.ip);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["agentdash_cloud_check_name", "agentdash_cloud_start", "agentdash_cloud_status", "agentdash_cloud_connect"]);
    expect(client.getInstructions()).toMatch(/^# AgentDash Cloud Playbook/);
    expect(text(await client.callTool({ name: "agentdash_cloud_check_name", arguments: { slug: w.slug } }))).toMatchObject({ available: true });
    const started = text(await client.callTool({ name: "agentdash_cloud_start", arguments: { email: w.email, slug: w.slug, acceptTerms: true } }));
    expect(started.handle).toEqual(expect.stringMatching(HANDLE_RE));
    expect(lastMailTo(w.email, "verify")).toBeTruthy();
    // The limits key on the caller's own address, exactly as over REST.
    const [req] = await db.select().from(signupRequests).where(eq(signupRequests.slug, w.slug));
    expect(req!.ip).toBe(w.ip);
    expect(text(await client.callTool({ name: "agentdash_cloud_status", arguments: { handle: started.handle } }))).toMatchObject({ state: "email_pending" });
    await client.close();
  });

  it("applies the same rate limits as REST", async () => {
    const ip = `192.0.2.${(seq % 200) + 30}`;
    const client = await mcpClient(ip);
    for (let i = 0; i < 3; i++) {
      const w = who();
      const r = await client.callTool({ name: "agentdash_cloud_start", arguments: { email: w.email, slug: w.slug, acceptTerms: true } });
      expect(r.isError).toBeFalsy();
    }
    const w = who();
    const limited = await client.callTool({ name: "agentdash_cloud_start", arguments: { email: w.email, slug: w.slug, acceptTerms: true } });
    expect(limited.isError).toBe(true);
    expect(text(limited)).toMatchObject({ code: "rate_limited", status: 429 });
    await client.close();
  });

  it("connect over the hosted endpoint delivers the key in the answer once, and never upgrades the session", async () => {
    const { handle } = await claimedBox();
    const client = await mcpClient(who().ip);
    expect(text(await client.callTool({ name: "agentdash_cloud_connect", arguments: { handle } }))).toMatchObject({ state: "approval_pending" });
    box.approve(box.latest()!.id);
    const delivered = text(await client.callTool({ name: "agentdash_cloud_connect", arguments: { handle } }));
    expect(delivered).toMatchObject({ state: "connected", apiKey: box.latest()!.pendingKey });
    expect(delivered.sessionUpgraded).toBeUndefined();
    expect((await client.listTools()).tools).toHaveLength(4);
    await client.close();
  });

  it("is stateless (GET and DELETE answer 405), checks Origin, and stays no-store", async () => {
    expect((await request(app).get("/api/cloud/mcp")).status).toBe(405);
    expect((await request(app).delete("/api/cloud/mcp")).status).toBe(405);
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
    const evil = await request(app).post("/api/cloud/mcp").set("origin", "https://evil.example").set("accept", "application/json, text/event-stream").send(init);
    expect(evil.status).toBe(403);
    const ok = await request(app).post("/api/cloud/mcp").set("origin", "https://www.agentdash.test").set("accept", "application/json, text/event-stream").send(init);
    expect(ok.status).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.body.result.serverInfo.name).toBe("agentdash");
    const form = await request(app).post("/api/cloud/mcp").set("content-type", "text/plain").send("x");
    expect(form.status).toBe(415);
    // A JSON-RPC batch is small, and each message counts against the limiter.
    const batch = Array.from({ length: 11 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
    expect((await request(app).post("/api/cloud/mcp").set("accept", "application/json, text/event-stream").send(batch)).status).toBe(400);
  });
});
