// GH #733: the off-box backup building blocks that need no database:
// SigV4 (against AWS's published example), the encrypted envelope (round
// trip, wrong key, tampering, truncation), retention, config, the admin CLI.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";
import { runAdmin } from "../admin/run.js";
import { loadBackupConfig } from "../backups/config.js";
import { createDecryptStream, createEncryptStream, ENVELOPE_MAGIC, FRAME_PLAINTEXT_BYTES, type BackupEnvelopeMeta } from "../backups/envelope.js";
import { EMPTY_SHA256, S3Store, signV4, uriEncode } from "../backups/s3.js";
import { isoWeek, selectPrunable } from "../backups/service.js";
import { DumpTooLarge, extensionSchemaSafe, MAX_LINE_BYTES, MAX_STATEMENT_LINES, parseCopyFromStdin, scanDump, statements } from "../backups/sql-restore.js";
import { checkStatement, deferredStatement, initDumpGuard, MAX_STATEMENT_BYTES, STATEMENT_BREAKPOINT } from "../backups/dump-guard.js";
import { ConfigError } from "../config.js";
import { escrowKeyId } from "../railway/secrets.js";
import { Secret } from "../secret.js";

let keys: { publicKey: Uint8Array; privateKey: Uint8Array };
let other: { publicKey: Uint8Array; privateKey: Uint8Array };
beforeAll(async () => {
  await sodium.ready;
  keys = sodium.crypto_box_keypair();
  other = sodium.crypto_box_keypair();
});

const META: BackupEnvelopeMeta = {
  backupId: "00000000-0000-4000-8000-000000000001",
  boxId: "00000000-0000-4000-8000-000000000002",
  slug: "acme",
  createdAt: "2026-10-01T08:00:00.000Z",
  format: "paperclip-sql-gz-v1",
  release: "v2026.929.0",
  counts: { users: 2, migrations: 140 },
};

async function collect(src: Buffer, ...transforms: NodeJS.ReadWriteStream[]): Promise<Buffer> {
  const out: Buffer[] = [];
  await pipeline(
    Readable.from(chunks(src)),
    ...(transforms as unknown as [NodeJS.ReadWriteStream]),
    new Writable({
      write(c: Buffer, _e, cb) {
        out.push(c);
        cb();
      },
    }),
  );
  return Buffer.concat(out);
}

/** Uneven chunks, so frame boundaries never line up with writes. */
function* chunks(b: Buffer): Generator<Buffer> {
  let i = 0;
  let n = 1;
  while (i < b.length) {
    yield b.subarray(i, i + n);
    i += n;
    n = (n * 7 + 13) % 50_000 || 1;
  }
}

async function seal(plain: Buffer, meta: BackupEnvelopeMeta = META): Promise<Buffer> {
  return await collect(plain, await createEncryptStream(keys.publicKey, meta));
}

describe("SigV4", () => {
  it("matches AWS's published S3 GET example", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html (GET Object example)
    const auth = signV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9", "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": "20130524T000000Z" },
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
    });
    expect(auth).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("builds path-style and virtual-hosted URLs and encodes keys", () => {
    const base = { bucket: "agentdash-backups", region: "auto", accessKeyId: "x", secretAccessKey: new Secret("y"), prefix: "boxes" };
    expect(new S3Store({ ...base, endpoint: "https://acct.r2.cloudflarestorage.com" }).url("acme/a b+c.adbk").toString()).toBe(
      "https://acct.r2.cloudflarestorage.com/agentdash-backups/boxes/acme/a%20b%2Bc.adbk",
    );
    expect(new S3Store({ ...base, endpoint: "https://s3.us-west-2.amazonaws.com", virtualHosted: true }).url("acme/x").host).toBe(
      "agentdash-backups.s3.us-west-2.amazonaws.com",
    );
    expect(uriEncode("a/b~c d", true)).toBe("a/b~c%20d");
  });

  it("never shows the secret key", () => {
    const store = new S3Store({ endpoint: "https://e.example", bucket: "bkt", region: "auto", accessKeyId: "AKID", secretAccessKey: new Secret("very-secret"), prefix: "p" });
    expect(store.describe()).toBe("e.example/bkt/p");
    expect(JSON.stringify(store)).not.toContain("very-secret");
  });
});

