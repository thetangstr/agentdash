// AgentDash (GH #733): the OFFLINE restore tool for off-box backups. The
// control plane holds only the public key and cannot decrypt a backup.
//
// Decrypting and replaying are separate steps on purpose (security review of
// #899): the dump is written by the box, so a compromised tenant controls its
// SQL. The machine holding the backup secret key must never execute it.
//
//   inspect --in <file.adbk>
//       print the backup's plain header (box, slug, time, key id, counts); no key needed
//   decrypt --in <file.adbk> --key-dir <dir> --out <dump.sql.gz>
//           [--expect-slug <slug>] [--expect-backup-id <id>]
//       on the KEY machine: decrypt (mode 600, never overwrites), check the
//       header names the backup you asked for (the sealed box does not prove
//       which box produced it, and anyone with bucket write access could swap
//       objects), and run the replay safety check WITHOUT executing anything.
//       Writes <dump>.manifest.json (the header, without the sealed key).
//   replay --dump <dump.sql.gz> --into <postgres-url> [--manifest <file>] [--health-url <url>]
//       in a DISPOSABLE sandbox with NO key material (runbook §7): replays the
//       dump as a NON-superuser into an empty or never-claimed database
//       (refuses a superuser, a target holding users or companies, and any
//       statement failing ./dump-guard.ts), then checks the restored counts
//       against the manifest (the migration count must match).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import postgres from "postgres";
import { parseEscrowPublicKey } from "../railway/secrets.js";
import { createDecryptStream, parseEnvelopeHeader, type BackupEnvelopeHeader } from "./envelope.js";
import { replayDump, scanDump } from "./sql-restore.js";
import { verifyRestoredSchema } from "./schema-verify.js";

export interface RestoreIo {
  out: (l: string) => void;
  err: (l: string) => void;
  fetch?: typeof fetch;
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

/** The header as shown or written beside a dump: everything but the sealed data key. */
export function publicHeader(h: BackupEnvelopeHeader): Omit<BackupEnvelopeHeader, "sealedDataKey"> {
  const { sealedDataKey: _omit, ...shown } = h;
  return shown;
}

/** Decrypt an envelope file to a gzipped dump file (mode 600, must not exist). */
export async function decryptBackupFile(input: string, output: string, keys: { publicKey: Uint8Array; secretKey: Uint8Array }): Promise<BackupEnvelopeHeader> {
  let header: BackupEnvelopeHeader | null = null;
  const dec = await createDecryptStream(keys.publicKey, keys.secretKey, { onHeader: (h) => (header = h) });
  await pipeline(fs.createReadStream(input), dec, fs.createWriteStream(output, { mode: 0o600, flags: "wx" }));
  if (!header) throw new Error("no header");
  return header;
}

/** Remove `files` if the process is interrupted; returns the uninstaller. */
function wipeOnSignal(files: string[]): () => void {
  const handler = (sig: NodeJS.Signals) => {
    for (const f of files) fs.rmSync(f, { force: true });
    process.stderr.write(`backup-restore: interrupted (${sig}); removed the partial plaintext\n`);
    process.exit(130);
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Strip control characters (terminal escapes) from box-written text before it is printed. */
export function sanitize(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "?").slice(0, 200);
}

/** The header with every box-written string sanitised, for printing and the manifest. */
export function printableHeader(h: BackupEnvelopeHeader): Record<string, unknown> {
  const shown = publicHeader(h) as Record<string, unknown>;
  const counts: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(h.counts ?? {}).slice(0, 20)) counts[sanitize(k)] = typeof v === "number" ? v : null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shown)) out[k] = k === "counts" ? counts : typeof v === "number" || v === null ? v : sanitize(v);
  return out;
}

/** Default: this repository's box migrations (the restore tool runs from a checkout). */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/src/migrations", import.meta.url));

export const RESTORE_USAGE = `usage: backup-restore inspect --in <file.adbk>
       backup-restore decrypt --in <file.adbk> --key-dir <dir> --out <dump.sql.gz> --expect-slug <slug> --expect-backup-id <id>
       backup-restore replay --dump <dump.sql.gz> --into <postgres-url> --reference <empty-postgres-url>
                             [--manifest <file>] [--migrations-dir <dir>] [--health-url <url>]   (sandbox, no keys)`;

