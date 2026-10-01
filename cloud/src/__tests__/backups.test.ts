// GH #733: off-box backups end to end, against embedded Postgres, a fake box
// and a fake S3, with no network beyond 127.0.0.1:
//
//   seeded box database
//     → the box's REAL export route (server/src/routes/agentdash-backup-export.ts)
//       producing a REAL dump (packages/db/src/backup-lib.ts, the pg_dump-less
//       engine the box image uses)
//     → the control plane's backup service: encrypt to the offline key, upload
//     → a fake S3 that checks every SigV4 signature and payload hash
//     → download → the offline restore tool: decrypt, restore into a throwaway
//       database, verify the counts → row-for-row comparison with the source.
// Plus: the scheduler's daily claim and retries, retention, the missing and
// rejected token paths, the event hook, fleet status, and the restore tool's
// refusal to touch a database that looks like a live box.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { eq, sql } from "drizzle-orm";
import express from "express";
import sodium from "libsodium-wrappers";
import postgres from "postgres";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { backupRoutes } from "../backups/routes.js";
import { S3Store, signV4 } from "../backups/s3.js";
import { backupService, fleetBackupStatus, staleBackups, type BackupEvent, type BackupTokenSource, type BoxRow } from "../backups/service.js";
import { runRestoreTool } from "../backups/restore-tool.js";
import { createEncryptStream } from "../backups/envelope.js";
import { STATEMENT_BREAKPOINT } from "../backups/dump-guard.js";
import { encryptField, parseKeyring } from "../crypto.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { accounts, boxBackups, boxEvents, boxes, type BoxState } from "../db/schema.js";
import { createLogger } from "../logger.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";

const KEYS = parseKeyring("55".repeat(32));
const TOKEN = "b".repeat(64);
const EDGE = "e".repeat(64);
const S3_CREDS = { accessKeyId: "AKIDFAKE", secretAccessKey: "fake-secret-access-key", region: "auto" };
const MARKER = "PLAINTEXT-MARKER-6d1f";

let pg: TestDatabase;
let db: CloudDb;
let close: () => Promise<void>;
let pgBase: string;
let boxUrl: string;
const log = createLogger({ write: () => {}, level: "debug" });
let backupKeys: { publicKey: Uint8Array; privateKey: Uint8Array };
let keyDir: string;
let work: string;
let seq = 0;
let roundTripFile = "";

// ---- fake S3 ---------------------------------------------------------------
const objects = new Map<string, Buffer>();
const s3Requests: string[] = [];
let s3: http.Server;
let s3Url: string;

function startFakeS3(): Promise<void> {
  s3 = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const body = Buffer.concat(parts);
    const url = new URL(req.url!, `http://${req.headers.host}`);
    s3Requests.push(`${req.method} ${url.pathname}`);
    const auth = String(req.headers.authorization ?? "");
    const signed = /SignedHeaders=([^,]+),/.exec(auth)?.[1]?.split(";").filter((h) => h !== "host") ?? [];
    const headers = Object.fromEntries(signed.map((h) => [h, String(req.headers[h] ?? "")]));
    const expected = signV4({ method: req.method!, url, headers, ...S3_CREDS, amzDate: String(req.headers["x-amz-date"]) });
    const fail = (status: number, code: string) => {
      res.writeHead(status, { "content-type": "application/xml" });
      res.end(`<Error><Code>${code}</Code></Error>`);
    };
    if (!auth || expected !== auth) return fail(403, "SignatureDoesNotMatch");
    if (req.method === "PUT") {
      if (!req.headers["content-length"]) return fail(411, "MissingContentLength");
      if (createHash("sha256").update(body).digest("hex") !== req.headers["x-amz-content-sha256"]) return fail(400, "XAmzContentSHA256Mismatch");
      objects.set(url.pathname, body);
      res.writeHead(200).end();
    } else if (req.method === "GET") {
      const o = objects.get(url.pathname);
      if (!o) return fail(404, "NoSuchKey");
      res.writeHead(200, { "content-length": String(o.length) }).end(o);
    } else if (req.method === "DELETE") {
      objects.delete(url.pathname);
      res.writeHead(204).end();
    } else fail(405, "MethodNotAllowed");
  });
  return new Promise((r) => s3.listen(0, "127.0.0.1", () => {
    s3Url = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
    r();
  }));
}

