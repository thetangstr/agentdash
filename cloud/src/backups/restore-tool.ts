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
import { pipeline } from "node:stream/promises";
import postgres from "postgres";
import { parseEscrowPublicKey } from "../railway/secrets.js";
import { createDecryptStream, parseEnvelopeHeader, type BackupEnvelopeHeader } from "./envelope.js";
import { replayDump, scanDump } from "./sql-restore.js";

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

export const RESTORE_USAGE = `usage: backup-restore inspect --in <file.adbk>
       backup-restore decrypt --in <file.adbk> --key-dir <dir> --out <dump.sql.gz> [--expect-slug <slug>] [--expect-backup-id <id>]
       backup-restore replay --dump <dump.sql.gz> --into <postgres-url> [--manifest <file>] [--health-url <url>]   (sandbox, no keys)`;

export async function runRestoreTool(argv: string[], io: RestoreIo): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "inspect") {
    const input = flag(rest, "--in");
    if (!input) return (io.err(RESTORE_USAGE), 64);
    io.out(JSON.stringify(publicHeader(readEnvelopeHeaderFile(input)), null, 2));
    return 0;
  }

  if (cmd === "decrypt") {
    const input = flag(rest, "--in");
    const keyDir = flag(rest, "--key-dir");
    const out = flag(rest, "--out");
    if (!input || !keyDir || !out) return (io.err(RESTORE_USAGE), 64);
    const expectSlug = flag(rest, "--expect-slug");
    const expectId = flag(rest, "--expect-backup-id");
    // Check the plain header first, so a swapped object is refused before decrypting anything.
    const plainHeader = readEnvelopeHeaderFile(input);
    if (expectSlug && plainHeader.slug !== expectSlug) return (io.err(`refusing: this backup is of ${plainHeader.slug}, not ${expectSlug}`), 3);
    if (expectId && plainHeader.backupId !== expectId) return (io.err(`refusing: this file is backup ${plainHeader.backupId}, not ${expectId}`), 3);
    const partial = `${out}.partial`;
    const unwipe = wipeOnSignal([partial]);
    try {
      const t0 = Date.now();
      const header = await decryptBackupFile(input, partial, readKeyDir(keyDir));
      // The header is authenticated by every frame: what decrypted must match what was checked.
      if (header.backupId !== plainHeader.backupId || header.slug !== plainHeader.slug) throw new Error("the header changed during decryption");
      const scan = await scanDump(partial);
      if (scan.refused.length) {
        fs.rmSync(partial, { force: true });
        io.err(`refusing: the dump fails the replay safety check (a tampered or hostile dump): ${scan.refused.map((r) => `#${r.index} ${r.reason}`).join("; ")}`);
        return 4;
      }
      fs.renameSync(partial, out);
      fs.writeFileSync(`${out}.manifest.json`, JSON.stringify(publicHeader(header), null, 2), { mode: 0o600 });
      io.out(`decrypted backup ${header.backupId} of ${header.slug} (${header.createdAt}, release ${header.release ?? "unknown"}) in ${Date.now() - t0} ms`);
      io.out(`safety check passed: ${scan.statements} statement(s), ${scan.copyBlocks} COPY block(s). Replay it only in a sandbox without keys (runbook §7).`);
      return 0;
    } catch (err) {
      fs.rmSync(partial, { force: true });
      throw err;
    } finally {
      unwipe();
    }
  }

  if (cmd === "replay") {
    const dump = flag(rest, "--dump");
    const into = flag(rest, "--into");
    if (!dump || !into) return (io.err(RESTORE_USAGE), 64);
    if (rest.includes("--key-dir")) return (io.err("refusing: replay never takes key material; decrypt on the key machine, replay in the sandbox"), 64);
    const manifestFile = flag(rest, "--manifest") ?? `${dump}.manifest.json`;
    const manifest = fs.existsSync(manifestFile) ? (JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Pick<BackupEnvelopeHeader, "counts" | "slug" | "backupId">) : null;
    const healthUrl = flag(rest, "--health-url");
    const reason = await liveTargetReason(into);
    if (reason) {
      io.err(`refusing to replay: ${reason}`);
      return 3;
    }
    const t1 = Date.now();
    const stats = await replayDump(dump, into);
    io.out(`replayed ${stats.statements} statement(s), ${stats.copyBlocks} COPY block(s) in ${Date.now() - t1} ms`);
    const restored = await countCoreTables(into);
    const mismatches: string[] = [];
    for (const [name, expected] of Object.entries(manifest?.counts ?? {})) {
      if (restored[name] !== expected) mismatches.push(`${name}: exported ${String(expected)}, restored ${String(restored[name])}`);
    }
    const migrationsOk = manifest ? manifest.counts?.migrations === restored.migrations : (restored.migrations ?? 0) > 0;
    if (!manifest) io.err(`no manifest at ${manifestFile}: counts are not compared`);
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
    const ok = migrationsOk && healthOk;
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
