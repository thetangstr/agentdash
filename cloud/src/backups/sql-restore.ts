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
//     (the control plane does not import box packages);
//   - nothing is buffered whole: one line, one statement head and one COPY
//     block each have hard caps, and a COPY payload streams line by line, so
//     a hostile dump cannot exhaust memory during decrypt's scanDump and a
//     legitimately huge table never has to fit in one V8 string.
import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import { createGunzip } from "node:zlib";
import postgres from "postgres";
import { checkStatement, copyFromStdinCommand, deferredStatement, initDumpGuard, isPgBlankLine, isPgCommentLine, MAX_STATEMENT_BYTES, pgTrim, STATEMENT_BREAKPOINT } from "./dump-guard.js";

export { STATEMENT_BREAKPOINT };
export { parseCopyFromStdin } from "./dump-guard.js";
const DETECT_BYTES = 64 * 1024;

/**
 * Hard caps so a hostile dump cannot exhaust memory on the offline key
 * machine. Only buffers are capped; a COPY payload streams line by line to
 * Postgres, so a legitimate table of any realistic size still restores.
 *
 *   MAX_LINE_BYTES       one physical line, the only place a single input row
 *                        is ever buffered (a TSV row, not a statement);
 *   MAX_STATEMENT_LINES  lines accumulated for one statement head (leading
 *                        comments + the statement text; a legit CREATE TABLE
 *                        is tens of lines);
 *   MAX_STATEMENT_BYTES  (dump-guard) bytes of one non-COPY statement;
 *   MAX_COPY_LINES / MAX_COPY_PAYLOAD_BYTES — per-COPY-block backstops that
 *                        only an absurd block could reach;
 *   MAX_DUMP_BYTES       total decompressed input (a gzip bomb backstop).
 */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;
export const MAX_STATEMENT_LINES = 65_536;
export const MAX_COPY_LINES = 50_000_000;
export const MAX_COPY_PAYLOAD_BYTES = 16 * 1024 * 1024 * 1024;
export const MAX_DUMP_BYTES = 64 * 1024 * 1024 * 1024;

/** The dump is valid enough to read but exceeds a bounded buffer; scanning must refuse it. */
export class DumpTooLarge extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DumpTooLarge";
  }
}

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

function open(file: string): Readable {
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

/**
 * Lines of a stream, split the way node:readline does (\n, \r\n or a lone \r,
 * including across chunk boundaries) but with two bounds readline does not
 * give us: a physical line may not exceed MAX_LINE_BYTES and the whole input
 * may not exceed MAX_DUMP_BYTES. setEncoding keeps multi-byte UTF-8 intact
 * across chunks.
 */
async function* iterateLines(stream: Readable): AsyncGenerator<string> {
  stream.setEncoding("utf8");
  let pending = "";
  let pendingBytes = 0;
  let totalBytes = 0;
  let skipLeadingLf = false;
  const take = (s: string) => {
    const b = Buffer.byteLength(s, "utf8");
    if (pendingBytes + b > MAX_LINE_BYTES) throw new DumpTooLarge(`a line exceeds ${MAX_LINE_BYTES} bytes`);
    pending += s;
    pendingBytes += b;
  };
  for await (const chunk of stream as AsyncIterable<string>) {
    let text = chunk;
    totalBytes += Buffer.byteLength(text, "utf8");
    if (totalBytes > MAX_DUMP_BYTES) throw new DumpTooLarge(`the dump exceeds ${MAX_DUMP_BYTES} bytes decompressed`);
    if (skipLeadingLf) {
      if (text.startsWith("\n")) text = text.slice(1);
      skipLeadingLf = false;
    }
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== 0x0a && c !== 0x0d) continue;
      take(text.slice(start, i));
      const line = pending;
      pending = "";
      pendingBytes = 0;
      if (c === 0x0d) {
        if (text.charCodeAt(i + 1) === 0x0a) i++;
        else if (i === text.length - 1) skipLeadingLf = true; // a \r\n split across chunks
      }
      yield line;
      start = i + 1;
    }
    if (start < text.length) take(text.slice(start));
  }
  if (pending.length) yield pending;
}

/** A plain statement chunk, bounded by the statement caps. */
export interface DumpSql {
  kind: "sql";
  /** The chunk's leading comments plus the statement itself — what checkStatement sees. */
  text: string;
}

/**
 * A `COPY … FROM stdin` block. `text` is the bounded head (leading comments
 * plus the header line) — what checkStatement sees; `payload` streams the TSV
 * lines up to the `\.` terminator, so the block is never one big string.
 */