function store(overrides: Partial<{ secret: string }> = {}) {
  return new S3Store({ endpoint: s3Url, bucket: "agentdash-backups", region: S3_CREDS.region, accessKeyId: S3_CREDS.accessKeyId, secretAccessKey: { reveal: () => overrides.secret ?? S3_CREDS.secretAccessKey } as never, prefix: "boxes" });
}

// ---- fake box: the real export route over a real dump ----------------------
let boxServer: http.Server;
let boxHost: string;
let exportsServed = 0;

async function startFakeBox(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const routeFile = pathToFileURL(path.resolve(here, "../../../server/src/routes/agentdash-backup-export.ts")).href;
  const libFile = pathToFileURL(path.resolve(here, "../../../packages/db/src/backup-lib.ts")).href;
  const route = await import(routeFile);
  const lib = await import(libFile);
  // The box image ships no pg_dump: force backup-lib's own engine, as on a box.
  process.env.PAPERCLIP_PG_DUMP_PATH = path.join(os.tmpdir(), "no-such-pg_dump");
  const sqlBox = postgres(boxUrl, { max: 1, onnotice: () => {} });
  const service = {
    async run() {
      exportsServed++;
      const counts = await route.collectBackupCounts((text: string) => sqlBox.unsafe(text));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-box-export-"));
      const result = await lib.runDatabaseBackup({ connectionString: boxUrl, backupDir: dir, retention: { dailyDays: 1, weeklyWeeks: 0, monthlyMonths: 0 }, filenamePrefix: "offbox-export" });
      return { file: result.backupFile, counts, cleanup: async () => fs.rmSync(dir, { recursive: true, force: true }) };
    },
  };
  const app = express();
  // The edge gate, as on a box behind the router.
  app.use((req, res, next) => (req.headers["x-agentdash-edge"] === EDGE ? next() : void res.status(403).json({ code: "edge_required" })));
  app.use(route.backupExportRoutes({ token: TOKEN, service, release: "v2026.1001.0" }));
  app.use((_req, res) => void res.status(404).end());
  boxServer = http.createServer(app);
  await new Promise<void>((r) => boxServer.listen(0, "127.0.0.1", () => r()));
  boxHost = `127.0.0.1:${(boxServer.address() as AddressInfo).port}`;
}

async function seedBoxDatabase(url: string) {
  const s = postgres(url, { max: 1, onnotice: () => {} });
  await s.unsafe(`
    create type issue_state as enum ('open', 'done');
    create table companies (id uuid primary key default gen_random_uuid(), name text not null, meta jsonb);
    create table "user" (id text primary key, email text not null, created_at timestamptz not null default now());
    create table agents (id serial primary key, company_id uuid references companies(id), name text, config jsonb);
    create table issues (id bigserial primary key, title text, body text, state issue_state not null default 'open');
    create table company_memberships (company_id uuid references companies(id), user_id text references "user"(id));
    create schema drizzle;
    create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
  `);
  const [co] = await s`insert into companies (name, meta) values ('Acme', ${s.json({ plan: "pro", nested: { a: [1, 2] } })}) returning id`;
  await s`insert into "user" (id, email) values ('u1', 'founder@acme.test'), ('u2', 'ops@acme.test')`;
  await s`insert into company_memberships values (${co!.id}, 'u1'), (${co!.id}, 'u2')`;
  await s`insert into agents (company_id, name, config) values (${co!.id}, 'Chief of Staff', ${s.json({ model: "x" })}), (${co!.id}, 'Builder', null)`;
  for (let i = 0; i < 300; i++) {
    await s`insert into issues (title, body, state) values (${`issue ${i}`}, ${i % 7 === 0 ? null : `line one\ttab\nline two \\ backslash ünïcödé ${MARKER} ${i}`}, ${i % 3 === 0 ? "done" : "open"})`;
  }
  for (let i = 0; i < 12; i++) await s`insert into drizzle.__drizzle_migrations (hash, created_at) values (${`h${i}`}, ${1_700_000_000_000 + i})`;
  await s.end();
}

