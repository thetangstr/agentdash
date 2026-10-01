// AgentDash (GH #733): load a box's gzipped SQL dump into a Postgres database
// (the restore tool's target: a throwaway local database or an EMPTY
// throwaway box). The dump is what packages/db/src/backup-lib.ts writes on a
// box: without pg_dump (the box image ships none) it is the "statement
// breakpoint" format, whose statements and COPY blocks this module replays
// through postgres.js, the same way backup-lib's runDatabaseRestore does (the
// control plane does not import the box's packages, so the parser is mirrored
// here and the round-trip test runs it against backup-lib's real output). A
// plain pg_dump file (no breakpoints) is piped to `psql` instead.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import postgres from "postgres";

export const STATEMENT_BREAKPOINT = "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";
const DETECT_BYTES = 64 * 1024;

function open(file: string) {
  const raw = createReadStream(file);
  return file.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
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

async function* statements(file: string): AsyncGenerator<string> {
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

export interface RestoreStats {
  statements: number;
  copyBlocks: number;
  engine: "statements" | "psql";
}

/** Restore a dump into `connectionString`. Throws on the first failing statement (the dump runs in one transaction). */
export async function restoreSqlDump(file: string, connectionString: string): Promise<RestoreStats> {
  if (!(await hasStatementBreakpoints(file))) {
    await restoreWithPsql(file, connectionString);
    return { statements: 0, copyBlocks: 0, engine: "psql" };
  }
  const sql = postgres(connectionString, { max: 1, connect_timeout: 10, onnotice: () => {} });
  const stats: RestoreStats = { statements: 0, copyBlocks: 0, engine: "statements" };
  try {
    for await (const s of statements(file)) {
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
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`restore failed after ${stats.statements} statement(s): ${msg.replace(/postgres(ql)?:\/\/[^\s]+/g, "[url]")}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function restoreWithPsql(file: string, connectionString: string): Promise<void> {
  const bin = process.env.PAPERCLIP_PSQL_PATH || "psql";
  const child = spawn(bin, [`--dbname=${connectionString}`, "--set=ON_ERROR_STOP=1", "--quiet", "--no-psqlrc"], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    if (stderr.length < 8192) stderr += d.toString("utf8");
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", (err) => reject(new Error(`this dump is plain pg_dump output and needs psql (${(err as NodeJS.ErrnoException).code ?? err.message}); install psql or set PAPERCLIP_PSQL_PATH`)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`psql exited ${code}: ${stderr.trim().slice(0, 500)}`))));
  });
  open(file).pipe(child.stdin!);
  await exited;
}