export interface DumpCopy {
  kind: "copy";
  text: string;
  command: string;
  payload: AsyncIterable<string>;
}

export type DumpPiece = DumpSql | DumpCopy;

/**
 * The dump as a stream of pieces: one per statement-breakpoint chunk.
 * Non-COPY chunks yield one bounded string; a COPY chunk yields its head and
 * then streams its payload through `payload`, which reads ahead of the
 * generator only while the consumer drains it.
 */
export async function* statements(file: string): AsyncGenerator<DumpPiece> {
  const stream = open(file);
  const it = iterateLines(stream);
  let eof = false;
  try {
    while (!eof) {
      // Accumulate the head of one chunk until the statement kind is known.
      const head: string[] = [];
      let headBytes = 0;
      let command: string | null = null;
      let classified = false;
      while (!classified) {
        const n = await it.next();
        if (n.done) {
          eof = true;
          break;
        }
        const line = n.value;
        if (line === STATEMENT_BREAKPOINT) break;
        headBytes += Buffer.byteLength(line, "utf8") + 1;
        if (headBytes > MAX_STATEMENT_BYTES) throw new DumpTooLarge(`a statement exceeds ${MAX_STATEMENT_BYTES} bytes`);
        if (head.length >= MAX_STATEMENT_LINES) throw new DumpTooLarge(`a statement exceeds ${MAX_STATEMENT_LINES} lines`);
        head.push(line);
        if (isPgBlankLine(line) || isPgCommentLine(line)) continue;
        command = copyFromStdinCommand(line);
        classified = true;
      }
      if (classified && command === null) {
        // Plain statement: keep accumulating to the chunk's breakpoint.
        for (;;) {
          const n = await it.next();
          if (n.done) {
            eof = true;
            break;
          }
          const line = n.value;
          if (line === STATEMENT_BREAKPOINT) break;
          headBytes += Buffer.byteLength(line, "utf8") + 1;
          if (headBytes > MAX_STATEMENT_BYTES) throw new DumpTooLarge(`a statement exceeds ${MAX_STATEMENT_BYTES} bytes`);
          if (head.length >= MAX_STATEMENT_LINES) throw new DumpTooLarge(`a statement exceeds ${MAX_STATEMENT_LINES} lines`);
          head.push(line);
        }
      }
      const text = pgTrim(head.join("\n"));
      if (command !== null) {
        // The payload shares the line iterator: it reads ahead only while the
        // consumer drains it, ends at `\.`, the chunk's breakpoint or EOF, and
        // is capped even when the consumer walks away and we drain it below.
        const block = { lines: 0, bytes: 0, end: "" as "" | "terminator" | "boundary" | "eof" };
        const nextDataLine = async (): Promise<string | null> => {
          const n = await it.next();
          if (n.done) {
            block.end = "eof";
            eof = true;
            return null;
          }
          const line = n.value;
          if (line === "\\.") {
            block.end = "terminator";
            return null;
          }
          if (line === STATEMENT_BREAKPOINT) {
            block.end = "boundary";
            return null;
          }
          block.lines += 1;
          block.bytes += Buffer.byteLength(line, "utf8") + 1;
          if (block.bytes > MAX_COPY_PAYLOAD_BYTES || block.lines > MAX_COPY_LINES) {
            throw new DumpTooLarge(`a COPY block exceeds ${MAX_COPY_LINES} lines or ${MAX_COPY_PAYLOAD_BYTES} bytes of payload`);
          }
          return line;
        };
        const payload = (async function* () {
          for (;;) {
            const line = await nextDataLine();
            if (line === null) return;
            yield line;
          }
        })();
        yield { kind: "copy", text, command, payload };
        // If the consumer did not drain the payload (a refused header), drain
        // it here — still capped — so iteration resumes on a chunk boundary.
        while (!block.end) await nextDataLine();
        // Anything after the `\.` up to the breakpoint is inside the same
        // chunk: never ours to interpret (backup-lib writes none) — discard.
        if (block.end === "terminator") {
          for (;;) {
            const n = await it.next();
            if (n.done) {
              eof = true;
              break;
            }
            if (n.value === STATEMENT_BREAKPOINT) break;
          }
        }
        continue;
      }
      if (text) yield { kind: "sql", text };
    }
  } finally {
    stream.destroy();
  }
}