let sandboxSeq = 0;
/** A disposable database owned by a fresh NON-superuser role (the sandbox's restore role, runbook §7). */
async function sandboxDatabase(opts: { superuser?: boolean } = {}): Promise<string> {
  const n = ++sandboxSeq;
  const role = `restore_role_${n}`;
  const dbName = `restore_db_${n}_${randomUUID().slice(0, 6)}`;
  const a = postgres(`${pgBase}/postgres`, { max: 1, onnotice: () => {} });
  try {
    await a.unsafe(`create role ${role} login password 'sandbox' ${opts.superuser ? "superuser" : "nosuperuser"}`);
    await a.unsafe(`create database ${dbName} owner ${role}`);
    await a.unsafe(`grant set on parameter session_replication_role to ${role}`);
  } finally {
    await a.end();
  }
  return `postgres://${role}:sandbox@127.0.0.1:${new URL(pgBase).port}/${dbName}`;
}

async function snapshot(url: string) {
  const s = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return {
      companies: await s`select id, name, meta from companies order by id`,
      users: await s`select id, email, created_at from "user" order by id`,
      agents: await s`select * from agents order by id`,
      issues: await s`select id, title, body, state::text from issues order by id`,
      memberships: await s`select * from company_memberships order by user_id`,
      migrations: await s`select * from drizzle.__drizzle_migrations order by id`,
    };
  } finally {
    await s.end();
  }
}

beforeAll(async () => {
  await sodium.ready;
  backupKeys = sodium.crypto_box_keypair();
  work = fs.mkdtempSync(path.join(os.tmpdir(), "backups-test-"));
  keyDir = path.join(work, "keys");
  fs.mkdirSync(keyDir, { mode: 0o700 });
  fs.writeFileSync(path.join(keyDir, "escrow-public-key"), Buffer.from(backupKeys.publicKey).toString("base64"));
  fs.writeFileSync(path.join(keyDir, "escrow-secret-key"), Buffer.from(backupKeys.privateKey).toString("base64"), { mode: 0o600 });

  pg = await startTestDatabase();
  await migrateCloudDb(pg.url);
  ({ db, close } = createCloudDb(pg.url));
  pgBase = pg.url.replace(/\/cloud_control$/, "");
  const admin = postgres(`${pgBase}/postgres`, { max: 1, onnotice: () => {} });
  await admin.unsafe("create database box_live");
  await admin.end();
  boxUrl = `${pgBase}/box_live`;
  await seedBoxDatabase(boxUrl);
  await startFakeS3();
  await startFakeBox();
});

afterAll(async () => {
  if (boxServer) await new Promise((r) => boxServer.close(r));
  if (s3) await new Promise((r) => s3.close(r));
  await close?.();
  await pg?.stop();
  fs.rmSync(work, { recursive: true, force: true });
});

beforeEach(async () => {
  // Earlier tests' boxes must not be due for this test's scheduler passes.
  await db.execute(sql`update boxes set upstream_host = null where state = 'active'`);
});

