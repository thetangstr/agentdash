// AgentDash (GH #733): replay a box's decrypted dump into a DISPOSABLE
// Postgres. The dump is box-written, so treat it as hostile (threat model in
// ./dump-guard.ts):
//   - only backup-lib's statement-breakpoint format is accepted; there is no
//     psql path (psql meta-commands would run on this machine);
//   - the whole file is checked statement by statement BEFORE anything runs,
//     and each statement is checked again as it is sent;
//   - the target role must not be a superuser (no COPY … PROGRAM, no
//     server-side file access, no extension outside the trusted set);
//   - statements go through postgres.js one at a time, COPY blocks through
//     its COPY FROM STDIN stream. This mirrors backup-lib's runDatabaseRestore
//     (the control plane does not import box packages).
import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import postgres from "postgres";
import { checkStatement, STATEMENT_BREAKPOINT } from "./dump-guard.js";

export { STATEMENT_BREAKPOINT };
const DETECT_BYTES = 64 * 1024;

/** Gzip by content (magic 1f 8b), not by file name. */
function isGzip(file: string): boolean {
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(2);
    return readSync(fd, b, 0, 2, 0) === 2 && b[0] === 0x1f && b[1] === 0x8b;
  } finally {
    closeSync(fd);
  }
}

function open(file: string) {
  const raw = createReadStream(file);
  return isGzip(file) ? raw.pipe(createGunzip()) : raw;
}

export async function hasStatementBreakpoints(file: string): Promise<boolean> {
  const stream = open(file);
  let text = "";
  try {
    for await (const chunk of stream) {
      text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (text.includes(STATEMENT_BREAKPOINT)) return true;
      if (text.length >= DETECT_BYTES) return false;
    }
    return text.includes(STATEMENT_BREAKPOINT);
  } finally {
    stream.destroy();
  }
}

export async function* statements(file: string): AsyncGenerator<string> {
  const stream = open(file);
  stream.setEncoding("utf8");
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lines: string[] = [];
  const flush = () => {
    const s = lines.join("\n").trim();
    lines = [];
    return s;
  };
  try {
    for await (const line of reader) {
      if (line === STATEMENT_BREAKPOINT) {
        const s = flush();
        if (s) yield s;
        continue;
      }
      lines.push(line);
    }
    const s = flush();
    if (s) yield s;
  } finally {
    reader.close();
    stream.destroy();
  }
}

/** A `COPY … FROM stdin` block (after any leading comments), split into command and TSV payload. */
export function parseCopyFromStdin(statement: string): { command: string; payload: string } | null {
  const all = statement.split("\n");
  let i = 0;
  while (i < all.length && (all[i]!.trim() === "" || all[i]!.trim().startsWith("--"))) i++;
  if (i >= all.length) return null;
  const header = all[i]!.trim();
  if (!/^COPY\s.+\sFROM\s+stdin\s*;?$/i.test(header)) return null;
  const lines = all.slice(i + 1);
  const end = lines.findIndex((l) => l === "\\.");
  const data = end === -1 ? lines : lines.slice(0, end);
  return { command: header.replace(/;$/, ""), payload: data.length ? `${data.join("\n")}\n` : "" };
}

export interface DumpScan {
  statements: number;
  copyBlocks: number;
  /** The first refusals (statement index and reason). Empty means the dump may be replayed. */
  refused: Array<{ index: number; reason: string }>;
}

/** Check a whole dump without running anything. */
export async function scanDump(file: string): Promise<DumpScan> {
  if (!(await hasStatementBreakpoints(file))) {
    return { statements: 0, copyBlocks: 0, refused: [{ index: 0, reason: "not a backup-lib statement-breakpoint dump (plain pg_dump output is not replayed: it would need psql)" }] };
  }
  const scan: DumpScan = { statements: 0, copyBlocks: 0, refused: [] };
  for await (const s of statements(file)) {
    const reason = checkStatement(s);
    if (reason && scan.refused.length < 20) scan.refused.push({ index: scan.statements, reason });
    if (parseCopyFromStdin(s)) scan.copyBlocks++;
    scan.statements++;
  }
  return scan;
}

export class ReplayRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayRefused";
  }
}

export interface RestoreStats {
  statements: number;
  copyBlocks: number;
}

/** True when the connection's role is a superuser (or can become one). */
export async function isSuperuser(connectionString: string): Promise<boolean> {
  const sql = postgres(connectionString, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const [r] = await sql<Array<{ s: boolean }>>`select rolsuper or rolreplication or rolbypassrls as s from pg_roles where rolname = current_user`;
    return Boolean(r?.s);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Replay a dump that passed scanDump into a disposable database, as a non-superuser. */
export async function replayDump(file: string, connectionString: string): Promise<RestoreStats> {
  if (await isSuperuser(connectionString)) {
    throw new ReplayRefused("refusing to replay as a superuser: connect as the sandbox's non-superuser restore role (runbook §7)");
  }
  const scan = await scanDump(file);
  if (scan.refused.length) {
    throw new ReplayRefused(`the dump failed the safety check: ${scan.refused.map((r) => `#${r.index} ${r.reason}`).join("; ")}`);
  }
  const sql = postgres(connectionString, { max: 1, connect_timeout: 10, onnotice: () => {} });
  const stats: RestoreStats = { statements: 0, copyBlocks: 0 };
  try {
    for await (const s of statements(file)) {
      // Checked again: the file could have changed since the scan.
      const reason = checkStatement(s);
      if (reason) throw new ReplayRefused(`statement #${stats.statements} failed the safety check: ${reason}`);
      const copy = parseCopyFromStdin(s);
      if (copy) {
        const writable = (await sql.unsafe(copy.command).writable()) as NodeJS.WritableStream;
        await new Promise<void>((resolve, reject) => {
          writable.on("error", reject);
          writable.on("finish", resolve);
          if (copy.payload) writable.write(copy.payload);
          writable.end();
        });
        stats.copyBlocks++;
      } else {
        await sql.unsafe(s);
      }
      stats.statements++;
    }
    return stats;
  } catch (err) {
    if (err instanceof ReplayRefused) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`replay failed after ${stats.statements} statement(s): ${msg.replace(/postgres(ql)?:\/\/[^\s]+/g, "[url]")}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