export async function runRestoreTool(argv: string[], io: RestoreIo): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "inspect") {
    const input = flag(rest, "--in");
    if (!input) return (io.err(RESTORE_USAGE), 64);
    io.out(JSON.stringify(printableHeader(readEnvelopeHeaderFile(input)), null, 2));
    return 0;
  }

  if (cmd === "decrypt") {
    const input = flag(rest, "--in");
    const keyDir = flag(rest, "--key-dir");
    const out = flag(rest, "--out");
    const expectSlug = flag(rest, "--expect-slug");
    const expectId = flag(rest, "--expect-backup-id");
    // Both expectations are required: the sealed box does not prove which box produced an object.
    if (!input || !keyDir || !out || !expectSlug || !expectId) return (io.err(RESTORE_USAGE), 64);
    const manifestPath = `${out}.manifest.json`;
    for (const f of [out, manifestPath]) if (fs.existsSync(f)) return (io.err(`refusing: ${f} already exists (decrypt never overwrites)`), 3);
    // Check the plain header first, so a swapped object is refused before decrypting anything.
    const plainHeader = readEnvelopeHeaderFile(input);
    if (plainHeader.slug !== expectSlug) return (io.err(`refusing: this backup is of ${sanitize(plainHeader.slug)}, not ${sanitize(expectSlug)}`), 3);
    if (plainHeader.backupId !== expectId) return (io.err(`refusing: this file is backup ${sanitize(plainHeader.backupId)}, not ${sanitize(expectId)}`), 3);
    const partial = `${out}.partial`;
    const unwipe = wipeOnSignal([partial]);
    let keep = false;
    try {
      const t0 = Date.now();
      const header = await decryptBackupFile(input, partial, readKeyDir(keyDir));
      // Every frame authenticates the header: what decrypted must be what was checked.
      if (header.backupId !== plainHeader.backupId || header.slug !== plainHeader.slug) throw new Error("the header changed during decryption");
      const scan = await scanDump(partial);
      if (scan.refused.length) {
        io.err(`refusing: the dump fails the replay safety check (a tampered or hostile dump): ${scan.refused.map((r) => `#${r.index} ${sanitize(r.reason)}`).join("; ")}`);
        return 4;
      }
      // link() refuses an existing target, so a file created meanwhile is never replaced.
      fs.linkSync(partial, out);
      keep = true;
      fs.writeFileSync(manifestPath, JSON.stringify(printableHeader(header), null, 2), { mode: 0o600, flag: "wx" });
      const h = printableHeader(header);
      io.out(`decrypted backup ${String(h.backupId)} of ${String(h.slug)} (${String(h.createdAt)}, release ${String(h.release ?? "unknown")}) in ${Date.now() - t0} ms`);
      io.out(`safety check passed: ${scan.statements} statement(s), ${scan.copyBlocks} COPY block(s), ${scan.skipped} schema object(s) that replay skips. Replay it only in a sandbox without keys (runbook §7).`);
      return 0;
    } catch (err) {
      if (keep) fs.rmSync(out, { force: true });
      throw err;
    } finally {
      fs.rmSync(partial, { force: true });
      unwipe();
    }
  }

  if (cmd === "replay") {
    const dump = flag(rest, "--dump");
    const into = flag(rest, "--into");
    const reference = flag(rest, "--reference");
    if (!dump || !into || !reference) return (io.err(RESTORE_USAGE), 64);
    if (rest.includes("--key-dir")) return (io.err("refusing: replay never takes key material; decrypt on the key machine, replay in the sandbox"), 64);
    if (reference === into) return (io.err("refusing: --reference must be a second, empty database"), 64);
    const migrationsDir = flag(rest, "--migrations-dir") ?? DEFAULT_MIGRATIONS_DIR;
    const manifestFile = flag(rest, "--manifest") ?? `${dump}.manifest.json`;
    const manifest = fs.existsSync(manifestFile) ? (JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { counts?: Record<string, number | null> }) : null;
    const healthUrl = flag(rest, "--health-url");
    const reason = await liveTargetReason(into);
    if (reason) {
      io.err(`refusing to replay: ${reason}`);
      return 3;
    }
    const t1 = Date.now();
    const stats = await replayDump(dump, into);
    io.out(`replayed ${stats.statements} statement(s), ${stats.copyBlocks} COPY block(s), skipped ${stats.skipped} schema object(s) in ${Date.now() - t1} ms`);

    // Before any promotion: the schema must be what OUR migrations (as recorded in the restored table) create.
    const t2 = Date.now();
    const v = await verifyRestoredSchema({ restoredUrl: into, referenceUrl: reference, migrationsDir });
    io.out(`schema check against ${v.appliedMigrations} of our migrations in ${Date.now() - t2} ms: ${v.ok ? "no unexplained objects" : "FAILED"}`);
    if (v.repaired.length) {
      io.out(`re-created ${v.repaired.length} object(s) replay does not run from a dump (CHECK constraints, views, functions, triggers), from our migrations only; the schema now matches exactly`);
    }
    for (const p of v.problems) io.err(`schema: ${sanitize(p)}`);
    for (const e of v.extra.slice(0, 50)) io.err(`  unexplained ${sanitize(e)}`);
    if (v.missing.length) {
      const byCategory = new Map<string, number>();
      for (const m of v.missing) byCategory.set(m.split(":")[0]!, (byCategory.get(m.split(":")[0]!) ?? 0) + 1);
      io.err(
        `note: ${v.missing.length} object(s) our migrations create are not in the restore (${[...byCategory].map(([c, n]) => `${c} ${n}`).join(", ")}): ` +
          "these could not be re-created from our migrations.",
      );
      for (const m of v.missing.slice(0, 100)) io.err(`  missing ${sanitize(m)}`);
    }

    const restored = await countCoreTables(into);
    const mismatches: string[] = [];
    for (const [name, expected] of Object.entries(manifest?.counts ?? {})) {
      if (restored[name] !== expected) mismatches.push(`${sanitize(name)}: exported ${String(expected)}, restored ${String(restored[name])}`);
    }
    let healthOk = true;
    if (healthUrl) {
      try {
        const res = await (io.fetch ?? fetch)(healthUrl, { signal: AbortSignal.timeout(15_000) });
        const body = (await res.json().catch(() => ({}))) as { status?: string };
        healthOk = res.ok && body.status === "ok";
        io.out(`health ${healthUrl}: HTTP ${res.status}, status ${sanitize(body.status)}`);
      } catch (err) {
        healthOk = false;
        io.err(`health check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    io.out(`restored counts: ${JSON.stringify(restored)}`);
    if (mismatches.length) io.err(`count differences from the box's report (informational): ${mismatches.join("; ")}`);
    const ok = v.ok && healthOk;
    io.out(ok ? "RESTORE TEST PASSED" : "RESTORE TEST FAILED");
    return ok ? 0 : 1;
  }

  io.err(RESTORE_USAGE);
  return 64;
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