async function makeBox(state: BoxState = "active", extra: Partial<typeof boxes.$inferInsert> = {}): Promise<BoxRow> {
  const n = ++seq;
  const [acct] = await db.insert(accounts).values({ email: `b${n}-${Date.now()}@example.test` }).returning();
  const [box] = await db.insert(boxes).values({ accountId: acct!.id, slug: `bk${n}x${Date.now() % 100000}` }).returning();
  const walk: Partial<Record<BoxState, BoxState[]>> = {
    active: ["provisioning", "awaiting_claim", "active"],
    suspended: ["provisioning", "awaiting_claim", "active", "suspended"],
    awaiting_claim: ["provisioning", "awaiting_claim"],
  };
  for (const s of walk[state] ?? []) await db.update(boxes).set({ state: s }).where(eq(boxes.id, box!.id));
  await db
    .update(boxes)
    .set({ upstreamHost: boxHost, edgeSecretEnc: encryptField(KEYS, EDGE, "boxes.edge_secret_enc"), claimedAt: new Date(Date.now() - 5 * 86_400_000), ...extra })
    .where(eq(boxes.id, box!.id));
  const [fresh] = await db.select().from(boxes).where(eq(boxes.id, box!.id));
  return fresh!;
}

function tokens(map: Map<string, string | null>, installed: string[] = []): BackupTokenSource {
  return {
    get: async (box) => (map.has(box.id) ? map.get(box.id)! : TOKEN),
    install: async (box, t) => {
      installed.push(box.slug);
      map.set(box.id, t);
    },
  };
}

function service(opts: { events?: BackupEvent[]; tokenMap?: Map<string, string | null>; installed?: string[]; now?: () => Date; hourUtc?: number; s3secret?: string; concurrency?: number } = {}) {
  return backupService({
    db,
    log,
    store: store({ secret: opts.s3secret }),
    publicKey: backupKeys.publicKey,
    tokens: tokens(opts.tokenMap ?? new Map(), opts.installed),
    dataKeys: KEYS,
    retainDaily: 7,
    retainWeekly: 4,
    maxAttempts: 3,
    concurrency: opts.concurrency ?? 2,
    hourUtc: opts.hourUtc ?? 0,
    now: opts.now,
    onEvent: (e) => void opts.events?.push(e),
    boxScheme: "http",
  });
}

async function rowsFor(boxId: string) {
  return await db.select().from(boxBackups).where(eq(boxBackups.boxId, boxId));
}