describe("envelope", () => {
  it("round-trips across many frames and hides the plaintext", async () => {
    const plain = Buffer.concat([Buffer.from("PLAINTEXT-MARKER "), Buffer.alloc(FRAME_PLAINTEXT_BYTES * 3 + 123, 7), Buffer.from(" END")]);
    const sealed = await seal(plain);
    expect(sealed.subarray(0, 8).equals(ENVELOPE_MAGIC)).toBe(true);
    expect(sealed.includes(Buffer.from("PLAINTEXT-MARKER"))).toBe(false);
    let seen: unknown = null;
    const opened = await collect(sealed, await createDecryptStream(keys.publicKey, keys.privateKey, { onHeader: (h) => (seen = h) }));
    expect(opened.equals(plain)).toBe(true);
    expect(seen).toMatchObject({ slug: "acme", sealedTo: escrowKeyId(keys.publicKey), counts: { users: 2 } });
  });

  it("round-trips an empty plaintext", async () => {
    const sealed = await seal(Buffer.alloc(0));
    expect((await collect(sealed, await createDecryptStream(keys.publicKey, keys.privateKey))).length).toBe(0);
  });

  it("refuses the wrong key", async () => {
    const sealed = await seal(Buffer.from("hello"));
    await expect(collect(sealed, await createDecryptStream(other.publicKey, other.privateKey))).rejects.toThrow(/sealed to backup key/);
  });

  it("refuses any modified byte, a swapped header, truncation and trailing data", async () => {
    const plain = Buffer.alloc(FRAME_PLAINTEXT_BYTES * 2 + 5, 1);
    const sealed = await seal(plain);
    const open = async (b: Buffer) => collect(b, await createDecryptStream(keys.publicKey, keys.privateKey));
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 20]! ^= 1;
    await expect(open(flipped)).rejects.toThrow(/authentication/);
    // Rewrite the header's slug (same length): the frames no longer authenticate.
    const swapped = Buffer.from(sealed.toString("latin1").replace('"slug":"acme"', '"slug":"evil"'), "latin1");
    await expect(open(swapped)).rejects.toThrow(/authentication/);
    // Cut at a frame boundary: the final frame is missing.
    await expect(open(sealed.subarray(0, sealed.length - (FRAME_PLAINTEXT_BYTES / 2)))).rejects.toThrow();
    await expect(open(Buffer.concat([sealed, Buffer.from([0, 0, 0, 20, 1, 2, 3])]))).rejects.toThrow(/after the final frame/);
  });

  it("refuses something that is not an envelope", async () => {
    await expect(collect(Buffer.from("not a backup at all"), await createDecryptStream(keys.publicKey, keys.privateKey))).rejects.toThrow(/magic/);
  });
});

describe("retention", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 8, 1) + n * 86_400_000);
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `b${i}`, backupDay: day(i).toISOString().slice(0, 10), finishedAt: new Date(day(i).getTime() + 8 * 3_600_000) }));

  it("keeps 7 daily plus 4 weekly", () => {
    const all = rows(40); // 2026-09-01 .. 2026-10-10
    const prune = new Set(selectPrunable(all, 7, 4));
    const kept = all.filter((r) => !prune.has(r.id)).map((r) => r.backupDay);
    // The newest 7 days, plus the newest backup of the 4 newest ISO weeks (some overlap with the dailies).
    expect(kept.slice(-7)).toEqual(all.slice(-7).map((r) => r.backupDay));
    const weeks = new Set(kept.map(isoWeek));
    expect(weeks.size).toBeGreaterThanOrEqual(4);
    expect(kept.length).toBeLessThanOrEqual(11);
    expect(kept.length).toBeGreaterThan(7);
    // Nothing older than the 4th newest week survives.
    const oldestKept = kept[0]!;
    expect(oldestKept >= "2026-09-14").toBe(true);
  });

  it("keeps one per day when there are several, and always the newest", () => {
    const r = [
      { id: "a", backupDay: "2026-10-01", finishedAt: new Date("2026-10-01T08:00:00Z") },
      { id: "b", backupDay: "2026-10-01", finishedAt: new Date("2026-10-01T15:00:00Z") },
    ];
    expect(selectPrunable(r, 7, 0)).toEqual(["a"]);
    expect(selectPrunable(r.slice(0, 1), 1, 0)).toEqual([]);
  });

  it("computes ISO weeks", () => {
    expect(isoWeek("2026-10-01")).toBe("2026-W40");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
    expect(isoWeek("2026-01-01")).toBe("2026-W01");
  });
});

describe("restore parser", () => {
  it("splits a COPY block after its comment", () => {
    expect(parseCopyFromStdin('-- Data for: public.t (2 rows)\nCOPY "public"."t" ("a") FROM stdin;\n1\n2\n\\.')).toEqual({ command: 'COPY "public"."t" ("a") FROM stdin', payload: "1\n2\n" });
    expect(parseCopyFromStdin("CREATE TABLE t (a int);")).toBeNull();
  });
});

