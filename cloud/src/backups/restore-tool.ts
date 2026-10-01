// AgentDash (GH #733): the OFFLINE restore tool for off-box backups. Runs on
// the operator's machine with the backup secret key, never in the control
// plane (which holds only the public key and cannot decrypt a backup).
//
//   inspect --in <file.adbk>
//       print the backup's plain header (box, slug, time, key id, counts); no key needed
//   restore --in <file.adbk> --key-dir <dir> [--into <postgres-url>] [--keep] [--health-url <url>]
//       decrypt and restore, then verify:
//         - without --into: into a THROWAWAY embedded Postgres in a temp
//           directory, removed afterwards (--keep leaves it running and prints its URL);
//         - with --into: into that database, which must hold no users and no
//           companies (an empty database or a never-claimed throwaway box):
//           it refuses anything that looks like a live box;
//       verification compares the restored core-table counts with the counts
//       the box reported at export time (the migration count must match);
//       --health-url then requires GET <url> to answer 200 with status "ok"
//       (a throwaway box pointed at the restored database).
//
// The decrypted dump exists only in a mode-700 temp directory and is deleted
// on exit. Get the file with `admin backups download <backup id> <file>`.
// Key directory: escrow-public-key and escrow-secret-key, as `escrow keygen` writes them.
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import postgres from "postgres";
import { parseEscrowPublicKey } from "../railway/secrets.js";
import { createDecryptStream, parseEnvelopeHeader, type BackupEnvelopeHeader } from "./envelope.js";
import { restoreSqlDump } from "./sql-restore.js";

export interface RestoreIo {
  out: (l: string) => void;
  err: (l: string) => void;
  fetch?: typeof fetch;
  /** Starts a throwaway Postgres; tests inject one. Default: embedded-postgres in a temp dir. */
  startThrowaway?: () => Promise<{ url: string; stop(): Promise<void> }>;
}

const COUNT_TABLES: ReadonlyArray<readonly [string, string]> = [
  ["companies", "public.companies"],
  ["users", 'public."user"'],
  ["agents", "public.agents"],
  ["issues", "public.issues"],
  ["memberships", "public.company_memberships"],
  ["migrations", "drizzle.__drizzle_migrations"],
];

export async function countCoreTables(url: string): Promise<Record<string, number | null>> {
  const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const out: Record<string, number | null> = {};
    for (const [name, table] of COUNT_TABLES) {
      const [r] = await sql.unsafe<Array<{ present: boolean }>>(`select to_regclass('${table.replace(/'/g, "''")}') is not null as present`);
      if (!r?.present) {
        out[name] = null;
        continue;
      }
      const [c] = await sql.unsafe<Array<{ n: number }>>(`select count(*)::int as n from ${table}`);
      out[name] = Number(c?.n ?? 0);
    }
    return out;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Refuse a target that looks like a live box: any user or company rows. Returns a reason, or null when safe. */
export async function liveTargetReason(url: string): Promise<string | null> {
  const counts = await countCoreTables(url);
  const users = counts.users ?? 0;
  const companies = counts.companies ?? 0;
  if (users > 0 || companies > 0) {
    return `the target database already holds ${users} user(s) and ${companies} compan(ies): it looks like a live box. Restore only into an empty database or a never-claimed throwaway box.`;
  }
  return null;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      if (!a || typeof a === "string") return reject(new Error("no free port"));
      s.close(() => resolve(a.port));
    });
  });
}