describe("off-box backup round trip", () => {
  it("dump → encrypt → upload → download → decrypt → restore reproduces the box database", async () => {
    const box = await makeBox();
    const events: BackupEvent[] = [];
    const svc = service({ events });
    const { done } = await svc.runManual(box.slug);
    const row = await done;
    expect(row?.state).toBe("succeeded");
    expect(row).toMatchObject({ trigger: "manual", format: "paperclip-sql-gz-v1", release: "v2026.1001.0", counts: { companies: 1, users: 2, agents: 2, issues: 300, memberships: 2, migrations: 12 } });
    expect(row!.objectPath).toMatch(new RegExp(`^${box.slug}/${box.id}/\\d{4}-\\d{2}-\\d{2}/.+\\.adbk$`));
    expect(events.map((e) => e.kind)).toEqual(["backup_succeeded"]);
    expect(JSON.stringify(events)).not.toContain(TOKEN);

    // Stored encrypted, with the recorded hash.
    const stored = objects.get(`/agentdash-backups/boxes/${row!.objectPath}`)!;
    expect(stored).toBeDefined();
    expect(stored.length).toBe(row!.sizeBytes);
    expect(createHash("sha256").update(stored).digest("hex")).toBe(row!.sha256);
    expect(stored.includes(Buffer.from(MARKER))).toBe(false);
    expect(stored.includes(Buffer.from("founder@acme.test"))).toBe(false);

    // Download through the operator route, as `admin backups download` does.
    const app = express().use("/internal", backupRoutes(db, log, { store: store(), staleHours: 36 }));
    const dl = await request(app).get(`/internal/backups/${row!.id}/download`).buffer(true).parse((res, cb) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => cb(null, Buffer.concat(parts)));
    });
    expect(dl.status).toBe(200);
    expect(dl.headers["x-agentdash-backup-sha256"]).toBe(row!.sha256);
    const file = path.join(work, `${row!.id}.adbk`);
    fs.writeFileSync(file, dl.body as Buffer);
    roundTripFile = file;

    // The offline tool: inspect needs no key and never shows the sealed data key.
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) };
    expect(await runRestoreTool(["inspect", "--in", file], io)).toBe(0);
    expect(out.join("\n")).toContain(box.slug);
    expect(out.join("\n")).not.toContain("sealedDataKey");

    // Step 1, on the KEY machine: decrypt, check it is the backup asked for, and run the safety check.
    out.length = 0;
    const dump = path.join(work, `${row!.id}.sql.gz`);
    expect(await runRestoreTool(["decrypt", "--in", file, "--key-dir", keyDir, "--out", dump, "--expect-slug", "someone-else"], io)).toBe(3);
    expect(fs.existsSync(dump)).toBe(false);
    const dc = await runRestoreTool(["decrypt", "--in", file, "--key-dir", keyDir, "--out", dump, "--expect-slug", box.slug, "--expect-backup-id", row!.id], io);
    expect(dc).toBe(0);
    expect(out.join("\n")).toMatch(/safety check passed: \d+ statement\(s\), [1-9]\d* COPY block\(s\)/);
    expect((fs.statSync(dump).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(fs.readFileSync(`${dump}.manifest.json`, "utf8"))).toMatchObject({ backupId: row!.id, slug: box.slug, counts: { issues: 300 } });
    expect(fs.existsSync(`${dump}.partial`)).toBe(false);

    // Step 2, in the SANDBOX: replay as a non-superuser, then verify. A superuser is refused.
    out.length = 0;
    const superTarget = await sandboxDatabase({ superuser: true });
    await expect(runRestoreTool(["replay", "--dump", dump, "--into", superTarget], io)).rejects.toThrow(/superuser/);
    const target = await sandboxDatabase();
    const code = await runRestoreTool(["replay", "--dump", dump, "--into", target], io);
    expect(out.join("\n")).toContain("RESTORE TEST PASSED");
    expect(out.join("\n")).toMatch(/replayed \d+ statement\(s\), [1-9]\d* COPY block\(s\)/);
    expect(code).toBe(0);
    expect(await snapshot(target)).toEqual(await snapshot(boxUrl));
    // Sequences carry on where the source left off.
    const r = postgres(target, { max: 1, onnotice: () => {} });
    const [next] = await r`insert into issues (title) values ('after restore') returning id`;
    await r.end();
    expect(Number(next!.id)).toBe(301);
    // Replay never takes key material.
    expect(await runRestoreTool(["replay", "--dump", dump, "--into", target, "--key-dir", keyDir], io)).toBe(64);
  });

  it("the wrong key cannot open a backup", async () => {
    const otherDir = path.join(work, "other-keys");
    fs.mkdirSync(otherDir, { mode: 0o700 });
    const kp = sodium.crypto_box_keypair();
    fs.writeFileSync(path.join(otherDir, "escrow-public-key"), Buffer.from(kp.publicKey).toString("base64"));
    fs.writeFileSync(path.join(otherDir, "escrow-secret-key"), Buffer.from(kp.privateKey).toString("base64"));
    const out = path.join(work, "wrong-key.sql.gz");
    await expect(runRestoreTool(["decrypt", "--in", roundTripFile, "--key-dir", otherDir, "--out", out], { out: () => {}, err: () => {} })).rejects.toThrow(/sealed to backup key/);
    expect(fs.existsSync(out) || fs.existsSync(`${out}.partial`)).toBe(false);
  });

  it("refuses to replay over a database that looks like a live box", async () => {
    const dump = path.join(work, "guard.sql.gz");
    expect(await runRestoreTool(["decrypt", "--in", roundTripFile, "--key-dir", keyDir, "--out", dump], { out: () => {}, err: () => {} })).toBe(0);
    const errs: string[] = [];
    const before = await snapshot(boxUrl);
    const code = await runRestoreTool(["replay", "--dump", dump, "--into", boxUrl], { out: () => {}, err: (l) => errs.push(l) });
    expect(code).toBe(3);
    expect(errs.join(" ")).toMatch(/looks like a live box/);
    expect(await snapshot(boxUrl)).toEqual(before);
  });

  it("a hostile dump from a compromised box is refused at decrypt and at replay, and runs nothing", async () => {
    const pwned = path.join(work, "pwned");
    const hostileSql = [
      "BEGIN;",
      'CREATE TABLE "public"."t" ("a" text);',
      `COPY "public"."t" ("a") FROM PROGRAM 'touch ${pwned}';`,
      "\\! touch " + pwned,
      "CREATE EVENT TRIGGER e ON ddl_command_start EXECUTE FUNCTION f();",
      "ALTER SYSTEM SET archive_command = 'x';",
      "CREATE EXTENSION IF NOT EXISTS plpython3u;",
      "COMMIT;",
    ].join(`\n${STATEMENT_BREAKPOINT}\n`);
    const plain = path.join(work, "hostile.sql.gz");
    fs.writeFileSync(plain, zlib.gzipSync(hostileSql));
    const sealed = path.join(work, "hostile.adbk");
    const enc = await createEncryptStream(backupKeys.publicKey, { backupId: randomUUID(), boxId: randomUUID(), slug: "evil", createdAt: new Date().toISOString(), format: "paperclip-sql-gz-v1", release: null, counts: { migrations: 1 } });
    await pipeline(fs.createReadStream(plain), enc, fs.createWriteStream(sealed));

    const errs: string[] = [];
    const out = path.join(work, "hostile-out.sql.gz");
    expect(await runRestoreTool(["decrypt", "--in", sealed, "--key-dir", keyDir, "--out", out], { out: () => {}, err: (l) => errs.push(l) })).toBe(4);
    expect(fs.existsSync(out) || fs.existsSync(`${out}.partial`)).toBe(false);
    expect(errs.join(" ")).toMatch(/COPY other than/);
    expect(errs.join(" ")).toMatch(/psql meta-command/);
    expect(errs.join(" ")).toMatch(/extension plpython3u/);

    const target = await sandboxDatabase();
    await expect(runRestoreTool(["replay", "--dump", plain, "--into", target], { out: () => {}, err: () => {} })).rejects.toThrow(/safety check/);
    const t = postgres(target, { max: 1, onnotice: () => {} });
    const [exists] = await t`select to_regclass('public.t') is not null as present`;
    await t.end();
    expect(exists!.present).toBe(false);
    expect(fs.existsSync(pwned)).toBe(false);
  });
});