describe("dump splitter (bounded, streaming)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-split-"));
  const write = (name: string, text: string | Buffer) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, text);
    return f;
  };
  const BP = STATEMENT_BREAKPOINT;

  it("yields one piece per chunk and streams a COPY payload line by line", async () => {
    const f = write("roundtrip.sql", ["BEGIN;", BP, '-- Data for: public.t (3 rows)', 'COPY "public"."t" ("a") FROM stdin;', "1", "2", "3", "\\.", BP, "COMMIT;", BP].join("\n"));
    const pieces = [];
    for await (const p of statements(f)) {
      if (p.kind === "copy") {
        const rows: string[] = [];
        for await (const line of p.payload) rows.push(line);
        pieces.push({ ...p, payload: rows });
      } else pieces.push(p);
    }
    expect(pieces).toEqual([
      { kind: "sql", text: "BEGIN;" },
      { kind: "copy", text: '-- Data for: public.t (3 rows)\nCOPY "public"."t" ("a") FROM stdin;', command: 'COPY "public"."t" ("a") FROM stdin', payload: ["1", "2", "3"] },
      { kind: "sql", text: "COMMIT;" },
    ]);
  });

  it("refuses a statement with too many lines or too many bytes during a scan", async () => {
    const long = write("long.sql", ["BEGIN;", BP, ...Array.from({ length: MAX_STATEMENT_LINES + 1 }, () => "-- x"), "COMMIT;", BP].join("\n"));
    expect((await scanDump(long)).refused.map((r) => r.reason)).toEqual([expect.stringContaining(`${MAX_STATEMENT_LINES} lines`)]);
    const big = write("big.sql", ["BEGIN;", BP, `INSERT INTO "public"."t" ("a") VALUES ('${"x".repeat(MAX_STATEMENT_BYTES + 1)}');`, BP].join("\n"));
    expect((await scanDump(big)).refused.map((r) => r.reason)).toEqual([expect.stringContaining(`${MAX_STATEMENT_BYTES} bytes`)]);
  });

  it("bounds a single physical line, even inside COPY data, plain or gzipped", async () => {
    const head = Buffer.from(`BEGIN;\n${BP}\nCOPY "public"."t" ("a") FROM stdin;\n`, "utf8");
    const tail = Buffer.from(`\n\\.\n${BP}\nCOMMIT;\n${BP}\n`, "utf8");
    const f = write("wide-line.sql", Buffer.concat([head, Buffer.alloc(MAX_LINE_BYTES + 1, "x"), tail]));
    expect((await scanDump(f)).refused.map((r) => r.reason)).toEqual([expect.stringContaining(`${MAX_LINE_BYTES} bytes`)]);
    const gz = write("wide-line.sql.gz", zlib.gzipSync(fs.readFileSync(f)));
    expect((await scanDump(gz)).refused.map((r) => r.reason)).toEqual([expect.stringContaining(`${MAX_LINE_BYTES} bytes`)]);
  });

  it("throws DumpTooLarge when iterating past a cap", async () => {
    const f = write("toobig.sql", ["BEGIN;", BP, `INSERT INTO "public"."t" ("a") VALUES ('${"x".repeat(MAX_STATEMENT_BYTES + 1)}');`, BP].join("\n"));
    const drain = async () => {
      for await (const p of statements(f)) if (p.kind === "copy") for await (const _ of p.payload) void _;
    };
    await expect(drain()).rejects.toThrow(DumpTooLarge);
  });
});

describe("extension WITH SCHEMA replay pin (CVE-2022-2625 + CVE-2023-39417)", () => {
  it("allows exactly the patched minors — 11.21 / 12.16 / 13.12 / 14.9 / 15.4 — and 16+", () => {
    const cases: Array<[number, boolean]> = [
      [90624, false], // any 9.x: never fixed
      [100022, false], // 10.22 has CVE-2022-2625 but the 10.x line is EOL, unfixed for CVE-2023-39417
      [110020, false],
      [110021, true], // 11.21
      [120015, false],
      [120016, true], // 12.16
      [130011, false],
      [130012, true], // 13.12
      [140008, false],
      [140009, true], // 14.9
      [150003, false],
      [150004, true], // 15.4
      [160000, true], // any 16+
      [170003, true],
    ];
    for (const [v, ok] of cases) expect(extensionSchemaSafe(v), `server_version_num ${v}`).toBe(ok);
  });
});