/** A throwaway embedded Postgres (embedded-postgres, a dev dependency: the tool runs from a repo checkout). */
export async function startEmbeddedThrowaway(): Promise<{ url: string; stop(): Promise<void> }> {
  type Pg = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
  const mod = (await import("embedded-postgres")) as unknown as { default: new (o: Record<string, unknown>) => Pg };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdash-restore-pg-"));
  const port = await freePort();
  const password = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  const pg = new mod.default({ databaseDir: dir, user: "restore", password, port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  const stop = async () => {
    await pg.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    await pg.initialise();
    await pg.start();
    const admin = postgres(`postgres://restore:${password}@127.0.0.1:${port}/postgres`, { max: 1, onnotice: () => {} });
    await admin.unsafe("create database restore_test");
    await admin.end();
  } catch (err) {
    await stop();
    throw err;
  }
  return { url: `postgres://restore:${password}@127.0.0.1:${port}/restore_test`, stop };
}

function readKeyDir(dir: string): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const publicKey = parseEscrowPublicKey(fs.readFileSync(path.join(dir, "escrow-public-key"), "utf8"));
  const secretKey = new Uint8Array(Buffer.from(fs.readFileSync(path.join(dir, "escrow-secret-key"), "utf8").trim(), "base64"));
  if (secretKey.length !== 32) throw new Error("escrow-secret-key is not a 32-byte key");
  return { publicKey, secretKey };
}

export function readEnvelopeHeaderFile(file: string): BackupEnvelopeHeader {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(8 + 4 + 64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const parsed = parseEnvelopeHeader(buf.subarray(0, n));
    if (!parsed) throw new Error("the file is too short to be a backup");
    return parsed.header;
  } finally {
    fs.closeSync(fd);
  }
}

/** Decrypt an envelope file to a gzipped dump file (mode 600). */
export async function decryptBackupFile(input: string, output: string, keys: { publicKey: Uint8Array; secretKey: Uint8Array }): Promise<BackupEnvelopeHeader> {
  let header: BackupEnvelopeHeader | null = null;
  const dec = await createDecryptStream(keys.publicKey, keys.secretKey, { onHeader: (h) => (header = h) });
  await pipeline(fs.createReadStream(input), dec, fs.createWriteStream(output, { mode: 0o600, flags: "wx" }));
  if (!header) throw new Error("no header");
  return header;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export const RESTORE_USAGE = `usage: backup-restore inspect --in <file.adbk>
       backup-restore restore --in <file.adbk> --key-dir <dir> [--into <postgres-url>] [--keep] [--health-url <url>]`;

export async function runRestoreTool(argv: string[], io: RestoreIo): Promise<number> {
  const [cmd, ...rest] = argv;
  const input = flag(rest, "--in");
  if ((cmd !== "inspect" && cmd !== "restore") || !input) return (io.err(RESTORE_USAGE), 64);
  if (cmd === "inspect") {
    const h = readEnvelopeHeaderFile(input);
    const { sealedDataKey: _omit, ...shown } = h;
    io.out(JSON.stringify(shown, null, 2));
    return 0;
  }
  const keyDir = flag(rest, "--key-dir");
  if (!keyDir) return (io.err(RESTORE_USAGE), 64);
  const into = flag(rest, "--into");
  const healthUrl = flag(rest, "--health-url");
  const keep = rest.includes("--keep");
  const keys = readKeyDir(keyDir);

  const work = await mkdtemp(path.join(os.tmpdir(), "agentdash-restore-"));
  fs.chmodSync(work, 0o700);
  let throwaway: { url: string; stop(): Promise<void> } | null = null;
  try {
    const dump = path.join(work, "dump.sql.gz");
    const t0 = Date.now();
    const header = await decryptBackupFile(input, dump, keys);
    io.out(`decrypted backup ${header.backupId} of ${header.slug} (${header.createdAt}, release ${header.release ?? "unknown"}) in ${Date.now() - t0} ms`);

    let target: string;
    if (into) {
      const reason = await liveTargetReason(into);
      if (reason) {
        io.err(`refusing to restore: ${reason}`);
        return 3;
      }
      target = into;
    } else {
      throwaway = await (io.startThrowaway ?? startEmbeddedThrowaway)();
      target = throwaway.url;
      io.out("restoring into a throwaway Postgres");
    }
    const t1 = Date.now();
    const stats = await restoreSqlDump(dump, target);
    io.out(`restored ${stats.statements} statement(s), ${stats.copyBlocks} COPY block(s) via ${stats.engine} in ${Date.now() - t1} ms`);

    const restored = await countCoreTables(target);
    const mismatches: string[] = [];
    for (const [name, expected] of Object.entries(header.counts ?? {})) {
      if (restored[name] !== expected) mismatches.push(`${name}: exported ${String(expected)}, restored ${String(restored[name])}`);
    }
    const migrationsOk = header.counts?.migrations === undefined || restored.migrations === header.counts.migrations;
    const hasData = Object.values(restored).some((v) => v !== null);
    let healthOk = true;
    if (healthUrl) {
      try {
        const res = await (io.fetch ?? fetch)(healthUrl, { signal: AbortSignal.timeout(15_000) });
        const body = (await res.json().catch(() => ({}))) as { status?: string };
        healthOk = res.ok && body.status === "ok";
        io.out(`health ${healthUrl}: HTTP ${res.status}, status ${String(body.status)}`);
      } catch (err) {
        healthOk = false;
        io.err(`health check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    io.out(`restored counts: ${JSON.stringify(restored)}`);
    if (mismatches.length) io.err(`count differences (writes between the count and the dump are possible): ${mismatches.join("; ")}`);
    const ok = migrationsOk && hasData && healthOk;
    io.out(ok ? "RESTORE TEST PASSED" : "RESTORE TEST FAILED");
    if (throwaway && keep) {
      io.out(`throwaway database left running (--keep): ${throwaway.url}`);
      throwaway = null;
    }
    return ok ? 0 : 1;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
    if (throwaway) await throwaway.stop().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runRestoreTool(process.argv.slice(2), { out: (l) => process.stdout.write(l + "\n"), err: (l) => process.stderr.write(l + "\n") }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`backup-restore: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