describe("failures and the event hook", () => {
  it("an export reporting no applied migrations is not stored (junk must not push out good dailies)", async () => {
    const junk = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/gzip", "x-agentdash-backup-counts": JSON.stringify({ users: 0, migrations: 0 }), "x-agentdash-backup-format": "paperclip-sql-gz-v1" });
      res.end(Buffer.from("junk"));
    });
    await new Promise<void>((r) => junk.listen(0, "127.0.0.1", () => r()));
    try {
      const box = await makeBox("active", { upstreamHost: `127.0.0.1:${(junk.address() as AddressInfo).port}` });
      const events: BackupEvent[] = [];
      const puts = s3Requests.filter((r) => r.startsWith("PUT")).length;
      expect(await (await service({ events }).runManual(box.slug)).done).toBeNull();
      expect(events.map((e) => e.reason)).toEqual(["export_failed"]);
      expect(events[0]!.error).toMatch(/no applied migrations/);
      expect(s3Requests.filter((r) => r.startsWith("PUT")).length).toBe(puts);
    } finally {
      await new Promise((r) => junk.close(r));
    }
  });

  it("a box without a token gets one (live at its next deploy) and the backup fails for now", async () => {
    const box = await makeBox();
    const events: BackupEvent[] = [];
    const installed: string[] = [];
    const map = new Map<string, string | null>([[box.id, null]]);
    const svc = service({ events, tokenMap: map, installed });
    expect(await (await svc.runManual(box.slug)).done).toBeNull();
    expect(installed).toEqual([box.slug]);
    expect(map.get(box.id)).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await rowsFor(box.id);
    expect(row).toMatchObject({ state: "failed" });
    expect(row!.error).toMatch(/^token_pending_deploy/);
    expect(row!.error).not.toContain(map.get(box.id)!);
    expect(events.map((e) => [e.kind, e.reason])).toEqual([["backup_token_installed", undefined], ["backup_gave_up", "token_pending_deploy"]]);
    const evs = await db.select().from(boxEvents).where(eq(boxEvents.boxId, box.id));
    expect(evs.map((e) => e.kind).sort()).toEqual(["backup_failed", "backup_token_installed"]);
  });

  it("a rejected token, an edge mismatch and a store refusal are recorded with their reason", async () => {
    const box = await makeBox();
    const events: BackupEvent[] = [];
    await (await service({ events, tokenMap: new Map([[box.id, "x".repeat(64)]]) }).runManual(box.slug)).done;
    const box2 = await makeBox("active", { edgeSecretEnc: encryptField(KEYS, "f".repeat(64), "boxes.edge_secret_enc") });
    await (await service({ events }).runManual(box2.slug)).done;
    const box3 = await makeBox();
    await (await service({ events, s3secret: "wrong" }).runManual(box3.slug)).done;
    expect(events.map((e) => e.reason)).toEqual(["token_rejected", "token_rejected", "upload_failed"]);
    expect(events[2]!.error).toMatch(/SignatureDoesNotMatch/);
    expect((await rowsFor(box3.id))[0]!.state).toBe("failed");
  });
});