describe("backup config", () => {
  const pub = () => Buffer.from(keys.publicKey).toString("base64");
  const full = () => ({
    CLOUD_BACKUP_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    CLOUD_BACKUP_S3_BUCKET: "agentdash-backups",
    CLOUD_BACKUP_S3_ACCESS_KEY_ID: "AKID",
    CLOUD_BACKUP_S3_SECRET_ACCESS_KEY: "s3cr3t",
    CLOUD_BACKUP_PUBLIC_KEY: pub(),
  });

  it("is off when nothing is set, and refuses a partial set", () => {
    expect(loadBackupConfig({})).toBeNull();
    expect(() => loadBackupConfig({ CLOUD_BACKUP_S3_BUCKET: "b" })).toThrow(ConfigError);
    expect(() => loadBackupConfig({ ...full(), CLOUD_BACKUP_PUBLIC_KEY: "" })).toThrow(/public key|PUBLIC_KEY/);
    expect(() => loadBackupConfig({ ...full(), CLOUD_BACKUP_S3_ENDPOINT: "http://s3.example.com" })).toThrow(/https/);
  });

  it("reads defaults and falls back to the escrow key", () => {
    const c = loadBackupConfig(full())!;
    expect(c).toMatchObject({ region: "auto", prefix: "boxes", hourUtc: 8, retainDaily: 7, retainWeekly: 4, usingEscrowKey: false, publicKeyId: escrowKeyId(keys.publicKey) });
    expect(JSON.stringify(c)).not.toContain("s3cr3t");
    const e = loadBackupConfig({ ...full(), CLOUD_BACKUP_PUBLIC_KEY: undefined, CLOUD_ESCROW_PUBLIC_KEY: pub() })!;
    expect(e.usingEscrowKey).toBe(true);
    expect(() => loadBackupConfig({ ...full(), CLOUD_BACKUP_HOUR_UTC: "24" })).toThrow(ConfigError);
  });
});

describe("admin CLI: backups", () => {
  const env = { CLOUD_ADMIN_TOKEN: "t".repeat(40) };
  const io = (responses: Record<string, { status: number; body: unknown; headers?: Record<string, string> }>) => {
    const calls: string[] = [];
    const out: string[] = [];
    const files = new Map<string, Buffer[]>();
    const discarded: string[] = [];
    return {
      calls,
      out,
      files,
      discarded,
      io: {
        out: (l: string) => out.push(l),
        err: (l: string) => out.push(`ERR ${l}`),
        openFile: async (p: string) => {
          files.set(p, []);
          return {
            write: async (c: Uint8Array) => void files.get(p)!.push(Buffer.from(c)),
            close: async () => {},
            discard: async () => {
              files.delete(p);
              discarded.push(p);
            },
          };
        },
        fetch: (async (url: string, init?: RequestInit) => {
          const path = new URL(url).pathname;
          calls.push(`${init?.method ?? "GET"} ${path}`);
          const r = responses[path] ?? { status: 404, body: { error: "nope" } };
          const body = r.body instanceof Uint8Array ? r.body : JSON.stringify(r.body);
          return new Response(body as BodyInit, { status: r.status, headers: r.headers });
        }) as typeof fetch,
      },
    };
  };

  it("status, list and run call the operator routes", async () => {
    const t = io({ "/internal/backups": { status: 200, body: { boxes: [] } }, "/internal/boxes/acme/backups": { status: 202, body: { backupId: "x" } } });
    expect(await runAdmin(["backups", "status"], env, t.io)).toBe(0);
    expect(await runAdmin(["backups", "list", "acme"], env, t.io)).toBe(0);
    expect(await runAdmin(["backups", "run", "acme"], env, t.io)).toBe(0);
    expect(t.calls).toEqual(["GET /internal/backups", "GET /internal/boxes/acme/backups", "POST /internal/boxes/acme/backups"]);
  });

  it("download streams to disk, checks the SHA-256, and refuses an object that is another backup", async () => {
    const id = "00000000-0000-4000-8000-000000000009";
    const sealedFor = async (backupId: string) => new Uint8Array(await seal(Buffer.alloc(FRAME_PLAINTEXT_BYTES * 2, 3), { ...META, backupId }));
    const bytes = await sealedFor(id);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const good = io({ [`/internal/backups/${id}/download`]: { status: 200, body: bytes, headers: { "x-agentdash-backup-sha256": sha } } });
    expect(await runAdmin(["backups", "download", id, "/tmp/x.adbk"], env, good.io)).toBe(0);
    expect(Buffer.concat(good.files.get("/tmp/x.adbk")!).equals(Buffer.from(bytes))).toBe(true);
    expect(good.discarded).toEqual([]);

    const bad = io({ [`/internal/backups/${id}/download`]: { status: 200, body: bytes, headers: { "x-agentdash-backup-sha256": "0".repeat(64) } } });
    expect(await runAdmin(["backups", "download", id, "/tmp/y.adbk"], env, bad.io)).toBe(1);
    expect(bad.discarded).toEqual(["/tmp/y.adbk"]);

    // A swapped object: a valid backup, but of another id.
    const other = await sealedFor("00000000-0000-4000-8000-00000000000a");
    const swapped = io({ [`/internal/backups/${id}/download`]: { status: 200, body: other, headers: { "x-agentdash-backup-sha256": createHash("sha256").update(other).digest("hex") } } });
    expect(await runAdmin(["backups", "download", id, "/tmp/z.adbk"], env, swapped.io)).toBe(1);
    expect(swapped.discarded).toEqual(["/tmp/z.adbk"]);
    expect(swapped.out.join(" ")).toMatch(/is backup .*0000000a, not/);

    const junk = io({ [`/internal/backups/${id}/download`]: { status: 200, body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) } });
    expect(await runAdmin(["backups", "download", id, "/tmp/j.adbk"], env, junk.io)).toBe(1);
    expect(junk.discarded).toEqual(["/tmp/j.adbk"]);
  });
});