export interface DumpScan {
  statements: number;
  copyBlocks: number;
  /** AgentDash (GH #907): CHECK constraints, views, functions and triggers the dump carries; never run, re-created from our migrations. */
  skipped: number;
  /** The first refusals (statement index and reason). Empty means the dump may be replayed. */
  refused: Array<{ index: number; reason: string }>;
}

/** Check a whole dump without running anything, streaming so memory stays bounded. */
export async function scanDump(file: string): Promise<DumpScan> {
  await initDumpGuard();
  if (!(await hasStatementBreakpoints(file))) {
    return { statements: 0, copyBlocks: 0, skipped: 0, refused: [{ index: 0, reason: "not a backup-lib statement-breakpoint dump (plain pg_dump output is not replayed: it would need psql)" }] };
  }
  const scan: DumpScan = { statements: 0, copyBlocks: 0, skipped: 0, refused: [] };
  try {
    for await (const piece of statements(file)) {
      // AgentDash (GH #907): a schema object replay skips is not a refusal.
      const deferred = piece.kind === "sql" ? deferredStatement(piece.text) : null;
      if (deferred) scan.skipped++;
      const reason = deferred ? null : checkStatement(piece.text);
      if (reason && scan.refused.length < 20) scan.refused.push({ index: scan.statements, reason });
      if (piece.kind === "copy") {
        scan.copyBlocks++;
        for await (const _ of piece.payload) void _;
      }
      scan.statements++;
    }
  } catch (err) {
    if (!(err instanceof DumpTooLarge)) throw err;
    if (scan.refused.length < 20) scan.refused.push({ index: scan.statements, reason: err.message });
  }
  return scan;
}

/**
 * postgres.js runs `unsafe(text)` without parameters over the SIMPLE protocol,
 * which executes every statement in the string. `simple: false` forces the
 * extended protocol (Parse/Bind/Execute), where the server refuses more than
 * one statement ("cannot insert multiple commands into a prepared statement").
 * The option exists at runtime but not in the package's types.
 */
export const EXTENDED_PROTOCOL = { simple: false, prepare: false } as unknown as postgres.UnsafeQueryOptions;

export class ReplayRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayRefused";
  }
}

export interface RestoreStats {
  statements: number;
  copyBlocks: number;
  /** AgentDash (GH #907): schema objects in the dump that replay did not run (re-created from our migrations afterwards). */
  skipped: number;
}

/**
 * Why the connection's role is too powerful to replay a hostile dump, or
 * null. The sandbox's restore role must be a plain login role: no superuser,
 * CREATEROLE, CREATEDB, replication or BYPASSRLS, and a member of NO other
 * role (which rules out pg_read_server_files, pg_write_server_files,
 * pg_execute_server_program, any superuser role and any other grant).
 */
