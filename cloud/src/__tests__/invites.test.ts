// SC-9 (GH #770): the self-hosted invite validator on the control plane,
// with the exact contract of server/src/routes/invite-codes.ts, and the admin
// CLI that imports, adds and revokes codes.
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAdmin } from "../admin/run.js";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { inviteCodes } from "../db/schema.js";
import { findHostedInvitation, inviteService, parseCodeList } from "../invites.js";
import { createLogger } from "../logger.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";

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
const KEY_A = "55".repeat(32);
const KEY_B = "66".repeat(32);
const IP = "x-agentdash-client-ip";
const PROXY_HEADER = "x-agentdash-edge-proxy";
const PROXY_SECRET = randomBytes(32).toString("hex");
let pg: TestDatabase;
let db: CloudDb;
let close: () => Promise<void>;
const logLines: string[] = [];
const log = createLogger({ write: (l) => logLines.push(l), level: "debug" });
let n = 0;

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: pg.url,
    CLOUD_DATA_KEY: KEY_A,
    CLOUD_ADMIN_TOKEN: ADMIN,
    CLOUD_ADMIN_ALLOWED_IPS: "127.0.0.1,::1",
    CLOUD_VERCEL_PROXY_SECRET: PROXY_SECRET,
    ...extra,
  });
}

const ip = () => `198.18.${++n % 250}.${Math.floor(Math.random() * 250)}`;
const validate = (app: Target | Server, body: unknown, from = ip()) =>
  request(app).post("/api/invites/validate").set(PROXY_HEADER, PROXY_SECRET).set(IP, from).send(body as object);

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

describe("POST /api/invites/validate", () => {
  it("answers {valid:true} for a known code and {valid:false} for a wrong one", async () => {
    const cfg = config();
    await inviteService(db, cfg.dataKeys).importCodes(["AGD-KNOWN-00001"], "test", "test", null);
    const app = await serve(createApp({ db, config: cfg, log }));
    const ok = await validate(app, { code: "AGD-KNOWN-00001" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ valid: true });
    expect((await validate(app, { code: "  AGD-KNOWN-00001  " })).body).toEqual({ valid: true });
    const bad = await validate(app, { code: "AGD-KNOWN-2" });
    expect(bad.status).toBe(200);
    expect(bad.body).toEqual({ valid: false });
    expect(logLines.join("\n")).not.toContain("AGD-KNOWN-00001");
  });

  it("answers 400 invalid_body for a missing, empty or oversized code", async () => {
    const app = await serve(createApp({ db, config: config(), log }));
    for (const body of [{}, { code: "" }, { code: "   " }, { code: 42 }, { code: "x".repeat(121) }]) {
      const res = await validate(app, body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: "invalid_body", error: "Body must be { code: 1-120 chars }." });
    }
  });

  it("rate limits at 10 attempts per 15 minutes per client, with Retry-After", async () => {
    const app = await serve(createApp({ db, config: config(), log }));
    const from = ip();
    for (let i = 0; i < 10; i++) expect((await validate(app, { code: `guess-${i}` }, from)).status).toBe(200);
    const res = await validate(app, { code: "guess-10" }, from);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("900");
    expect(res.body).toEqual({ error: "Rate limited", retryAfter: 900 });
    // Another client is unaffected.
    expect((await validate(app, { code: "guess" })).status).toBe(200);
  });

  it("stores only a keyed hash, refuses revoked codes, and survives a data-key rotation", async () => {
    const before = config();
    const svc = inviteService(db, before.dataKeys);
    const { id, code } = await svc.add("rotation", "test", null);
    const rows = await db.select().from(inviteCodes);
    expect(rows.some((r) => r.codeHash.includes(code) || r.label === code)).toBe(false);
    const rotated = config({ CLOUD_DATA_KEY: KEY_B, CLOUD_DATA_KEYS_PREVIOUS: KEY_A });
    const app = await serve(createApp({ db, config: rotated, log }));
    expect((await validate(app, { code })).body).toEqual({ valid: true });
    await svc.revoke(id, "test", null);
    expect((await validate(app, { code })).body).toEqual({ valid: false });
  });

  it("keys the limit on the real address unless the proxy secret vouches for the header (GH #837 review)", async () => {
    const app = await serve(createApp({ db, config: config(), log }));
    // No secret: rotating a forged X-AgentDash-Client-IP does not escape the 10 per 15 minutes on 127.0.0.1.
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await request(app).post("/api/invites/validate").set(IP, `203.0.113.${i}`).send({ code: "guess" })).status);
    }
    expect(statuses.slice(-1)[0]).toBe(429);
    // With the secret, a fresh header address is its own client.
    expect((await validate(app, { code: "guess" })).status).toBe(200);
  });

  it("every other /api path answers 410", async () => {
    const app = await serve(createApp({ db, config: config(), log }));
    for (const path of ["/api/health", "/api/auth/sign-in/email", "/api/companies"]) {
      expect((await request(app).get(path)).status).toBe(410);
    }
    expect((await request(app).post("/api/auth/sign-up/email").send({})).status).toBe(410);
    expect((await request(app).get("/api/cloud/config")).status).toBe(200);
  });
});

