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
import { buildReference, loadBoxMigrations, type BoxMigration } from "../backups/schema-verify.js";
import { createEncryptStream } from "../backups/envelope.js";
import { STATEMENT_BREAKPOINT } from "../backups/dump-guard.js";
import { EXTENDED_PROTOCOL, replayDump } from "../backups/sql-restore.js";
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
let roundTripDump = "";

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

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/src/migrations");
let ourMigrations: BoxMigration[] = [];

/** A box database with OUR real schema (every migration in packages/db), then customer data. */
async function seedBoxDatabase(url: string) {
  ourMigrations = loadBoxMigrations(MIGRATIONS_DIR);
  await buildReference(url, ourMigrations);
  const s = postgres(url, { max: 1, onnotice: () => {} });
  const [co] = await s`insert into companies (name) values ('Acme') returning id`;
  await s`insert into "user" (id, name, email, created_at, updated_at) values ('u1', 'Founder', 'founder@acme.test', now(), now()), ('u2', 'Ops', 'ops@acme.test', now(), now())`;
  await s`insert into company_memberships (company_id, principal_type, principal_id) values (${co!.id}, 'user', 'u1'), (${co!.id}, 'user', 'u2')`;
  await s`insert into agents (company_id, name) values (${co!.id}, 'Chief of Staff'), (${co!.id}, 'Builder')`;
  for (let i = 0; i < 300; i++) {
    await s`insert into issues (company_id, title) values (${co!.id}, ${i % 7 === 0 ? `issue ${i}` : `line one\ttab\nline two \\ backslash ünïcödé '; DROP TABLE x; -- ${MARKER} ${i}`})`;
  }
  await s.end();
}

let sandboxSeq = 0;
/**
 * A sandbox as runbook §7 sets one up: a fresh plain role (not a superuser,
 * member of no role) owning two empty databases, one to replay into and one
 * for the reference schema.
 */
async function sandboxDatabase(opts: { superuser?: boolean; grantRole?: string; createrole?: boolean } = {}): Promise<{ url: string; reference: string }> {
  const n = ++sandboxSeq;
  const role = `restore_role_${n}`;
  const dbName = `restore_db_${n}_${randomUUID().slice(0, 6)}`;
  const a = postgres(`${pgBase}/postgres`, { max: 1, onnotice: () => {} });
  try {
    await a.unsafe(`create role ${role} login password 'sandbox' ${opts.superuser ? "superuser" : "nosuperuser"} ${opts.createrole ? "createrole" : ""}`);
    if (opts.grantRole) await a.unsafe(`grant ${opts.grantRole} to ${role}`);
    await a.unsafe(`create database ${dbName} owner ${role}`);
    await a.unsafe(`create database ${dbName}_ref owner ${role}`);
    await a.unsafe(`grant set on parameter session_replication_role to ${role}`);
  } finally {
    await a.end();
  }
  const base = `postgres://${role}:sandbox@127.0.0.1:${new URL(pgBase).port}`;
  return { url: `${base}/${dbName}`, reference: `${base}/${dbName}_ref` };
}

