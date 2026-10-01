// GH #733: the off-box backup building blocks that need no database:
// SigV4 (against AWS's published example), the encrypted envelope (round
// trip, wrong key, tampering, truncation), retention, config, the admin CLI.
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it } from "vitest";
import { runAdmin } from "../admin/run.js";
import { loadBackupConfig } from "../backups/config.js";
import { createDecryptStream, createEncryptStream, ENVELOPE_MAGIC, FRAME_PLAINTEXT_BYTES, type BackupEnvelopeMeta } from "../backups/envelope.js";
import { EMPTY_SHA256, S3Store, signV4, uriEncode } from "../backups/s3.js";
import { isoWeek, selectPrunable } from "../backups/service.js";
import { parseCopyFromStdin } from "../backups/sql-restore.js";
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

async function seal(plain: Buffer): Promise<Buffer> {
  return await collect(plain, await createEncryptStream(keys.publicKey, META));
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
    const files = new Map<string, Uint8Array>();
    return {
      calls,
      out,
      files,
      io: {
        out: (l: string) => out.push(l),
        err: (l: string) => out.push(`ERR ${l}`),
        writeFile: async (p: string, d: Uint8Array) => void files.set(p, d),
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

  it("download checks the SHA-256 before writing", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const id = "00000000-0000-4000-8000-000000000009";
    const good = io({ [`/internal/backups/${id}/download`]: { status: 200, body: bytes, headers: { "x-agentdash-backup-sha256": sha } } });
    expect(await runAdmin(["backups", "download", id, "/tmp/x.adbk"], env, good.io)).toBe(0);
    expect(good.files.get("/tmp/x.adbk")).toEqual(bytes);
    const bad = io({ [`/internal/backups/${id}/download`]: { status: 200, body: bytes, headers: { "x-agentdash-backup-sha256": "0".repeat(64) } } });
    expect(await runAdmin(["backups", "download", id, "/tmp/y.adbk"], env, bad.io)).toBe(1);
    expect(bad.files.size).toBe(0);
  });
});