describe("admin invites", () => {
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

  const io = (stdin = "") => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), fetch, readStdin: async () => stdin } };
  };

  it("parses codes separated by commas, spaces or newlines", () => {
    expect(parseCodeList("a, b\nc\n\n a ,d")).toEqual(["a", "b", "c", "d"]);
  });

  it("import reads stdin and never echoes a code; add prints its one code; revoke; list", async () => {
    const env = { CLOUD_CONTROL_URL: url, CLOUD_ADMIN_TOKEN: ADMIN };
    let t = io("OLD-CODE-00001,OLD-CODE-00002\nOLD-CODE-00003\n");
    expect(await runAdmin(["invites", "import", "old-instance"], env, t.io)).toBe(0);
    expect(JSON.parse(t.out.join(""))).toEqual({ added: 3, alreadyPresent: 0, rejected: 0, rejectedShort: 0, lengths: { "1-7": 0, "8-11": 0, "12-15": 3, "16-23": 0, "24+": 0 } });
    expect(t.out.join("")).not.toContain("OLD-CODE");
    t = io("OLD-CODE-00001");
    expect(await runAdmin(["invites", "import"], env, t.io)).toBe(0);
    expect(JSON.parse(t.out.join(""))).toMatchObject({ added: 0, alreadyPresent: 1, rejected: 0 });

    // GH #837 review: short, guessable codes are refused unless the operator insists.
    t = io("SHORT1,MKTHINK26,LONG-ENOUGH-CODE-1");
    expect(await runAdmin(["invites", "import", "short-test"], env, t.io)).toBe(0);
    expect(JSON.parse(t.out.join(""))).toEqual({ added: 1, alreadyPresent: 0, rejected: 0, rejectedShort: 2, lengths: { "1-7": 1, "8-11": 1, "12-15": 0, "16-23": 1, "24+": 0 } });
    expect(t.out.join("")).not.toContain("SHORT1");
    t = io("MKTHINK26");
    expect(await runAdmin(["invites", "import", "short-test", "--allow-short"], env, t.io)).toBe(0);
    expect(JSON.parse(t.out.join(""))).toMatchObject({ added: 1, rejectedShort: 0 });

    const app = await serve(createApp({ db, config: config(), log }));
    expect((await validate(app, { code: "OLD-CODE-00002" })).body).toEqual({ valid: true });

    t = io();
    expect(await runAdmin(["invites", "add", "partner"], env, t.io)).toBe(0);
    const added = JSON.parse(t.out.join("")) as { id: string; code: string };
    expect(added.code).toMatch(/^AGD-INV-[0-9A-F]{20}$/);
    expect((await validate(app, { code: added.code })).body).toEqual({ valid: true });

    t = io();
    expect(await runAdmin(["invites", "list"], env, t.io)).toBe(0);
    expect(t.out.join("")).toContain(added.id);
    expect(t.out.join("")).not.toContain(added.code);

    t = io();
    expect(await runAdmin(["invites", "revoke", added.id], env, t.io)).toBe(0);
    expect((await validate(app, { code: added.code })).body).toEqual({ valid: false });

    const audit = (await db.execute(sql`select detail from operator_audit where kind = 'invite_codes_changed' order by id`)) as unknown as Array<{ detail: Record<string, unknown> }>;
    expect(audit.map((a) => a.detail.action)).toEqual(expect.arrayContaining(["import", "add", "revoke"]));
    expect(JSON.stringify(audit)).not.toContain("OLD-CODE");
    expect(JSON.stringify(audit)).not.toContain(added.code);
  });

  it("the admin surface refuses without the bearer", async () => {
    const app = await serve(createApp({ db, config: config(), log }));
    expect((await request(app).post("/internal/invites/import").send({ codes: "x" })).status).toBe(401);
  });
});

describe("hosted invitation admin", () => {
  it("issues an explicit hosted-only code once, lists safe metadata, and preserves self-hosted issuance", async () => {
    const app = await serve(createApp({ db, config: config(), log }));
    const server = app as http.Server;
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const out: string[] = [];
    expect(await runAdmin(["invites", "add-hosted", "synthetic"], { CLOUD_CONTROL_URL: url, CLOUD_ADMIN_TOKEN: ADMIN }, { out: l => out.push(l), err: () => {}, fetch })).toBe(0);
    const c = JSON.parse(out.join("")) as { id: string; code: string };
    expect(c.code).toMatch(/^AGD-HOST-[0-9A-F]{32}$/);
    expect((await validate(app, { code: c.code })).body).toEqual({ valid: false });
    const metadata = await request(app).get("/internal/invites").set("authorization", `Bearer ${ADMIN}`);
    expect(metadata.body.invites).toContainEqual(expect.objectContaining({ id: c.id, purpose: "hosted_beta", consumedAt: null }));
    expect(JSON.stringify(metadata.body)).not.toContain(c.code);
    expect(JSON.stringify(metadata.body)).not.toContain("codeHash");
    expect(logLines.join("\n")).not.toContain(c.code);
    const rotated = config({ CLOUD_DATA_KEY: KEY_B, CLOUD_DATA_KEYS_PREVIOUS: KEY_A });
    expect((await findHostedInvitation(db, rotated.dataKeys, c.code))?.id).toBe(c.id);
    expect((await findHostedInvitation(db, config({ CLOUD_DATA_KEY: KEY_B }).dataKeys, c.code))).toBeNull();
  });
});