describe("the scheduler", () => {
  it("waits for the hour, backs each active box up once a day, and retries a failure later", async () => {
    const box = await makeBox();
    const today = new Date();
    const early = () => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 0, 30));
    expect((await service({ now: early, hourUtc: 8 }).runDue()).started).toEqual([]);

    const map = new Map<string, string | null>([[box.id, "x".repeat(64)]]); // rejected at first
    const events: BackupEvent[] = [];
    const svc = service({ tokenMap: map, events });
    expect((await svc.runDue()).started).toEqual([box.slug]);
    let [row] = await rowsFor(box.id);
    expect(row).toMatchObject({ trigger: "scheduled", state: "failed", attempt: 1 });
    expect(events.at(-1)?.kind).toBe("backup_failed"); // not the last attempt

    // Too soon to retry.
    expect((await svc.runDue()).started).toEqual([]);
    // Thirty minutes later, with a good token: attempt 2 on the same row.
    await db.update(boxBackups).set({ finishedAt: new Date(Date.now() - 31 * 60_000) }).where(eq(boxBackups.id, row!.id));
    map.delete(box.id);
    expect((await svc.runDue()).started).toEqual([box.slug]);
    [row] = await rowsFor(box.id);
    expect(row).toMatchObject({ state: "succeeded", attempt: 2 });
    // Done for today.
    expect((await svc.runDue()).started).toEqual([]);
    expect((await rowsFor(box.id)).length).toBe(1);
  });

  it("gives up after the last attempt", async () => {
    const box = await makeBox();
    const events: BackupEvent[] = [];
    const svc = service({ tokenMap: new Map([[box.id, "x".repeat(64)]]), events });
    for (let i = 0; i < 3; i++) {
      await db.update(boxBackups).set({ finishedAt: new Date(Date.now() - 31 * 60_000) }).where(eq(boxBackups.boxId, box.id));
      await svc.runDue();
    }
    await db.update(boxBackups).set({ finishedAt: new Date(Date.now() - 31 * 60_000) }).where(eq(boxBackups.boxId, box.id));
    expect((await svc.runDue()).started).toEqual([]);
    expect(events.map((e) => e.kind)).toEqual(["backup_failed", "backup_failed", "backup_gave_up"]);
  });

  it("two workers never claim the same box and day", async () => {
    const box = await makeBox();
    const day = new Date().toISOString().slice(0, 10);
    const [a, b] = await Promise.all([service().claimScheduled(box.id, day), service().claimScheduled(box.id, day)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    // A crashed worker's expired lease is reclaimable.
    await db.update(boxBackups).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(boxBackups.boxId, box.id));
    expect(await service().claimScheduled(box.id, day)).toMatchObject({ attempt: 2 });
  });

  it("only backs up active boxes", async () => {
    const suspended = await makeBox("suspended");
    const waiting = await makeBox("awaiting_claim");
    const started = (await service().runDue()).started;
    expect(started).not.toContain(suspended.slug);
    expect(started).not.toContain(waiting.slug);
  });
});