async function snapshot(url: string) {
  const s = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return {
      companies: await s`select * from companies order by id`,
      users: await s`select * from "user" order by id`,
      agents: await s`select * from agents order by id`,
      issues: await s`select * from issues order by id`,
      memberships: await s`select * from company_memberships order by principal_id`,
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

const silent = { out: () => {}, err: () => {} };

/** Decrypt the round-trip backup again into a fresh file (decrypt never overwrites). */
let decryptSeq = 0;
async function freshDump(): Promise<string> {
  const header = JSON.parse(fs.readFileSync(`${roundTripDump}.manifest.json`, "utf8")) as { slug: string; backupId: string };
  const out = path.join(work, `dump-${++decryptSeq}.sql.gz`);
  expect(await runRestoreTool(["decrypt", "--in", roundTripFile, "--key-dir", keyDir, "--out", out, "--expect-slug", header.slug, "--expect-backup-id", header.backupId], silent)).toBe(0);
  return out;
}

/** Rewrite a decrypted dump's SQL (a box that is lying), keeping the format. */
function tamper(dump: string, edit: (sql: string) => string): string {
  const out = path.join(work, `tampered-${++decryptSeq}.sql.gz`);
  fs.writeFileSync(out, zlib.gzipSync(edit(zlib.gunzipSync(fs.readFileSync(dump)).toString("utf8"))));
  return out;
}

const beforeCommit = (extra: string) => (sql: string) => {
  const at = sql.lastIndexOf("\nCOMMIT;");
  if (at < 0) throw new Error("no COMMIT in the dump");
  return `${sql.slice(0, at)}\n${extra}\n${STATEMENT_BREAKPOINT}${sql.slice(at)}`;
};

describe("off-box backup round trip", () => {
  it("dump → encrypt → upload → download → decrypt → replay (sandbox) → schema check reproduces the box database", async () => {
    const box = await makeBox();
    const events: BackupEvent[] = [];
    const svc = service({ events });
    const { done } = await svc.runManual(box.slug);
    const row = await done;
    expect(row?.state).toBe("succeeded");
    expect(row).toMatchObject({ trigger: "manual", format: "paperclip-sql-gz-v1", release: "v2026.1001.0", counts: { companies: 1, users: 2, agents: 2, issues: 300, memberships: 2, migrations: ourMigrations.length } });
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

    // Step 1, on the KEY machine: decrypt (both expectations required), parse-check, never overwrite.
    out.length = 0;
    const dump = path.join(work, `${row!.id}.sql.gz`);
    expect(await runRestoreTool(["decrypt", "--in", file, "--key-dir", keyDir, "--out", dump, "--expect-slug", box.slug], io)).toBe(64);
    expect(await runRestoreTool(["decrypt", "--in", file, "--key-dir", keyDir, "--out", dump, "--expect-slug", "someone-else", "--expect-backup-id", row!.id], io)).toBe(3);
    expect(fs.existsSync(dump)).toBe(false);
    const dcode = await runRestoreTool(["decrypt", "--in", file, "--key-dir", keyDir, "--out", dump, "--expect-slug", box.slug, "--expect-backup-id", row!.id], io);
    expect(dcode).toBe(0);
    expect(out.join("\n")).toMatch(/safety check passed: \d+ statement\(s\), [1-9]\d* COPY block\(s\)/);
    expect((fs.statSync(dump).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(fs.readFileSync(`${dump}.manifest.json`, "utf8"))).toMatchObject({ backupId: row!.id, slug: box.slug, counts: { issues: 300 } });
    expect(fs.existsSync(`${dump}.partial`)).toBe(false);
    roundTripDump = dump;
    // Never overwrites an existing output.
    const before = fs.readFileSync(dump);
    expect(await runRestoreTool(["decrypt", "--in", file, "--key-dir", keyDir, "--out", dump, "--expect-slug", box.slug, "--expect-backup-id", row!.id], io)).toBe(3);
    expect(fs.readFileSync(dump).equals(before)).toBe(true);

    // Step 2, in the SANDBOX: replay as the plain restore role, then the schema check against our migrations.
    out.length = 0;
    const target = await sandboxDatabase();
    const code = await runRestoreTool(["replay", "--dump", dump, "--into", target.url, "--reference", target.reference, "--migrations-dir", MIGRATIONS_DIR], io);
    expect(out.join("\n")).toMatch(/re-created \d+ object\(s\) .*the schema now matches exactly/);
    expect(out.join("\n")).toMatch(/replayed \d+ statement\(s\), [1-9]\d* COPY block\(s\)/);
    // AgentDash (GH #907): the dump now carries CHECK constraints, views, functions and
    // triggers; replay skips every one of them (box-written code never runs) and the
    // schema check re-creates them from our migrations.
    expect(out.join("\n")).toMatch(/skipped [1-9]\d* schema object\(s\)/);
    expect(out.join("\n")).toMatch(new RegExp(`schema check against ${ourMigrations.length} of our migrations .*no unexplained objects`));
    expect(out.join("\n")).toContain("RESTORE TEST PASSED");
    expect(code).toBe(0);
    expect(await snapshot(target.url)).toEqual(await snapshot(boxUrl));
    // Sequences carry on where the source left off.
    const r = postgres(target.url, { max: 1, onnotice: () => {} });
    const [next] = await r`insert into drizzle.__drizzle_migrations (hash) values ('x') returning id`;
    await r.end();
    expect(Number(next!.id)).toBe(ourMigrations.length + 1);
    // Replay never takes key material, and needs a separate reference database.
    expect(await runRestoreTool(["replay", "--dump", dump, "--into", target.url, "--reference", target.reference, "--key-dir", keyDir], io)).toBe(64);
    expect(await runRestoreTool(["replay", "--dump", dump, "--into", target.url], io)).toBe(64);
  });

  it("the wrong key cannot open a backup", async () => {
    const otherDir = path.join(work, "other-keys");
    fs.mkdirSync(otherDir, { mode: 0o700 });
    const kp = sodium.crypto_box_keypair();
    fs.writeFileSync(path.join(otherDir, "escrow-public-key"), Buffer.from(kp.publicKey).toString("base64"));
    fs.writeFileSync(path.join(otherDir, "escrow-secret-key"), Buffer.from(kp.privateKey).toString("base64"));
    const header = JSON.parse(fs.readFileSync(`${roundTripDump}.manifest.json`, "utf8")) as { slug: string; backupId: string };
    const out = path.join(work, "wrong-key.sql.gz");
    await expect(runRestoreTool(["decrypt", "--in", roundTripFile, "--key-dir", otherDir, "--out", out, "--expect-slug", header.slug, "--expect-backup-id", header.backupId], silent)).rejects.toThrow(/sealed to backup key/);
    expect(fs.existsSync(out) || fs.existsSync(`${out}.partial`)).toBe(false);
  });

  it("refuses to replay over a database that looks like a live box", async () => {
    const dump = await freshDump();
    const errs: string[] = [];
    const before = await snapshot(boxUrl);
    const target = await sandboxDatabase();
    const code = await runRestoreTool(["replay", "--dump", dump, "--into", boxUrl, "--reference", target.reference], { out: () => {}, err: (l) => errs.push(l) });
    expect(code).toBe(3);
    expect(errs.join(" ")).toMatch(/looks like a live box/);
    expect(await snapshot(boxUrl)).toEqual(before);
  });

  it("refuses every over-powered sandbox role", async () => {
    const dump = await freshDump();
    for (const [opts, why] of [
      [{ superuser: true }, /super/],
      [{ createrole: true }, /createrole/],
      [{ grantRole: "pg_read_server_files" }, /read_files/],
      [{ grantRole: "pg_write_server_files" }, /write_files/],
      [{ grantRole: "pg_execute_server_program" }, /exec_program/],
    ] as const) {
      const t = await sandboxDatabase(opts);
      await expect(runRestoreTool(["replay", "--dump", dump, "--into", t.url, "--reference", t.reference], silent), JSON.stringify(opts)).rejects.toThrow(why);
      const c = postgres(t.url, { max: 1, onnotice: () => {} });
      const [n] = await c`select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace`;
      await c.end();
      expect(n!.n).toBe(0); // nothing ran
    }
  });

  it("a dump that parses but adds objects our migrations do not create fails the schema check", async () => {
    const dump = await freshDump();
    const cases: Array<[string, (sql: string) => string, RegExp]> = [
      ["an extra table", beforeCommit('CREATE TABLE "public"."backdoor" ("a" text);'), /relation: r:public\.backdoor/],
      ["an extra index", beforeCommit('CREATE INDEX "sneaky_idx" ON "public"."issues" USING btree ("title");'), /index: CREATE INDEX sneaky_idx/],
      ["an extra unique constraint", beforeCommit('ALTER TABLE "public"."companies" ADD CONSTRAINT "companies_name_uq" UNIQUE ("name");'), /constraint: public\.companies:u/],
      ["a changed column default", (sql) => sql.replace(/CREATE TABLE "public"\."companies" \(/, 'CREATE TABLE "public"."companies" (\n  "extra" text DEFAULT \'x\',\n'), /column: public\.companies\.extra|default: public\.companies\.extra/],
    ];
    for (const [name, edit, why] of cases) {
      expect(edit(zlib.gunzipSync(fs.readFileSync(dump)).toString("utf8")), name).not.toBe(zlib.gunzipSync(fs.readFileSync(dump)).toString("utf8"));
      const t = await sandboxDatabase();
      const errs: string[] = [];
      const code = await runRestoreTool(["replay", "--dump", tamper(dump, edit), "--into", t.url, "--reference", t.reference, "--migrations-dir", MIGRATIONS_DIR], { out: () => {}, err: (l) => errs.push(l) });
      expect(code, name).toBe(1);
      expect(errs.join("\n"), name).toMatch(why);
    }
  });

  // AgentDash (GH #907 review): a COPY row the server refuses used to hang the
  // replay forever (postgres.js reported it nowhere the stream could see).
  it("a COPY block the server refuses fails the replay promptly instead of hanging", async () => {
    const dump = await freshDump();
    const broken = tamper(dump, (sql) => sql.replace(/(COPY "drizzle"\."__drizzle_migrations" \([^)]*\) FROM stdin;\n)/, "$1not-a-number\tx\t1\n"));
    expect(broken).not.toBe(dump);
    const t = await sandboxDatabase();
    const outcome = await Promise.race([
      replayDump(broken, t.url).then(() => "resolved", (err: unknown) => err),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 20_000).unref()),
    ]);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/invalid input syntax/);
  });

  it("the applied migrations come from the restored table and must be ours", async () => {
    const dump = await freshDump();
    // The box claims a migration that is not in this repository: refused, whatever its header says.
    const forged = tamper(dump, (sql) => sql.replace(/(COPY "drizzle"\."__drizzle_migrations" \([^)]*\) FROM stdin;\n)/, `$1999999\t${"f".repeat(64)}\t1\n`));
    expect(forged).not.toBe(dump);
    const t = await sandboxDatabase();
    const errs: string[] = [];
    expect(await runRestoreTool(["replay", "--dump", forged, "--into", t.url, "--reference", t.reference, "--migrations-dir", MIGRATIONS_DIR], { out: () => {}, err: (l) => errs.push(l) })).toBe(1);
    expect(errs.join("\n")).toMatch(/not in this repository/);
  });

  it("the applied migrations must be an unbroken prefix of the journal, not any subset", async () => {
    const dump = await freshDump();
    // Swapping the hashes of the first two recorded migrations keeps every hash known
    // and unique — the old check accepted that as "applied"; the prefix rule refuses it.
    const reordered = tamper(dump, (sql) =>
      sql.replace(
        /(COPY "drizzle"\."__drizzle_migrations" \([^)]*\) FROM stdin;\n1\t)([0-9a-f]{64})(\t[^\n]*\n2\t)([0-9a-f]{64})(\t)/,
        (_m, a, h0, b, h1, c) => `${a}${h1}${b}${h0}${c}`,
      ),
    );
    expect(reordered).not.toBe(dump);
    const t = await sandboxDatabase();
    const errs: string[] = [];
    expect(await runRestoreTool(["replay", "--dump", reordered, "--into", t.url, "--reference", t.reference, "--migrations-dir", MIGRATIONS_DIR], { out: () => {}, err: (l) => errs.push(l) })).toBe(1);
    expect(errs.join("\n")).toMatch(/unbroken prefix/);
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
      // Bypasses of the old regex guard: a quote in a comment hiding a second statement, a quoted function name, a comment before "(".
      "INSERT INTO \"public\".\"t\" (\"a\") VALUES ('x') -- '\n; SELECT pg_read_file('/etc/passwd'); -- '",
      'CREATE TABLE "public"."t2" ("a" text DEFAULT "pg_read_file"(\'/etc/passwd\'));',
      "CREATE TABLE \"public\".\"t3\" (\"a\" text DEFAULT pg_read_file/**/('/etc/passwd'));",
      'CREATE TABLE "public"."t4" AS SELECT 1 AS a;',
      'INSERT INTO "public"."t" ("a") SELECT current_setting(\'data_directory\');',
      'ALTER TABLE "public"."t" ADD CONSTRAINT "c" UNIQUE ("a"), OWNER TO postgres;',
      "COMMIT;",
    ].join(`\n${STATEMENT_BREAKPOINT}\n`);
    const plain = path.join(work, "hostile.sql.gz");
    fs.writeFileSync(plain, zlib.gzipSync(hostileSql));
    const sealed = path.join(work, "hostile.adbk");
    const backupId = randomUUID();
    const enc = await createEncryptStream(backupKeys.publicKey, { backupId, boxId: randomUUID(), slug: "evil\u001b[2J", createdAt: new Date().toISOString(), format: "paperclip-sql-gz-v1", release: null, counts: { migrations: 1 } });
    await pipeline(fs.createReadStream(plain), enc, fs.createWriteStream(sealed));

    // inspect prints box-written text without control characters.
    const shown: string[] = [];
    expect(await runRestoreTool(["inspect", "--in", sealed], { out: (l) => shown.push(l), err: () => {} })).toBe(0);
    expect(shown.join("")).not.toContain("\u001b");

    const errs: string[] = [];
    const out = path.join(work, "hostile-out.sql.gz");
    expect(await runRestoreTool(["decrypt", "--in", sealed, "--key-dir", keyDir, "--out", out, "--expect-slug", "evil\u001b[2J", "--expect-backup-id", backupId], { out: () => {}, err: (l) => errs.push(l) })).toBe(4);
    expect(fs.existsSync(out) || fs.existsSync(`${out}.partial`)).toBe(false);
    const msg = errs.join(" ");
    for (const why of [/COPY|is_program|filename|field/, /does not parse/, /CreateEventTrigStmt/, /AlterSystemStmt/, /extension plpython3u/, /more than one statement/, /pg_read_file\(\) is not allowed/, /CreateTableAsStmt/, /only INSERT … VALUES|field/]) {
      expect(msg).toMatch(why);
    }

    const target = await sandboxDatabase();
    await expect(runRestoreTool(["replay", "--dump", plain, "--into", target.url, "--reference", target.reference], silent)).rejects.toThrow(/safety check/);
    const t = postgres(target.url, { max: 1, onnotice: () => {} });
    const [exists] = await t`select to_regclass('public.t') is not null as present`;
    await t.end();
    expect(exists!.present).toBe(false);
    expect(fs.existsSync(pwned)).toBe(false);
  });

  it("replay runs one statement per protocol message", async () => {
    const target = await sandboxDatabase();
    const c = postgres(target.url, { max: 1, onnotice: () => {} });
    try {
      await expect(c.unsafe("select 1; create table smuggled (a int)", [], EXTENDED_PROTOCOL)).rejects.toThrow(/multiple commands/);
      const [n] = await c`select to_regclass('public.smuggled') is not null as present`;
      expect(n!.present).toBe(false);
    } finally {
      await c.end();
    }
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