export async function replayRoleProblem(connectionString: string): Promise<string | null> {
  const sql = postgres(connectionString, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    const [r] = await sql<Array<Record<string, boolean | number>>>`
      select r.rolsuper as super, r.rolcreaterole as createrole, r.rolcreatedb as createdb,
             r.rolreplication as replication, r.rolbypassrls as bypassrls,
             pg_has_role(current_user, 'pg_read_server_files', 'MEMBER') as read_files,
             pg_has_role(current_user, 'pg_write_server_files', 'MEMBER') as write_files,
             pg_has_role(current_user, 'pg_execute_server_program', 'MEMBER') as exec_program,
             (select count(*)::int from pg_auth_members m where m.member = r.oid) as memberships,
             exists (select 1 from pg_roles s where s.rolsuper and s.oid <> r.oid and pg_has_role(current_user, s.oid, 'MEMBER')) as reaches_super
        from pg_roles r where r.rolname = current_user`;
    if (!r) return "could not read the current role";
    const bad = Object.entries(r).filter(([k, v]) => (k === "memberships" ? Number(v) > 0 : v === true)).map(([k]) => k);
    return bad.length ? `the restore role has ${bad.join(", ")}` : null;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Dumps carry `CREATE EXTENSION … WITH SCHEMA` (backup-lib writes it to keep
 * each extension in its recorded schema, and backups already in storage rely
 * on it). A dump-named schema must not give the extension script a hostile
 * search_path — CVE-2022-2625 was fixed in 10.22 / 11.17 / 12.12 / 13.8 /
 * 14.5 and CVE-2023-39417 in 11.21 / 12.16 / 13.12 / 14.9 / 15.4, with the
 * 10.x line end-of-life and never fixed for the second. Replay therefore
 * requires the later fix: 11.21 / 12.16 / 13.12 / 14.9 / 15.4 or any 16+.
 */
export function extensionSchemaSafe(versionNum: number): boolean {
  if (versionNum >= 160000) return true;
  const minMinor: Record<number, number> = { 11: 21, 12: 16, 13: 12, 14: 9, 15: 4 };
  return versionNum % 10000 >= (minMinor[Math.floor(versionNum / 10000)] ?? Infinity);
}

/** Replay a dump that passed scanDump into a disposable database, as a plain non-superuser role. */
export async function replayDump(file: string, connectionString: string): Promise<RestoreStats> {
  await initDumpGuard();
  const problem = await replayRoleProblem(connectionString);
  if (problem) {
    throw new ReplayRefused(`refusing to replay: ${problem}. Connect as the sandbox's plain restore role (not a superuser, member of no role; runbook §7)`);
  }
  const scan = await scanDump(file);
  if (scan.refused.length) {
    throw new ReplayRefused(`the dump failed the safety check: ${scan.refused.map((r) => `#${r.index} ${r.reason}`).join("; ")}`);
  }
  const sql = postgres(connectionString, { max: 1, connect_timeout: 10, onnotice: () => {} });
  const stats: RestoreStats = { statements: 0, copyBlocks: 0, skipped: 0 };
  try {
    const [v] = await sql<Array<{ v: number }>>`select current_setting('server_version_num')::int as v`;
    if (!v || !extensionSchemaSafe(v.v)) {
      throw new ReplayRefused(`the sandbox's PostgreSQL (server_version_num ${v?.v ?? "unreadable"}) predates the CREATE EXTENSION … WITH SCHEMA search_path fixes (CVE-2022-2625, CVE-2023-39417); replay requires 11.21 / 12.16 / 13.12 / 14.9 / 15.4 / 16.0 or later`);
    }
    for await (const piece of statements(file)) {
      // AgentDash (GH #907): CHECK constraints, views, functions and triggers
      // written by the box are never executed; schema-verify re-creates them
      // from our own migrations.
      if (piece.kind === "sql" && deferredStatement(piece.text)) {
        stats.skipped++;
        stats.statements++;
        continue;
      }
      // Checked again: the file could have changed since the scan.
      const reason = checkStatement(piece.text);
      if (reason) throw new ReplayRefused(`statement #${stats.statements} failed the safety check: ${reason}`);
      // Extended protocol (simple: false): the server accepts exactly ONE
      // statement per call, so nothing the parser did not see can ride along.
      if (piece.kind === "copy") {
        // AgentDash (GH #907 review): a COPY the server refuses is reported only
        // through the query's own reject(), a no-op once the query resolved
        // with the stream; the stream then never finishes or errors and the
        // replay would hang. Capture that rejection so the block fails.
        const query = sql.unsafe(piece.command, [], EXTENDED_PROTOCOL) as unknown as { reject: (error: unknown) => void; writable(): Promise<Writable> };
        // This hooks a postgres.js internal (pinned to 3.4.8 in package.json).
        // If a future version drops it, fail loudly instead of hanging again.
        if (typeof query.reject !== "function") {
          throw new Error("replayDump: postgres.js query.reject is not a function; this version of postgres.js is not supported for COPY replay (pinned 3.4.8)");
        }
        let copyError: unknown = null;
        let failCopy: ((error: unknown) => void) | null = null;
        const originalReject = query.reject;
        query.reject = (error: unknown) => {
          copyError ??= error;
          failCopy?.(error);
          originalReject(error);
        };
        const writable = await query.writable();
        const failed = new Promise<never>((_, reject) => {
          if (copyError) reject(copyError);
          failCopy = reject;
          writable.once("error", reject);
        });
        failed.catch(() => {});
        try {
          for await (const line of piece.payload) {
            // The payload streams: write line by line, honouring backpressure.
            if (!writable.write(`${line}\n`)) await Promise.race([once(writable, "drain"), failed]);
          }
          writable.end();
          await Promise.race([once(writable, "finish"), failed]);
        } catch (err) {
          writable.destroy();
          throw err;
        }
        stats.copyBlocks++;
      } else {
        await sql.unsafe(piece.text, [], EXTENDED_PROTOCOL);
      }
      stats.statements++;
    }
    return stats;
  } catch (err) {
    if (err instanceof ReplayRefused) throw err;
    if (err instanceof DumpTooLarge) throw new ReplayRefused(`the dump exceeds a bounded buffer: ${err.message}`);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`replay failed after ${stats.statements} statement(s): ${msg.replace(/postgres(ql)?:\/\/[^\s]+/g, "[url]")}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