describe("retention and status", () => {
  it("prunes to 7 daily plus 4 weekly, deleting the objects", async () => {
    const box = await makeBox();
    const s = store();
    const svc = service();
    const base = Date.UTC(2026, 7, 1);
    for (let i = 0; i < 40; i++) {
      const d = new Date(base + i * 86_400_000);
      const p = `${box.slug}/${box.id}/${d.toISOString().slice(0, 10)}/x-${i}.adbk`;
      const f = path.join(work, `ret-${i}`);
      fs.writeFileSync(f, `obj ${i}`);
      await s.put(p, f, { size: fs.statSync(f).size, sha256: createHash("sha256").update(`obj ${i}`).digest("hex") });
      await db.insert(boxBackups).values({ boxId: box.id, trigger: "manual", backupDay: d.toISOString().slice(0, 10), state: "succeeded", objectPath: p, startedAt: d, finishedAt: new Date(d.getTime() + 3_600_000) });
    }
    const pruned = await svc.prune(box);
    const rows = await rowsFor(box.id);
    const kept = rows.filter((r) => r.state === "succeeded");
    expect(pruned).toBe(40 - kept.length);
    expect(kept.length).toBeGreaterThan(7);
    expect(kept.length).toBeLessThanOrEqual(11);
    for (const r of rows) expect(objects.has(`/agentdash-backups/boxes/${r.objectPath}`)).toBe(r.state === "succeeded");
    expect(rows.filter((r) => r.state === "pruned").every((r) => r.prunedAt)).toBe(true);
  });

  it("reports stale boxes for the fleet view and SC-10", async () => {
    const fresh = await makeBox();
    await (await service().runManual(fresh.slug)).done;
    const never = await makeBox();
    const newBox = await makeBox("active", { claimedAt: new Date() });
    const status = await fleetBackupStatus(db, { staleHours: 36 });
    const by = (slug: string) => status.find((s) => s.slug === slug)!;
    expect(by(fresh.slug)).toMatchObject({ stale: false, lastAttemptState: "succeeded" });
    expect(by(fresh.slug).ageHours).toBeLessThan(1);
    expect(by(never.slug)).toMatchObject({ stale: true, lastSuccessAt: null });
    expect(by(newBox.slug).stale).toBe(false); // inside its grace period
    const stale = (await staleBackups(db, { staleHours: 36 })).map((s) => s.slug);
    expect(stale).toContain(never.slug);
    expect(stale).not.toContain(fresh.slug);

    const app = express().use("/internal", backupRoutes(db, log, { staleHours: 36 }));
    const res = await request(app).get("/internal/backups");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.stale).toContain(never.slug);
    const list = await request(app).get(`/internal/boxes/${fresh.slug}/backups`);
    expect(list.body.backups[0]).toMatchObject({ state: "succeeded", trigger: "manual" });
    expect(JSON.stringify(list.body)).not.toMatch(/objectPath|lockedBy/);
    expect((await request(app).post(`/internal/boxes/${fresh.slug}/backups`)).status).toBe(409);
  });
});
