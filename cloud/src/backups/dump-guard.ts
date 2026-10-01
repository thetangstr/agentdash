// AgentDash (GH #733 security review): the guardrails for replaying a box's
// dump.
//
// Threat model: the dump is written by the BOX. A compromised tenant box can
// put anything in it, and the envelope only proves the control plane sealed
// what the box sent; it does not prove the SQL is benign. Replaying it must
// therefore never give that SQL more power than a database-owner role in a
// disposable database:
//   - no psql (meta-commands such as `\!` run shell commands on the client);
//   - replay only as a NON-superuser (refused otherwise, see sql-restore.ts),
//     in a disposable Postgres that holds nothing else, on a machine without
//     the backup secret key (runbook §7);
//   - and, as defence in depth, every statement must have one of the shapes
//     packages/db/src/backup-lib.ts writes, with nothing on the deny list.
// The deny list is checked on the statement with string literals and quoted
// identifiers blanked out (customer data may contain any word), while
// dollar-quoted bodies stay visible (they are code).

export const STATEMENT_BREAKPOINT = "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";

/** Extensions a box schema may create (pg_trgm today; the rest are trusted, common and harmless). */
export const EXTENSION_ALLOWLIST = new Set(["plpgsql", "pg_trgm", "pgcrypto", "uuid-ossp", "citext", "btree_gin", "btree_gist", "unaccent", "fuzzystrmatch", "vector"]);

/** The statement shapes backup-lib emits. Anything else is refused. */
const ALLOWED_SHAPES: RegExp[] = [
  /^BEGIN;?$/i,
  /^COMMIT;?$/i,
  /^SET\s+LOCAL\s+(session_replication_role|client_min_messages)\s*(=|TO)\s*\w+;?$/i,
  /^CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS\s+/i,
  /^CREATE\s+TYPE\s+\S+\s+AS\s+ENUM\s*\(/i,
  /^CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+/i,
  /^DROP\s+(TABLE|SEQUENCE)\s+IF\s+EXISTS\s+/i,
  /^CREATE\s+SEQUENCE\s+/i,
  /^CREATE\s+TABLE\s+/i,
  /^CREATE\s+(UNIQUE\s+)?INDEX\s+/i,
  /^ALTER\s+TABLE\s+\S+\s+ADD\s+CONSTRAINT\s+/i,
  /^ALTER\s+SEQUENCE\s+\S+\s+OWNED\s+BY\s+/i,
  /^INSERT\s+INTO\s+/i,
  /^SELECT\s+setval\s*\(\s*'[^']*'\s*,\s*-?\d+\s*,\s*(true|false)\s*\)\s*;?$/i,
  /^COPY\s+("[^"]+"|\w+)(\.("[^"]+"|\w+))?\s*\([^)]*\)\s+FROM\s+stdin;?$/i,
];

// The allowed shapes already keep out whole statement kinds (CREATE FUNCTION,
// triggers, rules, event triggers, ALTER SYSTEM, roles, GRANT, DO, LOAD, a
// second statement). Inside an allowed statement (a column default, a CHECK,
// an index expression, an INSERT value) these must still never appear.
const DENY: Array<[RegExp, string]> = [
  [/\bPROGRAM\b/i, "COPY … PROGRAM"],
  [/\$\w*\$/, "dollar-quoted code"],
  [/\b(LO_IMPORT|LO_EXPORT|LO_FROM_BYTEA|PG_READ_FILE|PG_READ_BINARY_FILE|PG_LS_\w+|PG_STAT_FILE|PG_FILE_\w+|PG_EXECUTE_SERVER_PROGRAM|DBLINK\w*|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|PG_RELOAD_CONF|PG_ROTATE_LOGFILE|SET_CONFIG|PG_SLEEP\w*|QUERY_TO_XML\w*|CURSOR_TO_XML|TABLE_TO_XML\w*)\s*\(/i, "server-side file, process or config access"],
];

/** Blank out single-quoted literals (also E'' strings) and double-quoted identifiers; keep dollar-quoted bodies. */
export function blankLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      const q = c;
      const escapes = q === "'" && /[eE]$/.test(sql.slice(Math.max(0, i - 1), i)) && !/\w/.test(sql[i - 2] ?? "");
      out += q === "'" ? "''" : '""';
      i++;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stripLeadingComments(statement: string): string {
  const lines = statement.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i]!.trim() === "" || lines[i]!.trim().startsWith("--"))) i++;
  return lines.slice(i).join("\n").trim();
}

/** Why a statement must not be replayed, or null when it may. COPY blocks are checked on their header only. */
export function checkStatement(statement: string): string | null {
  const body = stripLeadingComments(statement);
  if (!body) return null;
  const firstLine = body.split("\n")[0]!.trim();
  if (/^COPY\s/i.test(firstLine)) {
    return ALLOWED_SHAPES.at(-1)!.test(firstLine) ? null : "COPY other than COPY <table> (<columns>) FROM stdin";
  }
  // Literals blanked first: customer text inside an INSERT may hold any line.
  const visible = blankLiterals(body);
  for (const line of visible.split("\n")) if (line.trimStart().startsWith("\\")) return "psql meta-command";
  if (!ALLOWED_SHAPES.some((re) => re.test(body))) return `statement shape not written by the backup library: ${firstLine.slice(0, 60)}`;
  // Only one statement per breakpoint: a second `;` outside literals smuggles another.
  if (/;\s*\S/.test(visible.replace(/;\s*$/, ";"))) return "more than one statement";
  for (const [re, what] of DENY) if (re.test(visible)) return what;
  const ext = /^CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+("?)([\w-]+)\1/i.exec(body);
  if (ext && !EXTENSION_ALLOWLIST.has(ext[2]!.toLowerCase())) return `extension ${ext[2]} is not on the allowlist`;
  return null;
}