describe("dump guard (libpg_query AST allowlist)", () => {
  beforeAll(async () => {
    await initDumpGuard();
  });
  const ok = [
    "BEGIN;",
    "SET LOCAL session_replication_role = replica;",
    "SET LOCAL client_min_messages = warning;",
    'CREATE SCHEMA IF NOT EXISTS "drizzle";',
    'CREATE TYPE "public"."issue_state" AS ENUM (\'open\', \'done\');',
    'CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public";',
    'DROP TABLE IF EXISTS "public"."issues" CASCADE;',
    'DROP SEQUENCE IF EXISTS "public"."s" CASCADE;',
    'CREATE SEQUENCE "public"."s" AS bigint INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START 1 NO CYCLE;',
    'ALTER SEQUENCE "public"."s" OWNED BY "public"."t"."id";',
    'CREATE TABLE "public"."issues" (\n  "id" bigint NOT NULL DEFAULT nextval(\'issues_id_seq\'::regclass),\n  "language" text,\n  "uid" uuid DEFAULT gen_random_uuid() NOT NULL,\n  "at" timestamp with time zone DEFAULT now(),\n  "meta" jsonb DEFAULT \'{}\'::jsonb,\n  PRIMARY KEY ("id")\n);',
    "CREATE INDEX issues_title_idx ON public.issues USING gin (title gin_trgm_ops);",
    "CREATE UNIQUE INDEX u ON public.issues USING btree (lower(email)) WHERE ((status <> ALL (ARRAY['a'::text, 'b'::text])) AND (deleted_at IS NULL));",
    'ALTER TABLE "public"."a" ADD CONSTRAINT "a_fk" FOREIGN KEY ("b") REFERENCES "public"."b" ("id") ON DELETE CASCADE;',
    'ALTER TABLE "public"."a" ADD CONSTRAINT "a_u" UNIQUE NULLS NOT DISTINCT ("b", "c");',
    "-- Data for: public.t (1 rows)\nCOPY \"public\".\"t\" (\"a\") FROM stdin;\nPROGRAM; DROP TABLE x; \\! rm -rf /\n\\.",
    "INSERT INTO \"public\".\"t\" (\"a\", \"b\") VALUES ($paperclip$COPY x FROM PROGRAM 'rm'; DROP TABLE t; \\! ls$paperclip$, NULL);",
    "SELECT setval('\"public\".\"issues_id_seq\"', 300, true);",
    // AgentDash (GH #944): CREATE DOMAIN and CREATE TYPE … AS (…) execute in
    // replay — CREATE TABLE statements name them. Domain CHECK constraints
    // ride inline (ALTER DOMAIN cannot add one once an array of the domain
    // backs a column), and so do generated columns with allowlist-clean
    // expressions.
    'CREATE DOMAIN "public"."short_code" AS character varying(8) NOT NULL;',
    'CREATE DOMAIN "public"."d" AS text DEFAULT \'x\'::text CONSTRAINT "d_check" CHECK (((VALUE)::text <> \'\'::text));',
    'CREATE DOMAIN "public"."collated" AS text COLLATE "en_US";',
    'CREATE TYPE "public"."pair" AS ("a" integer, "b" text);',
    'CREATE TYPE "public"."weighted" AS ("sub" public.pair, "w" numeric(5,2));',
    'CREATE TABLE "public"."t" ("a" int, "g" int GENERATED ALWAYS AS ((a * 2)) STORED);',
    'CREATE TABLE "public"."t" ("a" int, "g" int GENERATED ALWAYS AS ((a * 2)) VIRTUAL);',
    // ASCII whitespace Postgres itself accepts — tabs, form feed, CR — is fine.
    "  -- a comment\r\n\t\fBEGIN;",
    "COMMIT;",
  ];
  // Each one a bypass found in review of the old regex guard, or a statement kind it let through by prefix.
  const bad: Array<[string, RegExp]> = [
    ["INSERT INTO \"public\".\"t\" (\"a\") VALUES ('x') -- '\n; SELECT pg_read_file('/etc/passwd'); -- '", /more than one statement/],
    ["INSERT INTO \"public\".\"t\" (\"a\") VALUES ('x') /* ' */; DROP TABLE \"public\".\"t\"; /* ' */", /more than one statement/],
    ['CREATE TABLE "public"."t" ("a" text DEFAULT "pg_read_file"(\'/etc/passwd\'));', /function pg_read_file\(\) is not allowed/],
    ['CREATE TABLE "public"."t" ("a" oid DEFAULT pg_catalog."lo_import"(\'/etc/passwd\'));', /function lo_import\(\) is not allowed/],
    ["CREATE TABLE \"public\".\"t\" (\"a\" text DEFAULT pg_read_file/**/('/etc/passwd'));", /function pg_read_file\(\) is not allowed/],
    ['CREATE TABLE "public"."t" ("a" text DEFAULT public.helper());', /schema-qualified function/],
    ['CREATE TABLE "public"."t" AS SELECT pg_read_file(\'/etc/passwd\') AS a;', /CreateTableAsStmt/],
    ['INSERT INTO "public"."t" ("a") SELECT current_setting(\'data_directory\');', /field targetList|only INSERT … VALUES/],
    ["INSERT INTO \"public\".\"t\" (\"a\") VALUES (pg_read_file('/etc/passwd'));", /not a constant/],
    ['INSERT INTO "public"."t" ("a") VALUES (\'x\') RETURNING *;', /field returning/],
    ['INSERT INTO "public"."t" ("a") VALUES (\'x\') ON CONFLICT DO NOTHING;', /field onConflictClause/],
    ['ALTER TABLE "public"."t" ADD CONSTRAINT "c" UNIQUE ("a"), OWNER TO postgres;', /exactly one subcommand/],
    ['ALTER TABLE "public"."t" ADD CONSTRAINT "c" CHECK (pg_read_file(\'/x\') <> \'\');', /CONSTR_CHECK is not allowed/],
    ['ALTER TABLE "public"."t" ENABLE ROW LEVEL SECURITY;', /only ADD CONSTRAINT|subtype/],
    ["COPY \"public\".\"t\" (\"a\") FROM PROGRAM 'id';", /field is_program|does not parse|field filename/],
    ["COPY \"public\".\"t\" (\"a\") FROM '/etc/passwd';", /field filename/],
    ["COPY \"public\".\"t\" TO '/tmp/x';", /field filename|only COPY … FROM STDIN|is_from/],
    ["COPY (SELECT 1) TO STDOUT;", /field query|is_from|only COPY/],
    ["\\! touch /tmp/pwned", /does not parse/],
    ["CREATE EVENT TRIGGER e ON ddl_command_start EXECUTE FUNCTION f();", /CreateEventTrigStmt/],
    ["ALTER SYSTEM SET archive_command = 'x';", /AlterSystemStmt/],
    ["CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 1';", /CreateFunctionStmt/],
    ["CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW EXECUTE FUNCTION f();", /CreateTrigStmt/],
    ["CREATE RULE r AS ON INSERT TO t DO ALSO NOTIFY x;", /RuleStmt/],
    ["CREATE VIEW v AS SELECT pg_read_file('/etc/passwd');", /ViewStmt/],
    ["CREATE POLICY p ON t USING (true);", /CreatePolicyStmt/],
    ["DO $$ BEGIN PERFORM 1; END $$;", /DoStmt/],
    ["GRANT ALL ON t TO PUBLIC;", /GrantStmt/],
    ["SET ROLE postgres;", /VariableSetStmt|only SET LOCAL/],
    ["SET LOCAL search_path = evil;", /only SET LOCAL/],
    ["SET session_replication_role = replica;", /is_local|only SET LOCAL/],
    ["CREATE EXTENSION IF NOT EXISTS plpython3u;", /not on the allowlist/],
    ['CREATE EXTENSION IF NOT EXISTS "dblink";', /not on the allowlist/],
    ["CREATE EXTENSION pg_trgm;", /only IF NOT EXISTS/],
    ['CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA "public" VERSION \'1.6\';', /option new_version is not allowed/],
    // Unicode whitespace is NOT Postgres whitespace: a leading line that only
    // looks blank or commented to JavaScript's trim() must stay in the body
    // and fail the real parser, not be silently dropped.
    ["\u00A0BEGIN;", /does not parse/],
    ["\u00A0-- a comment only to JS trim\nBEGIN;", /does not parse/],
    ["-- real comment\n\u00A0\nBEGIN;", /does not parse/],
    ["COPY\u00A0\"public\".\"t\" (\"a\") FROM stdin;\n1\n\\.", /does not parse/],
    ["COPY FROM stdin;", /does not parse/],
    ["SELECT setval('s', 1, true); SELECT pg_sleep(100);", /more than one statement/],
    ["SELECT pg_sleep(100);", /only SELECT setval/],
    ["SELECT setval('s', (SELECT 1), true);", /A_Const|SubLink/],
    ['CREATE TABLE "public"."t" ("a" text DEFAULT (SELECT 1));', /SubLink is not allowed/],
    ['CREATE TABLE "public"."t" ("a" int) INHERITS ("public"."u");', /field inhRelations/],
    ['CREATE TABLE "public"."t" ("a" int GENERATED ALWAYS AS (pg_backend_pid()) STORED);', /function pg_backend_pid\(\) is not allowed/],
    // AgentDash (GH #939, #944): a default, generation expression or domain
    // CHECK that calls anything but an allowlisted builtin is refused outright
    // when written inline — backup-lib never emits those inline; it defers
    // them to ALTER statements that replay skips instead.
    ['CREATE TABLE "public"."t" ("a" int GENERATED ALWAYS AS (public.f()) STORED);', /schema-qualified function/],
    ['CREATE DOMAIN "public"."d" AS text DEFAULT public.f();', /schema-qualified function/],
    ['CREATE DOMAIN "public"."d" AS text CHECK (pg_read_file(\'/x\') <> \'\');', /function pg_read_file\(\) is not allowed/],
    ['CREATE TYPE "public"."p" AS (a int DEFAULT 1);', /does not parse|field constraints/],
    ['ALTER TABLE "public"."t" ADD COLUMN "g" bigint;', /subtype|only ADD CONSTRAINT/],
    ['ALTER TABLE "public"."t" ALTER COLUMN "c" DROP DEFAULT;', /field name|only ADD CONSTRAINT/],
    ['CREATE INDEX i ON public.t USING btree ((pg_read_file(\'/x\')));', /function pg_read_file\(\) is not allowed/],
    ['DROP TABLE "public"."t";', /only IF EXISTS/],
    ['DROP FUNCTION IF EXISTS f();', /only tables and sequences/],
    ['CREATE TEMP TABLE "t" ("a" int);', /relpersistence/],
  ];
  it("accepts every shape backup-lib writes, whatever the data says", () => {
    for (const s of ok) expect(checkStatement(s), s).toBeNull();
  });
  it("refuses each review bypass and every statement kind backup-lib never writes", () => {
    const wrong = bad.map(([s, why]) => [s, checkStatement(s), why] as const).filter(([, got, why]) => !got || !why.test(got));
    expect(wrong).toEqual([]);
  });
  it("caps statement size", () => {
    expect(checkStatement(`INSERT INTO "public"."t" ("a") VALUES ('${"x".repeat(MAX_STATEMENT_BYTES)}');`)).toMatch(/larger than/);
  });
  // AgentDash (GH #907): backup-lib now writes these; replay skips them (never runs them) and
  // schema-verify re-creates them from our migrations.
  it("marks the schema objects backup-lib writes as skipped, never as runnable", () => {
    // Third element, when false, means the skipped statement is fine on its
    // own (a marked deferred constraint/index) and checkStatement accepts it.
    const deferred: Array<[string, string, boolean?]> = [
      ["SET LOCAL check_function_bodies = false;", "SET LOCAL check_function_bodies"],
      ["-- Function: public.f\nCREATE OR REPLACE FUNCTION public.f()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$ BEGIN RETURN OLD; END; $function$\n;", "function"],
      ["CREATE TRIGGER t BEFORE UPDATE ON public.x FOR EACH ROW EXECUTE FUNCTION f();", "trigger"],
      ["CREATE OR REPLACE VIEW \"public\".\"v\" AS\n SELECT pg_read_file('/etc/passwd') AS a;", "view"],
      ["CREATE MATERIALIZED VIEW \"public\".\"m\" AS\n SELECT 1 AS a\nWITH DATA;", "materialized view"],
      ['ALTER TABLE "public"."t" ADD CONSTRAINT "c" CHECK ((a > 0));', "check constraint"],
      ['ALTER TABLE "public"."t" ADD CONSTRAINT "c" CHECK ((a > 0)) NOT VALID;', "check constraint"],
      ['ALTER TABLE "public"."t" DISABLE TRIGGER "trg";', "trigger state"],
      ['ALTER TABLE "public"."t" ENABLE REPLICA TRIGGER "trg";', "trigger state"],
      ['ALTER TABLE "public"."t" ENABLE ALWAYS TRIGGER "trg";', "trigger state"],
      // AgentDash (GH #939): the deferred shape of a column default that calls
      // a later function — expression-bearing, so replay never runs it.
      ['ALTER TABLE "public"."t" ALTER COLUMN "lazy" SET DEFAULT public.late_fn();', "column default"],
      ['ALTER TABLE "public"."t" ALTER COLUMN "lazy" SET DEFAULT now();', "column default"],
      // AgentDash (GH #944): the deferred shape of a generated column whose
      // expression needed a later object, and the domain alterations.
      ['ALTER TABLE "public"."t" ADD COLUMN "g" bigint GENERATED ALWAYS AS (public.f()) STORED;', "generated column"],
      ['ALTER TABLE "public"."t" ADD COLUMN "g" bigint GENERATED ALWAYS AS (a * 2) VIRTUAL;', "generated column"],
      ['ALTER DOMAIN "public"."d" SET DEFAULT public.late_fn();', "domain alteration"],
      ['ALTER DOMAIN "public"."d" ADD CONSTRAINT "d_check" CHECK ((VALUE <> \'\'));', "domain alteration"],
      // A constraint or index that only exists because a column was added
      // late carries the marker comment and is skipped whatever its shape —
      // note the shapes are fine on their own; it is the missing column that
      // makes them un-runnable, so checkStatement must not be the gate.
      ['-- Indexes of tables with late columns\n-- paperclip deferred schema object\nCREATE INDEX i ON public.t (g);', "deferred schema object", false],
      ['-- paperclip deferred schema object\nALTER TABLE "public"."t" ADD CONSTRAINT "t_pkey" PRIMARY KEY ("g");', "deferred schema object", false],
      ['-- paperclip deferred schema object\nALTER TABLE "public"."a" ADD CONSTRAINT "a_fk" FOREIGN KEY ("g") REFERENCES "public"."b" ("id");', "deferred schema object", false],
    ];
    for (const [s, what, runRefused = true] of deferred) {
      expect(deferredStatement(s), s).toBe(what);
      // Still refused by the run-path check, so nothing can execute one by mistake.
      if (runRefused) expect(checkStatement(s), s).not.toBeNull();
    }
    const never = [
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 1'; DROP TABLE x;",
      "SET check_function_bodies = false;",
      "SET LOCAL search_path = evil;",
      'ALTER TABLE "public"."t" ADD CONSTRAINT "c" UNIQUE ("a");',
      'ALTER TABLE "public"."t" ADD CONSTRAINT "c" PRIMARY KEY ("a");',
      'ALTER TABLE "public"."t" ALTER COLUMN "lazy" DROP DEFAULT;',
      'ALTER TABLE "public"."t" ADD COLUMN "g" bigint;',
      'ALTER TABLE "public"."t" ADD COLUMN "g" bigint DEFAULT 1;',
      "COPY \"public\".\"t\" (\"a\") FROM stdin;\nCREATE VIEW v AS SELECT 1;\n\\.",
      "CREATE TABLE \"public\".\"t\" AS SELECT 1;",
      "DO $$ BEGIN PERFORM 1; END $$;",
      "BEGIN;",
      // The marker is only a leading comment of the chunk — the same text
      // inside a row's string literal is data, not a skip signal.
      "INSERT INTO \"public\".\"t\" (\"a\") VALUES (E'one\n-- paperclip deferred schema object\ntwo');",
      "-- Data for: public.t (1 rows)\nINSERT INTO \"public\".\"t\" (\"a\") VALUES (E'one\n-- paperclip deferred schema object\ntwo');",
      // An ordinary schema object with no marker is never "deferred".
      'CREATE DOMAIN "public"."d" AS text CHECK (VALUE <> \'\');',
    ];
    for (const s of never) expect(deferredStatement(s), s).toBeNull();
  });
});
