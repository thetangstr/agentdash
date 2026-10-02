import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { open as openFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import postgres from "postgres";

export type BackupRetentionPolicy = {
  dailyDays: number;
  weeklyWeeks: number;
  monthlyMonths: number;
};

export type RunDatabaseBackupOptions = {
  connectionString: string;
  backupDir: string;
  retention: BackupRetentionPolicy;
  filenamePrefix?: string;
  connectTimeoutSeconds?: number;
  /**
   * @deprecated Migration-journal schemas are included with the normal backup
   * scope. This option is kept for compatibility and no longer changes backup
   * engine selection.
   */
  includeMigrationJournal?: boolean;
  excludeTables?: string[];
  nullifyColumns?: Record<string, string[]>;
  backupEngine?: "auto" | "pg_dump" | "javascript";
};

export type RunDatabaseBackupResult = {
  backupFile: string;
  sizeBytes: number;
  prunedCount: number;
};

export type RunDatabaseRestoreOptions = {
  connectionString: string;
  backupFile: string;
  connectTimeoutSeconds?: number;
};

type SequenceDefinition = {
  /** The sequence's pg_class oid — a 'c:' catalog key the backup emits before the tables. */
  sequence_oid: string;
  sequence_schema: string;
  sequence_name: string;
  data_type: string;
  start_value: string;
  minimum_value: string;
  maximum_value: string;
  increment: string;
  cycle_option: "YES" | "NO";
  owner_schema: string | null;
  owner_table: string | null;
  owner_column: string | null;
};

type TableDefinition = {
  schema_name: string;
  tablename: string;
};

type ExtensionDefinition = {
  extension_name: string;
  schema_name: string;
};

// AgentDash (GH #907): schema objects the pg_dump-less engine used to drop.
// `depends_on` holds catalog keys: `c:<pg_class oid>` for a relation (or a
// relation's row type), `p:<pg_proc oid>` for a function.
type FunctionDefinition = {
  oid: string;
  schema_name: string;
  function_name: string;
  definition: string;
  depends_on: string[];
};

type CheckConstraintDefinition = {
  schema_name: string;
  tablename: string;
  constraint_name: string;
  definition: string;
  validated: boolean;
  /** The columns conkey records — a check that names a column added late must wait for it. */
  column_names: string[];
};

type ViewDefinition = {
  oid: string;
  schema_name: string;
  view_name: string;
  relkind: "v" | "m";
  definition: string;
  reloptions: string[] | null;
  depends_on: string[];
};

type TriggerDefinition = {
  schema_name: string;
  tablename: string;
  trigger_name: string;
  definition: string;
  /** pg_trigger.tgenabled: O (default, origin/local), D (disabled), R (replica), A (always). */
  enabled: "O" | "D" | "R" | "A";
};

// AgentDash (GH #944): domains and standalone composite types, so CREATE
// TABLE can name them (a column of a domain, or an array of either) instead
// of flattening a domain to its base type or failing on a composite that was
// never recreated.
type DomainDefinition = {
  oid: string;
  schema_name: string;
  domain_name: string;
  /** format_type(typbasetype, typtypmod): the base type exactly as declared. */
  base_type: string;
  not_null: boolean;
  /** Qualified collation name, or null when the domain uses its base type's. */
  collation: string | null;
  default_expr: string | null;
  /**
   * Catalog keys for everything pg_depend records on the domain: `t:<pg_type
   * oid>` for referenced types (its base type among them), `p:<pg_proc oid>`
   * for functions the default expression calls, `c:<pg_class oid>` for
   * relations the default touches (a sequence, or a relation's row type).
   */
  depends_on: string[];
};

type DomainConstraintDefinition = {
  schema_name: string;
  domain_name: string;
  constraint_name: string;
  /** pg_get_constraintdef output, including a trailing NOT VALID when applicable. */
  definition: string;
  validated: boolean;
  depends_on: string[];
};

type CompositeAttributeDefinition = {
  attribute_name: string;
  /** format_type(atttypid, atttypmod): the attribute type exactly as declared. */
  attribute_type: string;
  collation: string | null;
};

type CompositeTypeDefinition = {
  oid: string;
  /** The composite's hidden pg_class row (relkind 'c'); a valid pre-table dependency target. */
  class_oid: string;
  schema_name: string;
  type_name: string;
  attributes: CompositeAttributeDefinition[];
  /** `t:<pg_type oid>` keys for every attribute type (and array element type). */
  depends_on: string[];
};

// AgentDash (GH #944): one table column, read from pg_attribute so the type
// is format_type(atttypid, atttypmod) — exact, unlike rebuilding it from
// information_schema (which lost temporal precision, bit lengths, domains
// and composite types).
type TableColumnDefinition = {
  schema_name: string;
  tablename: string;
  column_name: string;
  type_name: string;
  not_null: boolean;
  /** '' for an ordinary column, 's' for GENERATED ALWAYS AS (…) STORED, 'v' for VIRTUAL. */
  generated: "" | "s" | "v";
  generated_expr: string | null;
  column_default: string | null;
  /**
   * AgentDash (GH #939): catalog keys for the column default's pg_depend
   * rows — `p:<pg_proc oid>` for a called function, `c:<pg_class oid>` for a
   * sequence or a relation's row type, `t:<pg_type oid>` for a cast type.
   */
  default_depends_on: string[];
};

type SchemaObjectDefinitions = {
  functions: FunctionDefinition[];
  checks: CheckConstraintDefinition[];
  views: ViewDefinition[];
  triggers: TriggerDefinition[];
  domains: DomainDefinition[];
  domainConstraints: DomainConstraintDefinition[];
  composites: CompositeTypeDefinition[];
  columns: TableColumnDefinition[];
};

/** One function, view or standalone type to write, with the catalog keys it needs created first. */
type SchemaNode = {
  key: string;
  kind: "function" | "view" | "matview" | "type";
  label: string;
  statement: string;
  depends_on: string[];
};

type SchemaNodeSections = {
  /** Before the tables: functions that need no relation, so defaults, CHECKs and indexes can call them. */
  beforeTables: SchemaNode[];
  /** Right after the tables, before constraints and data: views, and functions that need a relation. */
  afterTables: SchemaNode[];
  /** After the data: materialized views (WITH DATA) and whatever depends on them. */
  afterData: SchemaNode[];
};

const DEFAULT_BACKUP_WRITE_BUFFER_BYTES = 1024 * 1024;
const BACKUP_DATA_CURSOR_ROWS = 100;
const BACKUP_CLI_STDERR_BYTES = 64 * 1024;
const BACKUP_BREAKPOINT_DETECT_BYTES = 64 * 1024;

const STATEMENT_BREAKPOINT = "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";

// AgentDash (GH #944): marks a schema statement that exists only because a
// column was added late (a deferred generated column). On-box restore runs it
// normally — it is a leading comment inside the statement's chunk — while the
// off-box replay guard (cloud/src/backups/dump-guard.ts deferredStatement)
// treats the whole chunk as skipped: the column it references is never
// created in replay, so running the constraint or index would fail.
const DEFERRED_SCHEMA_MARKER = "-- paperclip deferred schema object";

function sanitizeRestoreErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const firstLine = typeof record.message === "string"
      ? record.message.split(/\r?\n/, 1)[0]?.trim()
      : "";
    const detail = typeof record.detail === "string" ? record.detail.trim() : "";
    const severity = typeof record.severity === "string" ? record.severity.trim() : "";
    const message = firstLine || detail || (error instanceof Error ? error.message : String(error));
    return severity ? `${severity}: ${message}` : message;
  }
  return error instanceof Error ? error.message : String(error);
}

function timestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * ISO week key for grouping backups by calendar week (ISO 8601).
 */
function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Tiered backup pruning:
 * - Daily tier: keep ALL backups from the last `dailyDays` days
 * - Weekly tier: keep the NEWEST backup per calendar week for `weeklyWeeks` weeks
 * - Monthly tier: keep the NEWEST backup per calendar month for `monthlyMonths` months
 * - Everything else is deleted
 */
function pruneOldBackups(backupDir: string, retention: BackupRetentionPolicy, filenamePrefix: string): number {
  if (!existsSync(backupDir)) return 0;

  const now = Date.now();
  const dailyCutoff = now - Math.max(1, retention.dailyDays) * 24 * 60 * 60 * 1000;
  const weeklyCutoff = now - Math.max(1, retention.weeklyWeeks) * 7 * 24 * 60 * 60 * 1000;
  const monthlyCutoff = now - Math.max(1, retention.monthlyMonths) * 30 * 24 * 60 * 60 * 1000;

  type BackupEntry = { name: string; fullPath: string; mtimeMs: number };
  const entries: BackupEntry[] = [];

  for (const name of readdirSync(backupDir)) {
    if (!name.startsWith(`${filenamePrefix}-`)) continue;
    if (!name.endsWith(".sql") && !name.endsWith(".sql.gz")) continue;
    const fullPath = resolve(backupDir, name);
    const stat = statSync(fullPath);
    entries.push({ name, fullPath, mtimeMs: stat.mtimeMs });
  }

  // Sort newest first so the first entry per week/month bucket is the one we keep
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const keepWeekBuckets = new Set<string>();
  const keepMonthBuckets = new Set<string>();
  const toDelete: string[] = [];

  for (const entry of entries) {
    // Daily tier — keep everything within dailyDays
    if (entry.mtimeMs >= dailyCutoff) continue;

    const date = new Date(entry.mtimeMs);
    const week = isoWeekKey(date);
    const month = monthKey(date);

    // Weekly tier — keep newest per calendar week
    if (entry.mtimeMs >= weeklyCutoff) {
      if (keepWeekBuckets.has(week)) {
        toDelete.push(entry.fullPath);
      } else {
        keepWeekBuckets.add(week);
      }
      continue;
    }

    // Monthly tier — keep newest per calendar month
    if (entry.mtimeMs >= monthlyCutoff) {
      if (keepMonthBuckets.has(month)) {
        toDelete.push(entry.fullPath);
      } else {
        keepMonthBuckets.add(month);
      }
      continue;
    }

    // Beyond all retention tiers — delete
    toDelete.push(entry.fullPath);
  }

  for (const filePath of toDelete) {
    unlinkSync(filePath);
  }

  return toDelete.length;
}

function formatBackupSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes}B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)}K`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)}M`;
}

// AgentDash (GH #940 review): an escape-string literal instead of a
// dollar-quoted one. The `$paperclip$` tag closed early on a value ending in
// `$paperclip` ("hello $paperclip" broke the restore). E'…' with `\`, `'`, CR
// and LF escaped means the same under either standard_conforming_strings
// setting, and keeps the literal on one line, so the line-based restore can
// neither mangle a CR nor mistake part of a value for a statement breakpoint.
function formatSqlLiteral(value: string): string {
  const escaped = value
    .replace(/\u0000/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return `E'${escaped}'`;
}

function normalizeTableNameSet(values: string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map(normalizeTableSelector)
      .filter((value) => value.length > 0),
  );
}

function normalizeTableSelector(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  return trimmed.includes(".") ? trimmed : tableKey("public", trimmed);
}

function normalizeNullifyColumnMap(values: Record<string, string[]> | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!values) return out;
  for (const [tableName, columns] of Object.entries(values)) {
    const normalizedTable = normalizeTableSelector(tableName);
    if (normalizedTable.length === 0) continue;
    const normalizedColumns = new Set(
      columns
        .map((column) => column.trim())
        .filter((column) => column.length > 0),
    );
    if (normalizedColumns.size > 0) {
      out.set(normalizedTable, normalizedColumns);
    }
  }
  return out;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function quoteQualifiedName(schemaName: string, objectName: string): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(objectName)}`;
}

function tableKey(schemaName: string, tableName: string): string {
  return `${schemaName}.${tableName}`;
}

function nonSystemSchemaPredicate(identifier: string): string {
  // PostgreSQL reserves pg_ prefixes for system schemas, including temp/toast variants.
  return `${identifier} <> 'information_schema'
    AND ${identifier} NOT LIKE 'pg\\_%' ESCAPE '\\'`;
}

function hasBackupTransforms(opts: RunDatabaseBackupOptions): boolean {
  return (opts.excludeTables?.length ?? 0) > 0 ||
    Object.keys(opts.nullifyColumns ?? {}).length > 0;
}

// AgentDash (GH #940): the INSERT path reads every column as `col::text`
// (Postgres's own canonical text output) and writes it back as a literal cast
// to the column's type (`format_type(atttypid, atttypmod)`, read under
// `search_path = pg_catalog` so user types come back schema-qualified; a
// domain is cast to its base type). The text form round-trips through the
// type's input function, so bytea, `timestamp without time zone`, arrays,
// json/jsonb, numeric precision, intervals, enums and domain values are
// restored exactly. The old version turned
// postgres.js's JS values back into SQL and corrupted bytea (Buffer JSON),
// shifted naive timestamps by the host time zone and wrote arrays as JSON
// (`malformed array literal`).
function formatSqlValue(textValue: string | null | undefined, typeName: string, nullified: boolean): string {
  if (nullified || textValue === null || textValue === undefined) return "NULL";
  return `${formatSqlLiteral(textValue)}::${typeName}`;
}

function appendCapturedStderr(previous: string, chunk: Buffer | string): string {
  const next = previous + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
  if (Buffer.byteLength(next, "utf8") <= BACKUP_CLI_STDERR_BYTES) return next;
  return Buffer.from(next, "utf8").subarray(-BACKUP_CLI_STDERR_BYTES).toString("utf8");
}

async function waitForChildExit(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = appendCapturedStderr(stderr, chunk);
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (result.signal) {
    throw new Error(`${label} exited via ${result.signal}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
  if (result.code !== 0) {
    throw new Error(`${label} failed with exit code ${result.code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
}

async function runPgDumpBackup(opts: {
  connectionString: string;
  backupFile: string;
  connectTimeout: number;
}): Promise<void> {
  const pgDumpBin = process.env.PAPERCLIP_PG_DUMP_PATH || "pg_dump";
  const child = spawn(
    pgDumpBin,
    [
      `--dbname=${opts.connectionString}`,
      "--format=plain",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: String(opts.connectTimeout),
      },
    },
  );

  if (!child.stdout) {
    throw new Error("pg_dump did not expose stdout");
  }

  await Promise.all([
    pipeline(child.stdout, createGzip(), createWriteStream(opts.backupFile)),
    waitForChildExit(child, pgDumpBin),
  ]);
}

async function restoreWithPsql(opts: RunDatabaseRestoreOptions, connectTimeout: number): Promise<void> {
  const psqlBin = process.env.PAPERCLIP_PSQL_PATH || "psql";
  const child = spawn(
    psqlBin,
    [
      `--dbname=${opts.connectionString}`,
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--no-psqlrc",
    ],
    {
      stdio: ["pipe", "ignore", "pipe"],
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: String(connectTimeout),
      },
    },
  );

  if (!child.stdin) {
    throw new Error("psql did not expose stdin");
  }

  const input = opts.backupFile.endsWith(".gz")
    ? createReadStream(opts.backupFile).pipe(createGunzip())
    : createReadStream(opts.backupFile);

  await Promise.all([
    pipeline(input, child.stdin),
    waitForChildExit(child, psqlBin),
  ]);
}

async function hasStatementBreakpoints(backupFile: string): Promise<boolean> {
  const raw = createReadStream(backupFile);
  const stream = backupFile.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  let text = "";

  try {
    for await (const chunk of stream) {
      text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (text.includes(STATEMENT_BREAKPOINT)) return true;
      if (Buffer.byteLength(text, "utf8") >= BACKUP_BREAKPOINT_DETECT_BYTES) return false;
    }
    return text.includes(STATEMENT_BREAKPOINT);
  } finally {
    stream.destroy();
    raw.destroy();
  }
}

async function* readRestoreStatements(backupFile: string): AsyncGenerator<string> {
  const raw = createReadStream(backupFile);
  const stream = backupFile.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  stream.setEncoding("utf8");
  const reader = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  let statementLines: string[] = [];

  const flushStatement = () => {
    const statement = statementLines.join("\n").trim();
    statementLines = [];
    return statement;
  };

  try {
    for await (const line of reader) {
      if (line === STATEMENT_BREAKPOINT) {
        const statement = flushStatement();
        if (statement.length > 0) {
          yield statement;
        }
        continue;
      }
      statementLines.push(line);
    }

    const trailingStatement = flushStatement();
    if (trailingStatement.length > 0) {
      yield trailingStatement;
    }
  } finally {
    reader.close();
    stream.destroy();
    raw.destroy();
  }
}

// AgentDash (GH #939, #944): the pg_depend rows an expression-bearing
// catalog object (a column default, a domain's default or one of its CHECK
// constraints) records, as catalog keys: `p:<pg_proc oid>` for a called
// function, `c:<pg_class oid>` for a relation (a sequence, or a table/view's
// row type reached through a pg_type dependency — `t:<pg_type oid>` carries
// that same type's key so types can be ordered among themselves). Column- and
// auto-level rows (refobjsubid > 0, deptype 'a'/'i'/'e') are not expression
// dependencies.
function dependencyKeysSql(classid: "pg_attrdef" | "pg_constraint" | "pg_type", objidExpr: string): string {
  return `ARRAY(
    SELECT DISTINCT dep.k FROM (
      SELECT 'p:' || d.refobjid::text AS k
      FROM pg_depend d
      WHERE d.classid = '${classid}'::regclass AND d.objid = ${objidExpr}
        AND d.deptype = 'n' AND d.refclassid = 'pg_proc'::regclass AND d.refobjsubid = 0
      UNION
      SELECT 'c:' || d.refobjid::text
      FROM pg_depend d
      WHERE d.classid = '${classid}'::regclass AND d.objid = ${objidExpr}
        AND d.deptype = 'n' AND d.refclassid = 'pg_class'::regclass AND d.refobjsubid = 0
      UNION
      SELECT 't:' || d.refobjid::text
      FROM pg_depend d
      WHERE d.classid = '${classid}'::regclass AND d.objid = ${objidExpr}
        AND d.deptype = 'n' AND d.refclassid = 'pg_type'::regclass AND d.refobjsubid = 0
      UNION
      -- A dependency on a relation's ROW TYPE (or an array of one) surfaces
      -- under the relation's own key: it is only satisfied once that table,
      -- view or materialized view exists.
      SELECT 'c:' || COALESCE(NULLIF(pt.typrelid, 0), NULLIF(pet.typrelid, 0))::text
      FROM pg_depend d
      JOIN pg_type pt ON pt.oid = d.refobjid
      LEFT JOIN pg_type pet ON pet.oid = pt.typelem AND pt.typelem <> 0
      WHERE d.classid = '${classid}'::regclass AND d.objid = ${objidExpr}
        AND d.deptype = 'n' AND d.refclassid = 'pg_type'::regclass AND d.refobjsubid = 0
        AND COALESCE(NULLIF(pt.typrelid, 0), NULLIF(pet.typrelid, 0)) IS NOT NULL
    ) dep
  )`;
}

// AgentDash (GH #907): read CHECK constraints, views, functions and triggers
// from the catalog so a pg_dump-less backup is self-contained. Definitions
// come from pg_get_*def() under `search_path = pg_catalog`, so every name the
// server prints is schema-qualified (as pg_dump does) and replays correctly
// whatever search_path the restore session has. Extension-owned objects are
// left to CREATE EXTENSION.
//
// AgentDash (GH #944): also domains, their constraints, standalone composite
// types and table columns. Column types come from format_type(atttypid,
// atttypmod) rather than information_schema: exact for every typmod
// (timestamp(3), bit(n), interval fields) and for user-defined types
// (domains, composites and arrays of them).
async function readSchemaObjectDefinitions(sql: ReturnType<typeof postgres>): Promise<SchemaObjectDefinitions> {
  await sql`SELECT set_config('search_path', 'pg_catalog', false)`;
  try {
    // A function's dependencies, from pg_depend: relations it names (a
    // BEGIN ATOMIC body records them), the relation behind any row type in its
    // signature (array element types included), and other functions.
    const functions = await sql<FunctionDefinition[]>`
      SELECT p.oid::text AS oid,
             n.nspname AS schema_name,
             p.proname AS function_name,
             pg_get_functiondef(p.oid) AS definition,
             ARRAY(
               SELECT DISTINCT dep.k FROM (
                 SELECT 'c:' || d.refobjid::text AS k
                 FROM pg_depend d
                 WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                   AND d.refclassid = 'pg_class'::regclass
                 UNION
                 SELECT 'c:' || (CASE WHEN t.typrelid <> 0 THEN t.typrelid ELSE et.typrelid END)::text
                 FROM pg_depend d
                 JOIN pg_type t ON t.oid = d.refobjid
                 LEFT JOIN pg_type et ON et.oid = t.typelem AND t.typelem <> 0
                 WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                   AND d.refclassid = 'pg_type'::regclass
                   AND (t.typrelid <> 0 OR coalesce(et.typrelid, 0) <> 0)
                 UNION
                 SELECT 'p:' || d.refobjid::text
                 FROM pg_depend d
                 WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                   AND d.refclassid = 'pg_proc'::regclass AND d.refobjid <> p.oid
               ) dep
             ) AS depends_on
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
        AND p.prokind IN ('f', 'p')
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
        )
      ORDER BY n.nspname, p.proname, p.oid
    `;
    const checks = await sql<CheckConstraintDefinition[]>`
      SELECT n.nspname AS schema_name,
             t.relname AS tablename,
             c.conname AS constraint_name,
             pg_get_constraintdef(c.oid) AS definition,
             c.convalidated AS validated,
             COALESCE(
               (SELECT array_agg(a.attname ORDER BY array_position(c.conkey, a.attnum))
                FROM pg_attribute a
                WHERE a.attrelid = t.oid AND a.attnum = ANY(c.conkey)),
               '{}'
             ) AS column_names
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'c'
        AND c.conislocal
        AND t.relkind IN ('r', 'p')
        AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      ORDER BY n.nspname, t.relname, c.conname
    `;
    const views = await sql<ViewDefinition[]>`
      SELECT v.oid::text AS oid,
             n.nspname AS schema_name,
             v.relname AS view_name,
             v.relkind::text AS relkind,
             pg_get_viewdef(v.oid) AS definition,
             v.reloptions::text[] AS reloptions,
             ARRAY(
               SELECT DISTINCT (CASE WHEN d.refclassid = 'pg_class'::regclass THEN 'c:' ELSE 'p:' END) || d.refobjid::text
               FROM pg_rewrite r
               JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
               WHERE r.ev_class = v.oid
                 AND d.refclassid IN ('pg_class'::regclass, 'pg_proc'::regclass)
                 AND NOT (d.refclassid = 'pg_class'::regclass AND d.refobjid = v.oid)
             ) AS depends_on
      FROM pg_class v
      JOIN pg_namespace n ON n.oid = v.relnamespace
      WHERE v.relkind IN ('v', 'm')
        AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass AND d.objid = v.oid AND d.deptype = 'e'
        )
      ORDER BY n.nspname, v.relname
    `;
    const triggers = await sql<TriggerDefinition[]>`
      SELECT n.nspname AS schema_name,
             c.relname AS tablename,
             t.tgname AS trigger_name,
             pg_get_triggerdef(t.oid) AS definition,
             t.tgenabled::text AS enabled
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal
        AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      ORDER BY n.nspname, c.relname, t.tgname
    `;
    // AgentDash (GH #944): user-defined domains, recreated before the tables
    // so a column keeps the domain instead of silently degrading to the base
    // type. Validated CHECK constraints go inline in CREATE DOMAIN (PostgreSQL
    // refuses ALTER DOMAIN … ADD CONSTRAINT once a column of an array of the
    // domain exists); only NOT VALID constraints or ones needing a later
    // object wait for a post-data ALTER DOMAIN, like the deferred defaults.
    const domains = await sql<DomainDefinition[]>`
      SELECT t.oid::text AS oid,
             n.nspname AS schema_name,
             t.typname AS domain_name,
             format_type(t.typbasetype, t.typtypmod) AS base_type,
             t.typnotnull AS not_null,
             CASE WHEN t.typcollation <> 0 AND t.typcollation <> bt.typcollation
                  THEN quote_ident(cn.nspname) || '.' || quote_ident(co.collname)
                  ELSE NULL END AS collation,
             CASE WHEN t.typdefaultbin IS NOT NULL THEN pg_get_expr(t.typdefaultbin, 0) END AS default_expr,
             ${sql.unsafe(dependencyKeysSql("pg_type", "t.oid"))} AS depends_on
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_type bt ON bt.oid = t.typbasetype
      LEFT JOIN pg_collation co ON co.oid = t.typcollation
      LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
      WHERE t.typtype = 'd'
        AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e'
        )
      ORDER BY n.nspname, t.typname
    `;
    const domainConstraints = await sql<DomainConstraintDefinition[]>`
      SELECT n.nspname AS schema_name,
             t.typname AS domain_name,
             c.conname AS constraint_name,
             pg_get_constraintdef(c.oid) AS definition,
             c.convalidated AS validated,
             ${sql.unsafe(dependencyKeysSql("pg_constraint", "c.oid"))} AS depends_on
      FROM pg_constraint c
      JOIN pg_type t ON t.oid = c.contypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE c.contypid <> 0
        AND c.contype = 'c'
        AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_constraint'::regclass AND d.objid = c.oid AND d.deptype = 'e'
        )
      ORDER BY n.nspname, t.typname, c.conname
    `;
    // AgentDash (GH #944): standalone composite types (a pg_class of relkind
    // 'c' behind the pg_type — table row types are typrelid'd to a relkind
    // 'r'/'v'/… relation and must never be recreated). One row per attribute.
    const compositeAttributes = await sql<{
      oid: string;
      class_oid: string;
      schema_name: string;
      type_name: string;
      attribute_name: string;
      attribute_type: string;
      attribute_collation: string | null;
      attr_type_oid: string;
      elem_type_oid: string | null;
    }[]>`
      SELECT t.oid::text AS oid,
             t.typrelid::text AS class_oid,
             n.nspname AS schema_name,
             t.typname AS type_name,
             a.attname AS attribute_name,
             format_type(a.atttypid, a.atttypmod) AS attribute_type,
             CASE WHEN a.attcollation <> 0 AND a.attcollation <> at.typcollation
                  THEN quote_ident(cn.nspname) || '.' || quote_ident(co.collname)
                  ELSE NULL END AS attribute_collation,
             a.atttypid::text AS attr_type_oid,
             CASE WHEN at.typelem <> 0 THEN at.typelem::text ELSE NULL END AS elem_type_oid
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_class tc ON tc.oid = t.typrelid AND tc.relkind = 'c'
      JOIN pg_attribute a ON a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped
      JOIN pg_type at ON at.oid = a.atttypid
      LEFT JOIN pg_collation co ON co.oid = a.attcollation
      LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace
      WHERE t.typtype = 'c'
        AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e'
        )
      ORDER BY n.nspname, t.typname, a.attnum
    `;
    const compositeByOid = new Map<string, CompositeTypeDefinition>();
    for (const row of compositeAttributes) {
      let composite = compositeByOid.get(row.oid);
      if (!composite) {
        composite = {
          oid: row.oid,
          class_oid: row.class_oid,
          schema_name: row.schema_name,
          type_name: row.type_name,
          attributes: [],
          depends_on: [],
        };
        compositeByOid.set(row.oid, composite);
      }
      composite.attributes.push({
        attribute_name: row.attribute_name,
        attribute_type: row.attribute_type,
        collation: row.attribute_collation,
      });
      for (const typeOid of [row.attr_type_oid, row.elem_type_oid]) {
        const key = `t:${typeOid}`;
        if (typeOid && typeOid !== row.oid && !composite.depends_on.includes(key)) {
          composite.depends_on.push(key);
        }
      }
    }
    const composites = [...compositeByOid.values()];
    // AgentDash (GH #939, #944): every visible column of every user table
    // (relkind 'r' or 'p'), with the catalog-exact type and default and the
    // default's dependencies — the latter decides whether the default can be
    // emitted inline or must defer to a post-function ALTER TABLE … SET DEFAULT.
    const columns = await sql<TableColumnDefinition[]>`
      SELECT n.nspname AS schema_name,
             c.relname AS tablename,
             a.attname AS column_name,
             format_type(a.atttypid, a.atttypmod) AS type_name,
             a.attnotnull AS not_null,
             a.attgenerated::text AS generated,
             CASE WHEN a.attgenerated <> '' AND ad.oid IS NOT NULL
                  THEN pg_get_expr(ad.adbin, ad.adrelid) END AS generated_expr,
             CASE WHEN a.attgenerated = '' AND ad.oid IS NOT NULL
                  THEN pg_get_expr(ad.adbin, ad.adrelid) END AS column_default,
             ${sql.unsafe(dependencyKeysSql("pg_attrdef", "ad.oid"))} AS default_depends_on
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE c.relkind IN ('r', 'p')
        AND a.attnum > 0 AND NOT a.attisdropped
        AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      ORDER BY n.nspname, c.relname, a.attnum
    `;
    return {
      functions: [...functions],
      checks: [...checks],
      views: [...views],
      triggers: [...triggers],
      domains: [...domains],
      domainConstraints: [...domainConstraints],
      composites,
      columns: [...columns],
    };
  } finally {
    await sql`RESET search_path`;
  }
}

/**
 * AgentDash (GH #907): an identifier inside a `--` comment. A quoted name may
 * contain a newline, which would end the comment and turn the rest of the
 * name into SQL on restore; pg_dump replaces CR and LF the same way.
 */
function commentSafe(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}

function stripTrailingSemicolon(definition: string): string {
  return definition.trim().replace(/;+\s*$/, "").trimEnd();
}

function viewStatement(view: ViewDefinition): string {
  const name = quoteQualifiedName(view.schema_name, view.view_name);
  const options = view.reloptions && view.reloptions.length > 0 ? ` WITH (${view.reloptions.join(", ")})` : "";
  const body = stripTrailingSemicolon(view.definition);
  return view.relkind === "m"
    ? `CREATE MATERIALIZED VIEW ${name}${options} AS\n${body}\nWITH DATA;`
    : `CREATE OR REPLACE VIEW ${name}${options} AS\n${body};`;
}

// AgentDash (GH #944): CREATE TYPE … AS (…) for a standalone composite —
// table row types are excluded by the relkind = 'c' check in the query.
function compositeCreateStatement(composite: CompositeTypeDefinition): string {
  const attributes = composite.attributes.map((attribute) =>
    `${quoteIdentifier(attribute.attribute_name)} ${attribute.attribute_type}${attribute.collation ? ` COLLATE ${attribute.collation}` : ""}`,
  );
  return `CREATE TYPE ${quoteQualifiedName(composite.schema_name, composite.type_name)} AS (${attributes.join(", ")});`;
}

// AgentDash (GH #944): CREATE DOMAIN carrying the base type (with its typmod),
// collation, NOT NULL, validated CHECK constraints and — when the default's
// dependencies are already in place — the default. Constraints go inline
// whenever possible: ALTER DOMAIN … ADD CONSTRAINT is rejected entirely once a
// column of an ARRAY of the domain exists, so deferring a constraint that did
// not need to wait would break restore.
function domainCreateStatement(
  domain: DomainDefinition,
  emitDefault: boolean,
  constraints: DomainConstraintDefinition[],
): string {
  let statement = `CREATE DOMAIN ${quoteQualifiedName(domain.schema_name, domain.domain_name)} AS ${domain.base_type}`;
  if (domain.collation) statement += ` COLLATE ${domain.collation}`;
  if (emitDefault && domain.default_expr != null) statement += ` DEFAULT ${domain.default_expr}`;
  for (const constraint of constraints) {
    statement += ` CONSTRAINT ${quoteIdentifier(constraint.constraint_name)} ${constraint.definition}`;
  }
  if (domain.not_null) statement += ` NOT NULL`;
  return `${statement};`;
}

/** Each node after the nodes it depends on (depth-first; dependencies outside `nodes` already exist). */
function orderByDependency(nodes: SchemaNode[]): SchemaNode[] {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const ordered: SchemaNode[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (node: SchemaNode) => {
    if (state.has(node.key)) return;
    state.set(node.key, "visiting");
    for (const dep of node.depends_on) {
      const target = byKey.get(dep);
      if (target) visit(target);
    }
    state.set(node.key, "done");
    ordered.push(node);
  };
  for (const node of nodes) visit(node);
  return ordered;
}

/**
 * AgentDash (GH #907): place every function and view in the earliest section
 * where what it needs already exists, then order each section by dependency.
 *   - a materialized view needs the data (it is created WITH DATA);
 *   - a function or view that needs a relation (a table's or a view's row
 *     type, or a BEGIN ATOMIC body that reads one) waits until after the tables;
 *   - anything that needs a later node moves to that node's section.
 */
function planSchemaNodes(functions: FunctionDefinition[], views: ViewDefinition[]): SchemaNodeSections {
  const nodes: SchemaNode[] = [
    ...functions.map((fn): SchemaNode => ({
      key: `p:${fn.oid}`,
      kind: "function",
      label: `Function: ${commentSafe(`${fn.schema_name}.${fn.function_name}`)}`,
      statement: `${stripTrailingSemicolon(fn.definition)};`,
      depends_on: fn.depends_on,
    })),
    ...views.map((view): SchemaNode => ({
      key: `c:${view.oid}`,
      kind: view.relkind === "m" ? "matview" : "view",
      label: `${view.relkind === "m" ? "Materialized view" : "View"}: ${commentSafe(`${view.schema_name}.${view.view_name}`)}`,
      statement: viewStatement(view),
      depends_on: view.depends_on,
    })),
  ];
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const rank = new Map<string, number>();
  for (const node of nodes) {
    const needsRelation = node.kind !== "function" || node.depends_on.some((dep) => dep.startsWith("c:"));
    rank.set(node.key, node.kind === "matview" ? 2 : needsRelation ? 1 : 0);
  }
  // Raise each node to the latest section among its dependencies, until stable.
  for (let changed = true; changed;) {
    changed = false;
    for (const node of nodes) {
      let next = rank.get(node.key)!;
      for (const dep of node.depends_on) {
        if (byKey.has(dep)) next = Math.max(next, rank.get(dep)!);
      }
      if (next !== rank.get(node.key)) {
        rank.set(node.key, next);
        changed = true;
      }
    }
  }
  const section = (r: number) => orderByDependency(nodes.filter((node) => rank.get(node.key) === r));
  return { beforeTables: section(0), afterTables: section(1), afterData: section(2) };
}

function foreignKeyStatement(fk: {
  constraint_name: string;
  source_schema: string;
  source_table: string;
  source_columns: string[];
  target_schema: string;
  target_table: string;
  target_columns: string[];
  update_rule: string;
  delete_rule: string;
}): string {
  const srcCols = fk.source_columns.map((c) => `"${c}"`).join(", ");
  const tgtCols = fk.target_columns.map((c) => `"${c}"`).join(", ");
  return `ALTER TABLE ${quoteQualifiedName(fk.source_schema, fk.source_table)} ADD CONSTRAINT "${fk.constraint_name}" FOREIGN KEY (${srcCols}) REFERENCES ${quoteQualifiedName(fk.target_schema, fk.target_table)} (${tgtCols}) ON UPDATE ${fk.update_rule} ON DELETE ${fk.delete_rule};`;
}

function uniqueConstraintStatement(u: {
  constraint_name: string;
  schema_name: string;
  tablename: string;
  column_names: string[];
  nulls_not_distinct: boolean;
}): string {
  const cols = u.column_names.map((c) => `"${c}"`).join(", ");
  return `ALTER TABLE ${quoteQualifiedName(u.schema_name, u.tablename)} ADD CONSTRAINT "${u.constraint_name}" UNIQUE${u.nulls_not_distinct ? " NULLS NOT DISTINCT" : ""} (${cols});`;
}

/** AgentDash (GH #907): pg_get_triggerdef does not carry tgenabled; restore it when it is not the default. */
function triggerEnableStatement(trigger: TriggerDefinition): string | null {
  const action = { D: "DISABLE TRIGGER", R: "ENABLE REPLICA TRIGGER", A: "ENABLE ALWAYS TRIGGER" }[trigger.enabled as "D" | "R" | "A"];
  if (!action) return null;
  return `ALTER TABLE ${quoteQualifiedName(trigger.schema_name, trigger.tablename)} ${action} ${quoteIdentifier(trigger.trigger_name)};`;
}

export function createBufferedTextFileWriter(filePath: string, maxBufferedBytes = DEFAULT_BACKUP_WRITE_BUFFER_BYTES) {
  const filePromise = openFile(filePath, "w");
  const flushThreshold = Math.max(1, Math.trunc(maxBufferedBytes));
  let bufferedLines: string[] = [];
  let bufferedBytes = 0;
  let firstChunk = true;
  let closed = false;
  let pendingWrite = Promise.resolve();

  const writeChunk = async (chunk: string | Buffer): Promise<void> => {
    const file = await filePromise;
    if (typeof chunk === "string") {
      await file.write(chunk, null, "utf8");
    } else {
      await file.write(chunk);
    }
  };

  const flushBufferedLines = () => {
    if (bufferedLines.length === 0) return;
    const linesToWrite = bufferedLines;
    bufferedLines = [];
    bufferedBytes = 0;
    const chunkBody = linesToWrite.join("\n");
    const chunk = firstChunk ? chunkBody : `\n${chunkBody}`;
    firstChunk = false;
    pendingWrite = pendingWrite.then(() => writeChunk(chunk));
  };

  return {
    emit(line: string) {
      if (closed) {
        throw new Error(`Cannot write to closed backup file: ${filePath}`);
      }
      bufferedLines.push(line);
      bufferedBytes += Buffer.byteLength(line, "utf8") + 1;
      if (bufferedBytes >= flushThreshold) {
        flushBufferedLines();
      }
    },
    async drain() {
      if (closed) {
        throw new Error(`Cannot drain closed backup file: ${filePath}`);
      }
      flushBufferedLines();
      await pendingWrite;
    },
    async writeRaw(chunk: string | Buffer) {
      if (closed) {
        throw new Error(`Cannot write to closed backup file: ${filePath}`);
      }
      flushBufferedLines();
      firstChunk = false;
      pendingWrite = pendingWrite.then(() => writeChunk(chunk));
      await pendingWrite;
    },
    async close() {
      if (closed) return;
      closed = true;
      flushBufferedLines();
      await pendingWrite;
      const file = await filePromise;
      await file.close();
    },
    async abort() {
      if (closed) return;
      closed = true;
      bufferedLines = [];
      bufferedBytes = 0;
      await pendingWrite.catch(() => {});
      await filePromise.then((file) => file.close()).catch(() => {});
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
        } catch {
          // Preserve the original backup failure if temporary file cleanup also fails.
        }
      }
    },
  };
}

export async function runDatabaseBackup(opts: RunDatabaseBackupOptions): Promise<RunDatabaseBackupResult> {
  const filenamePrefix = opts.filenamePrefix ?? "paperclip";
  const retention = opts.retention;
  const connectTimeout = Math.max(1, Math.trunc(opts.connectTimeoutSeconds ?? 5));
  const backupEngine = opts.backupEngine ?? "auto";
  const canUsePgDump = !hasBackupTransforms(opts);
  const excludedTableNames = normalizeTableNameSet(opts.excludeTables);
  const nullifiedColumnsByTable = normalizeNullifyColumnMap(opts.nullifyColumns);
  let sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });
  let sqlClosed = false;
  const closeSql = async () => {
    if (sqlClosed) return;
    sqlClosed = true;
    await sql.end();
  };
  mkdirSync(opts.backupDir, { recursive: true });
  const sqlFile = resolve(opts.backupDir, `${filenamePrefix}-${timestamp()}.sql`);
  const backupFile = `${sqlFile}.gz`;
  const writer = createBufferedTextFileWriter(sqlFile);

  try {
    if (backupEngine === "pg_dump" || (backupEngine === "auto" && canUsePgDump)) {
      await sql`SELECT 1`;
      try {
        await closeSql();
        await runPgDumpBackup({
          connectionString: opts.connectionString,
          backupFile,
          connectTimeout,
        });
        await writer.abort();
        const sizeBytes = statSync(backupFile).size;
        const prunedCount = pruneOldBackups(opts.backupDir, retention, filenamePrefix);
        return {
          backupFile,
          sizeBytes,
          prunedCount,
        };
      } catch (error) {
        if (existsSync(backupFile)) {
          try { unlinkSync(backupFile); } catch { /* ignore */ }
        }
        if (backupEngine === "pg_dump") {
          throw error;
        }
        sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });
        sqlClosed = false;
      }
    }

    await sql`SELECT 1`;

    const emit = (line: string) => writer.emit(line);
    const emitStatement = (statement: string) => {
      emit(statement);
      emit(STATEMENT_BREAKPOINT);
    };
    const emitStatementBoundary = () => {
      emit(STATEMENT_BREAKPOINT);
    };

    emit("-- Paperclip database backup");
    emit(`-- Created: ${new Date().toISOString()}`);
    emit("");
    emitStatement("BEGIN;");
    emitStatement("SET LOCAL session_replication_role = replica;");
    emitStatement("SET LOCAL client_min_messages = warning;");
    emit("");

    const allTables = await sql<TableDefinition[]>`
      SELECT table_schema AS schema_name, table_name AS tablename
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND ${sql.unsafe(nonSystemSchemaPredicate("table_schema"))}
      ORDER BY table_schema, table_name
    `;
    const tables = allTables;
    const includedTableNames = new Set(tables.map(({ schema_name, tablename }) => tableKey(schema_name, tablename)));
    const includedSchemas = new Set(tables.map(({ schema_name }) => schema_name));

    // AgentDash (GH #907): CHECK constraints, views, functions and triggers,
    // read once up front and emitted below in dependency-safe order.
    const schemaObjects = await readSchemaObjectDefinitions(sql);
    const schemaNodes = planSchemaNodes(schemaObjects.functions, schemaObjects.views);
    const checkConstraints = schemaObjects.checks.filter((check) => includedTableNames.has(tableKey(check.schema_name, check.tablename)));
    const views = schemaObjects.views;
    const viewNames = new Set(views.map((view) => tableKey(view.schema_name, view.view_name)));
    const triggers = schemaObjects.triggers.filter((trigger) => {
      const key = tableKey(trigger.schema_name, trigger.tablename);
      return includedTableNames.has(key) || viewNames.has(key);
    });
    for (const fn of schemaObjects.functions) includedSchemas.add(fn.schema_name);
    for (const view of views) includedSchemas.add(view.schema_name);
    // AgentDash (GH #944): a domain or composite type may be the only object
    // living in its schema.
    for (const domain of schemaObjects.domains) includedSchemas.add(domain.schema_name);
    for (const composite of schemaObjects.composites) includedSchemas.add(composite.schema_name);
    const emitSchemaNodes = (heading: string, nodes: SchemaNode[]) => {
      if (nodes.length === 0) return;
      emit(`-- ${heading}`);
      for (const node of nodes) {
        emit(`-- ${node.label}`);
        emitStatement(node.statement);
      }
      emit("");
    };
    if (schemaObjects.functions.length > 0) {
      // Function bodies are checked when they run, not when they are created,
      // so a body may name tables that the restore creates later (pg_dump does
      // the same).
      emitStatement("SET LOCAL check_function_bodies = false;");
      emit("");
    }

    // Get all enums
    const enums = await sql<{ schema_name: string; typname: string; labels: string[] }[]>`
      SELECT n.nspname AS schema_name, t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON t.typnamespace = n.oid
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      GROUP BY n.nspname, t.typname
      ORDER BY n.nspname, t.typname
    `;
    for (const e of enums) includedSchemas.add(e.schema_name);

    const allSequences = await sql<SequenceDefinition[]>`
      SELECT
        seq.oid::text AS sequence_oid,
        s.sequence_schema,
        s.sequence_name,
        s.data_type,
        s.start_value,
        s.minimum_value,
        s.maximum_value,
        s.increment,
        s.cycle_option,
        tblns.nspname AS owner_schema,
        tbl.relname AS owner_table,
        attr.attname AS owner_column
      FROM information_schema.sequences s
      JOIN pg_class seq ON seq.relname = s.sequence_name
      JOIN pg_namespace n ON n.oid = seq.relnamespace AND n.nspname = s.sequence_schema
      LEFT JOIN pg_depend dep ON dep.objid = seq.oid AND dep.deptype = 'a'
      LEFT JOIN pg_class tbl ON tbl.oid = dep.refobjid
      LEFT JOIN pg_namespace tblns ON tblns.oid = tbl.relnamespace
      LEFT JOIN pg_attribute attr ON attr.attrelid = tbl.oid AND attr.attnum = dep.refobjsubid
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("s.sequence_schema"))}
      ORDER BY s.sequence_schema, s.sequence_name
    `;
    const sequences = allSequences.filter(
      (seq) => !seq.owner_table || includedTableNames.has(tableKey(seq.owner_schema ?? "public", seq.owner_table)),
    );

    // AgentDash (GH #939, #944): a column default, generation expression or
    // domain default goes inline in CREATE TABLE/DOMAIN only when everything
    // it touches already exists at table-creation time. That rules out ANY
    // function this dump emits (even one in the pre-table section — off-box
    // replay never runs the functions, so an inline DEFAULT public.f() could
    // not be recreated there) and any relation outside the pre-table set
    // (sequences and the hidden pg_class rows behind standalone composites;
    // 't:' keys — enums, domains, composites — are all pre-table already).
    // Everything else waits for a post-table/post-data ALTER, exactly as
    // pg_dump emits a default that calls a later function.
    const emittedFunctionOids = new Set(schemaObjects.functions.map((fn) => fn.oid));
    const preTableClassOids = new Set<string>([
      ...sequences.map((seq) => seq.sequence_oid),
      ...schemaObjects.composites.map((composite) => composite.class_oid),
    ]);
    const hasPostTableDependency = (depends_on: string[]) =>
      depends_on.some((dep) =>
        dep.startsWith("p:")
          ? emittedFunctionOids.has(dep.slice(2))
          : dep.startsWith("c:") && !preTableClassOids.has(dep.slice(2)),
      );
    // A generation expression waits whenever the default rule does, and also
    // when it calls ANY function (pg_catalog's included): on off-box replay an
    // inline expression the guard cannot allowlist would refuse the whole
    // dump, while the deferred ALTER TABLE … ADD COLUMN is simply skipped —
    // and on-box it still works, computing values for already-loaded rows.
    const generatedNeedsLateEmission = (depends_on: string[]) =>
      hasPostTableDependency(depends_on) || depends_on.some((dep) => dep.startsWith("p:"));

    const schemas = new Set<string>(includedSchemas);
    for (const seq of sequences) schemas.add(seq.sequence_schema);
    const extraSchemas = [...schemas].filter((schemaName) => schemaName !== "public");
    if (extraSchemas.length > 0) {
      emit("-- Schemas");
      for (const schemaName of extraSchemas) {
        emitStatement(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)};`);
      }
      emit("");
    }

    for (const e of enums) {
      const labels = e.labels.map((l) => `'${l.replace(/'/g, "''")}'`).join(", ");
      emitStatement(`CREATE TYPE ${quoteQualifiedName(e.schema_name, e.typname)} AS ENUM (${labels});`);
    }
    if (enums.length > 0) emit("");

    const extensions = await sql<ExtensionDefinition[]>`
      SELECT
        e.extname AS extension_name,
        n.nspname AS schema_name
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname <> 'plpgsql'
      ORDER BY e.extname
    `;
    if (extensions.length > 0) {
      emit("-- Extensions");
      for (const extension of extensions) {
        emitStatement(
          `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension.extension_name)} WITH SCHEMA ${quoteIdentifier(extension.schema_name)};`,
        );
      }
      emit("");
    }

    // AgentDash (GH #944): standalone composite types and domains, ordered
    // among themselves (a composite attribute may use a domain, a domain may
    // be built on either), before anything that can name them — functions'
    // signatures included. Domain CHECK constraints ride inside CREATE DOMAIN
    // whenever they can — PostgreSQL refuses ALTER DOMAIN once a column of an
    // array of the domain exists, so a constraint only waits for a later
    // ALTER DOMAIN when it is NOT VALID or its expression needs an object
    // emitted after the tables (GH #939).
    const deferredDomainDefaults: DomainDefinition[] = [];
    const deferredDomainConstraints: DomainConstraintDefinition[] = [];
    const typeNodes: SchemaNode[] = [
      ...schemaObjects.composites.map((composite): SchemaNode => ({
        key: `t:${composite.oid}`,
        kind: "type",
        label: `Type: ${commentSafe(`${composite.schema_name}.${composite.type_name}`)}`,
        statement: compositeCreateStatement(composite),
        depends_on: composite.depends_on.filter((dep) => dep.startsWith("t:")),
      })),
      ...schemaObjects.domains.map((domain): SchemaNode => {
        const emitDefault = domain.default_expr != null && !hasPostTableDependency(domain.depends_on);
        if (domain.default_expr != null && !emitDefault) deferredDomainDefaults.push(domain);
        const inlineConstraints: DomainConstraintDefinition[] = [];
        for (const constraint of schemaObjects.domainConstraints) {
          const belongsToDomain =
            constraint.schema_name === domain.schema_name && constraint.domain_name === domain.domain_name;
          if (!belongsToDomain) continue;
          if (constraint.validated && !hasPostTableDependency(constraint.depends_on)) {
            inlineConstraints.push(constraint);
          } else {
            deferredDomainConstraints.push(constraint);
          }
        }
        return {
          key: `t:${domain.oid}`,
          kind: "type",
          label: `Domain: ${commentSafe(`${domain.schema_name}.${domain.domain_name}`)}`,
          statement: domainCreateStatement(domain, emitDefault, inlineConstraints),
          // Inline constraints' type dependencies order the domain after any
          // type their CHECK expression names (its own key excluded).
          depends_on: [
            ...domain.depends_on.filter((dep) => dep.startsWith("t:")),
            ...inlineConstraints.flatMap((constraint) =>
              constraint.depends_on.filter((dep) => dep.startsWith("t:") && dep !== `t:${domain.oid}`)),
          ],
        };
      }),
    ];
    emitSchemaNodes("Types", orderByDependency(typeNodes));

    // AgentDash (GH #907): functions that need no relation go before the
    // tables, so column defaults, CHECK constraints and index expressions can
    // call them (see planSchemaNodes for the other sections).
    emitSchemaNodes("Functions", schemaNodes.beforeTables);

    if (sequences.length > 0) {
      emit("-- Sequences");
      for (const seq of sequences) {
        const qualifiedSequenceName = quoteQualifiedName(seq.sequence_schema, seq.sequence_name);
        emitStatement(`DROP SEQUENCE IF EXISTS ${qualifiedSequenceName} CASCADE;`);
        emitStatement(
          `CREATE SEQUENCE ${qualifiedSequenceName} AS ${seq.data_type} INCREMENT BY ${seq.increment} MINVALUE ${seq.minimum_value} MAXVALUE ${seq.maximum_value} START WITH ${seq.start_value}${seq.cycle_option === "YES" ? " CYCLE" : " NO CYCLE"};`,
        );
      }
      emit("");
    }

    // AgentDash (GH #944): columns were read from pg_attribute up front in
    // readSchemaObjectDefinitions — group them per table (already in attnum
    // order). format_type keeps every typmod and resolves domains, composite
    // types and arrays of them to valid, schema-qualified spellings.
    const columnsByTable = new Map<string, TableColumnDefinition[]>();
    for (const column of schemaObjects.columns) {
      const key = tableKey(column.schema_name, column.tablename);
      const list = columnsByTable.get(key);
      if (list) list.push(column);
      else columnsByTable.set(key, [column]);
    }
    // AgentDash (GH #939, #944): what could not go inline in CREATE TABLE is
    // emitted after the data, once every function and relation exists —
    // generated columns added by ALTER TABLE … ADD COLUMN, and defaults set
    // by ALTER TABLE … ALTER COLUMN … SET DEFAULT, the way pg_dump emits a
    // default that calls a later function.
    const deferredColumns: { schema_name: string; tablename: string; definition: string }[] = [];
    const deferredColumnNamesByTable = new Map<string, Set<string>>();
    const deferredDefaults: { schema_name: string; tablename: string; column_name: string; column_default: string }[] = [];
    const deferredPrimaryKeys: { schema_name: string; tablename: string; constraint_name: string; column_names: string[] }[] = [];

    // Get full CREATE TABLE DDL via column info
    for (const { schema_name, tablename } of tables) {
      const qualifiedTableName = quoteQualifiedName(schema_name, tablename);
      const currentTableKey = tableKey(schema_name, tablename);
      const columns = columnsByTable.get(currentTableKey) ?? [];

      emit(`-- Table: ${commentSafe(`${schema_name}.${tablename}`)}`);
      emitStatement(`DROP TABLE IF EXISTS ${qualifiedTableName} CASCADE;`);

      const deferredColumnNames = new Set<string>();
      const colDefs: string[] = [];
      for (const col of columns) {
        let def = `"${col.column_name}" ${col.type_name}`;
        let deferColumn = false;
        if (col.generated !== "") {
          def += ` GENERATED ALWAYS AS (${col.generated_expr}) ${col.generated === "s" ? "STORED" : "VIRTUAL"}`;
          deferColumn = generatedNeedsLateEmission(col.default_depends_on);
        } else if (col.column_default != null) {
          // AgentDash (GH #939): a default that calls a function the dump has
          // not emitted yet cannot go inline — the restore would fail before
          // the function exists.
          if (hasPostTableDependency(col.default_depends_on)) {
            deferredDefaults.push({
              schema_name,
              tablename,
              column_name: col.column_name,
              column_default: col.column_default,
            });
          } else {
            def += ` DEFAULT ${col.column_default}`;
          }
        }
        if (col.not_null) def += " NOT NULL";
        if (deferColumn) {
          deferredColumnNames.add(col.column_name);
          deferredColumns.push({ schema_name, tablename, definition: def });
        } else {
          colDefs.push(`  ${def}`);
        }
      }
      if (deferredColumnNames.size > 0) deferredColumnNamesByTable.set(currentTableKey, deferredColumnNames);

      // Primary key — deferred with the columns it references.
      const pk = await sql<{ constraint_name: string; column_names: string[] }[]>`
        SELECT c.conname AS constraint_name,
               array_agg(a.attname ORDER BY array_position(c.conkey, a.attnum)) AS column_names
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
        WHERE n.nspname = ${schema_name} AND t.relname = ${tablename} AND c.contype = 'p'
        GROUP BY c.conname
      `;
      for (const p of pk) {
        const cols = p.column_names.map((c) => `"${c}"`).join(", ");
        if (p.column_names.some((name) => deferredColumnNames.has(name))) {
          deferredPrimaryKeys.push({ schema_name, tablename, constraint_name: p.constraint_name, column_names: p.column_names });
        } else {
          colDefs.push(`  CONSTRAINT "${p.constraint_name}" PRIMARY KEY (${cols})`);
        }
      }

      emit(`CREATE TABLE ${qualifiedTableName} (`);
      emit(colDefs.join(",\n"));
      emit(");");
      emitStatementBoundary();
      emit("");
    }

    // AgentDash (GH #907): views, and functions that need a relation (a row
    // type in the signature, or a BEGIN ATOMIC body that reads a table or
    // view), each after what it depends on.
    emitSchemaNodes("Views and functions that use relations", schemaNodes.afterTables);

    const ownedSequences = sequences.filter((seq) => seq.owner_table && seq.owner_column);
    if (ownedSequences.length > 0) {
      emit("-- Sequence ownership");
      for (const seq of ownedSequences) {
        emitStatement(
          `ALTER SEQUENCE ${quoteQualifiedName(seq.sequence_schema, seq.sequence_name)} OWNED BY ${quoteQualifiedName(seq.owner_schema ?? "public", seq.owner_table!)}.${quoteIdentifier(seq.owner_column!)};`,
        );
      }
      emit("");
    }

    // Foreign keys (after all tables created)
    const allForeignKeys = await sql<{
      constraint_name: string;
      source_schema: string;
      source_table: string;
      source_columns: string[];
      target_schema: string;
      target_table: string;
      target_columns: string[];
      update_rule: string;
      delete_rule: string;
    }[]>`
      SELECT
        c.conname AS constraint_name,
        srcn.nspname AS source_schema,
        src.relname AS source_table,
        array_agg(sa.attname ORDER BY array_position(c.conkey, sa.attnum)) AS source_columns,
        tgtn.nspname AS target_schema,
        tgt.relname AS target_table,
        array_agg(ta.attname ORDER BY array_position(c.confkey, ta.attnum)) AS target_columns,
        CASE c.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS update_rule,
        CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS delete_rule
      FROM pg_constraint c
      JOIN pg_class src ON src.oid = c.conrelid
      JOIN pg_namespace srcn ON srcn.oid = src.relnamespace
      JOIN pg_class tgt ON tgt.oid = c.confrelid
      JOIN pg_namespace tgtn ON tgtn.oid = tgt.relnamespace
      JOIN pg_attribute sa ON sa.attrelid = src.oid AND sa.attnum = ANY(c.conkey)
      JOIN pg_attribute ta ON ta.attrelid = tgt.oid AND ta.attnum = ANY(c.confkey)
      WHERE c.contype = 'f'
        AND ${sql.unsafe(nonSystemSchemaPredicate("srcn.nspname"))}
      GROUP BY c.conname, srcn.nspname, src.relname, tgtn.nspname, tgt.relname, c.confupdtype, c.confdeltype
      ORDER BY srcn.nspname, src.relname, c.conname
    `;
    const allIncludedFks = allForeignKeys.filter(
      (fk) => includedTableNames.has(tableKey(fk.source_schema, fk.source_table))
        && includedTableNames.has(tableKey(fk.target_schema, fk.target_table)),
    );
    // A foreign key that names a column added late, on either side, waits for it too.
    const touchesLateColumn = (schema_name: string, tablename: string, columnNames: string[]) => {
      const late = deferredColumnNamesByTable.get(tableKey(schema_name, tablename));
      return late != null && columnNames.some((name) => late.has(name));
    };
    const deferredForeignKeys = allIncludedFks.filter(
      (fk) => touchesLateColumn(fk.source_schema, fk.source_table, fk.source_columns)
        || touchesLateColumn(fk.target_schema, fk.target_table, fk.target_columns),
    );
    const fks = allIncludedFks.filter((fk) => !deferredForeignKeys.includes(fk));

    if (fks.length > 0) {
      emit("-- Foreign keys");
      for (const fk of fks) {
        emitStatement(foreignKeyStatement(fk));
      }
      emit("");
    }

    // Unique constraints
    const allUniqueConstraints = await sql<{
      constraint_name: string;
      schema_name: string;
      tablename: string;
      column_names: string[];
      nulls_not_distinct: boolean;
    }[]>`
      SELECT c.conname AS constraint_name,
             n.nspname AS schema_name,
             t.relname AS tablename,
             array_agg(a.attname ORDER BY array_position(c.conkey, a.attnum)) AS column_names,
             -- AgentDash (GH #733): keep UNIQUE NULLS NOT DISTINCT (PG15+); read from the
             -- definition so older servers, which lack the catalog column, still work.
             bool_or(pg_get_constraintdef(c.oid) ILIKE 'UNIQUE NULLS NOT DISTINCT%') AS nulls_not_distinct
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
      WHERE c.contype = 'u'
        AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      GROUP BY c.conname, n.nspname, t.relname
      ORDER BY n.nspname, t.relname, c.conname
    `;
    const allIncludedUniques = allUniqueConstraints.filter((entry) => includedTableNames.has(tableKey(entry.schema_name, entry.tablename)));
    const deferredUniques = allIncludedUniques.filter((entry) => touchesLateColumn(entry.schema_name, entry.tablename, entry.column_names));
    const uniques = allIncludedUniques.filter((entry) => !deferredUniques.includes(entry));

    if (uniques.length > 0) {
      emit("-- Unique constraints");
      for (const u of uniques) {
        emitStatement(uniqueConstraintStatement(u));
      }
      emit("");
    }

    // AgentDash (GH #907): validated CHECK constraints, before the data so
    // every loaded row is checked exactly as on the source. NOT VALID ones
    // come after the data (below), as pg_dump does: the rows they never
    // checked would otherwise be refused on load.
    const deferredTableChecks = checkConstraints.filter((check) => touchesLateColumn(check.schema_name, check.tablename, check.column_names));
    const validatedChecks = checkConstraints.filter((check) => check.validated && !deferredTableChecks.includes(check));
    if (validatedChecks.length > 0) {
      emit("-- Check constraints");
      for (const check of validatedChecks) {
        emitStatement(
          `ALTER TABLE ${quoteQualifiedName(check.schema_name, check.tablename)} ADD CONSTRAINT ${quoteIdentifier(check.constraint_name)} ${check.definition};`,
        );
      }
      emit("");
    }

    // Indexes (non-primary, non-unique-constraint)
    const allIndexes = await sql<{ schema_name: string; tablename: string; indexdef: string }[]>`
      SELECT schemaname AS schema_name, tablename, indexdef
      FROM pg_indexes
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("schemaname"))}
        AND indexname NOT IN (
          SELECT conname FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = pg_indexes.schemaname
        )
      ORDER BY schemaname, tablename, indexname
    `;
    const allIncludedIndexes = allIndexes.filter((entry) => includedTableNames.has(tableKey(entry.schema_name, entry.tablename)));
    const deferredIndexes = allIncludedIndexes.filter((entry) => deferredColumnNamesByTable.has(tableKey(entry.schema_name, entry.tablename)));
    const indexes = allIncludedIndexes.filter((entry) => !deferredIndexes.includes(entry));

    if (indexes.length > 0) {
      emit("-- Indexes");
      for (const idx of indexes) {
        emitStatement(`${idx.indexdef};`);
      }
      emit("");
    }

    // Dump data for each table
    for (const { schema_name, tablename } of tables) {
      const currentTableKey = tableKey(schema_name, tablename);
      const qualifiedTableName = quoteQualifiedName(schema_name, tablename);
      const count = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${qualifiedTableName}`);
      if (excludedTableNames.has(currentTableKey) || (count[0]?.n ?? 0) === 0) continue;

      // AgentDash (GH #944): the stored (non-generated) columns in attnum
      // order — generated columns are never read or written, their values
      // are recomputed from the expression on restore.
      const cols = (columnsByTable.get(currentTableKey) ?? []).filter((col) => col.generated === "");
      const colNames = cols.map((c) => `"${c.column_name}"`).join(", ");

      emit(`-- Data for: ${commentSafe(`${schema_name}.${tablename}`)} (${count[0]!.n} rows)`);

      const nullifiedColumns = nullifiedColumnsByTable.get(currentTableKey) ?? new Set<string>();
      // AgentDash (GH #907 review): a COPY header must stay on one line (the
      // restore reads it as one), so a table or column whose quoted name holds
      // a CR or LF is written as INSERTs instead.
      const namesFitOneLine = ![schema_name, tablename, ...cols.map((c) => c.column_name)].some((name) => /[\r\n]/.test(name));
      if (backupEngine !== "javascript" && nullifiedColumns.size === 0 && namesFitOneLine) {
        emit(`COPY ${qualifiedTableName} (${colNames}) FROM stdin;`);
        await writer.writeRaw("\n");
        const copySql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });
        try {
          const copyStream = await copySql
            .unsafe(`COPY ${qualifiedTableName} (${colNames}) TO STDOUT`)
            .readable();
          for await (const chunk of copyStream) {
            await writer.writeRaw(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
        } finally {
          await copySql.end();
        }
        await writer.writeRaw("\\.\n");
        emitStatementBoundary();
        emit("");
        continue;
      }

      // AgentDash (GH #940): read each column's exact type, then select every
      // column as text so formatSqlValue never sees a JS-converted value.
      await sql`SELECT set_config('search_path', 'pg_catalog', false)`;
      let columnTypes: { column_name: string; type_name: string }[];
      try {
        // A domain is unwrapped to its base type (through nested domains): a
        // base value still assigns to a domain column when the domain is
        // restored. Generated columns are skipped — they are never written.
        columnTypes = await sql<{ column_name: string; type_name: string }[]>`
          WITH RECURSIVE resolved AS (
            SELECT a.attname, a.atttypid AS type_oid, a.atttypmod AS type_mod, 0 AS depth
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = ${schema_name} AND c.relname = ${tablename}
              AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
            UNION ALL
            SELECT r.attname, t.typbasetype, t.typtypmod, r.depth + 1
            FROM resolved r
            JOIN pg_type t ON t.oid = r.type_oid
            WHERE t.typtype = 'd'
          )
          SELECT DISTINCT ON (attname) attname AS column_name, format_type(type_oid, type_mod) AS type_name
          FROM resolved
          ORDER BY attname, depth DESC
        `;
      } finally {
        await sql`RESET search_path`;
      }
      const typeByColumn = new Map(columnTypes.map((entry) => [entry.column_name, entry.type_name]));
      const insertColumns = cols.map((col) => {
        const typeName = typeByColumn.get(col.column_name);
        if (!typeName) {
          throw new Error(`Backup could not resolve the type of column ${schema_name}.${tablename}.${col.column_name}`);
        }
        const nullified = nullifiedColumns.has(col.column_name);
        return {
          typeName,
          nullified,
          // A nullified column is never read, so its contents never leave the database.
          selectExpression: nullified ? "NULL::text" : `${quoteIdentifier(col.column_name)}::text`,
        };
      });

      const rowCursor = sql
        .unsafe(`SELECT ${insertColumns.map((col) => col.selectExpression).join(", ")} FROM ${qualifiedTableName}`)
        .values()
        .cursor(BACKUP_DATA_CURSOR_ROWS) as AsyncIterable<(string | null)[][]>;
      for await (const rows of rowCursor) {
        for (const row of rows) {
          const values = row.map((textValue, index) =>
            formatSqlValue(textValue, insertColumns[index]!.typeName, insertColumns[index]!.nullified),
          );
          emitStatement(`INSERT INTO ${qualifiedTableName} (${colNames}) VALUES (${values.join(", ")});`);
        }
        await writer.drain();
      }
      emit("");
    }

    // Sequence values
    if (sequences.length > 0) {
      emit("-- Sequence values");
      for (const seq of sequences) {
        const qualifiedSequenceName = quoteQualifiedName(seq.sequence_schema, seq.sequence_name);
        const val = await sql.unsafe<{ last_value: string; is_called: boolean }[]>(
          `SELECT last_value::text, is_called FROM ${qualifiedSequenceName}`,
        );
        const skipSequenceValue =
          seq.owner_table !== null
            && excludedTableNames.has(seq.owner_table);
        if (val[0] && !skipSequenceValue) {
          emitStatement(`SELECT setval('${qualifiedSequenceName.replaceAll("'", "''")}', ${val[0].last_value}, ${val[0].is_called ? "true" : "false"});`);
        }
      }
      emit("");
    }

    // AgentDash (GH #907): NOT VALID CHECK constraints after the data, still
    // NOT VALID, so rows that predate them restore as they were. Checks of a
    // table that gained a column late wait for it, below.
    const notValidChecks = checkConstraints.filter((check) => !check.validated && !deferredTableChecks.includes(check));
    if (notValidChecks.length > 0) {
      emit("-- Check constraints (NOT VALID)");
      for (const check of notValidChecks) {
        emitStatement(
          `ALTER TABLE ${quoteQualifiedName(check.schema_name, check.tablename)} ADD CONSTRAINT ${quoteIdentifier(check.constraint_name)} ${check.definition};`,
        );
      }
      emit("");
    }

    // AgentDash (GH #907): materialized views (WITH DATA) and what depends on
    // them, then triggers, after the data so no trigger sees the restore's
    // own writes. A trigger keeps its enabled state (pg_get_triggerdef does
    // not carry it).
    emitSchemaNodes("Materialized views", schemaNodes.afterData);

    // AgentDash (GH #939, #944): everything that could not go inline and had
    // to wait until every function and relation exists. pg_dump emits the
    // same shapes post-table: a column default that calls a later function
    // becomes ALTER TABLE … ALTER COLUMN … SET DEFAULT; a generated column
    // whose expression needs a later function becomes ADD COLUMN; a domain's
    // constraints and late defaults become ALTER DOMAIN.
    if (deferredColumns.length > 0) {
      emit("-- Generated columns added after the objects they use");
      for (const col of deferredColumns) {
        emitStatement(`ALTER TABLE ${quoteQualifiedName(col.schema_name, col.tablename)} ADD COLUMN ${col.definition};`);
      }
      emit("");
    }
    if (deferredPrimaryKeys.length > 0) {
      emit("-- Primary keys of tables with late columns");
      for (const p of deferredPrimaryKeys) {
        const cols = p.column_names.map((c) => `"${c}"`).join(", ");
        emit(DEFERRED_SCHEMA_MARKER);
        emitStatement(
          `ALTER TABLE ${quoteQualifiedName(p.schema_name, p.tablename)} ADD CONSTRAINT "${p.constraint_name}" PRIMARY KEY (${cols});`,
        );
      }
      emit("");
    }
    if (deferredUniques.length > 0) {
      emit("-- Unique constraints of tables with late columns");
      for (const u of deferredUniques) {
        emit(DEFERRED_SCHEMA_MARKER);
        emitStatement(uniqueConstraintStatement(u));
      }
      emit("");
    }
    if (deferredForeignKeys.length > 0) {
      emit("-- Foreign keys of tables with late columns");
      for (const fk of deferredForeignKeys) {
        emit(DEFERRED_SCHEMA_MARKER);
        emitStatement(foreignKeyStatement(fk));
      }
      emit("");
    }
    if (deferredTableChecks.length > 0) {
      emit("-- Check constraints of tables with late columns");
      for (const check of deferredTableChecks) {
        emit(DEFERRED_SCHEMA_MARKER);
        emitStatement(
          `ALTER TABLE ${quoteQualifiedName(check.schema_name, check.tablename)} ADD CONSTRAINT ${quoteIdentifier(check.constraint_name)} ${check.definition};`,
        );
      }
      emit("");
    }
    if (deferredIndexes.length > 0) {
      emit("-- Indexes of tables with late columns");
      for (const idx of deferredIndexes) {
        emit(DEFERRED_SCHEMA_MARKER);
        emitStatement(`${idx.indexdef};`);
      }
      emit("");
    }
    if (deferredDomainDefaults.length > 0 || deferredDomainConstraints.length > 0) {
      emit("-- Domain alterations");
      for (const domain of deferredDomainDefaults) {
        emitStatement(
          `ALTER DOMAIN ${quoteQualifiedName(domain.schema_name, domain.domain_name)} SET DEFAULT ${domain.default_expr};`,
        );
      }
      for (const constraint of deferredDomainConstraints) {
        emitStatement(
          `ALTER DOMAIN ${quoteQualifiedName(constraint.schema_name, constraint.domain_name)} ADD CONSTRAINT ${quoteIdentifier(constraint.constraint_name)} ${constraint.definition};`,
        );
      }
      emit("");
    }
    if (deferredDefaults.length > 0) {
      emit("-- Column defaults that call a later object");
      for (const col of deferredDefaults) {
        emitStatement(
          `ALTER TABLE ${quoteQualifiedName(col.schema_name, col.tablename)} ALTER COLUMN ${quoteIdentifier(col.column_name)} SET DEFAULT ${col.column_default};`,
        );
      }
      emit("");
    }

    if (triggers.length > 0) {
      emit("-- Triggers");
      for (const trigger of triggers) {
        emitStatement(`${stripTrailingSemicolon(trigger.definition)};`);
        const enable = triggerEnableStatement(trigger);
        if (enable) emitStatement(enable);
      }
      emit("");
    }

    emitStatement("COMMIT;");
    emit("");

    await writer.close();

    // Compress the SQL file with gzip
    const sqlReadStream = createReadStream(sqlFile);
    const gzWriteStream = createWriteStream(backupFile);
    await pipeline(sqlReadStream, createGzip(), gzWriteStream);
    unlinkSync(sqlFile);

    const sizeBytes = statSync(backupFile).size;
    const prunedCount = pruneOldBackups(opts.backupDir, retention, filenamePrefix);

    return {
      backupFile,
      sizeBytes,
      prunedCount,
    };
  } catch (error) {
    await writer.abort();
    if (existsSync(backupFile)) {
      try { unlinkSync(backupFile); } catch { /* ignore */ }
    }
    if (existsSync(sqlFile)) {
      try { unlinkSync(sqlFile); } catch { /* ignore */ }
    }
    throw error;
  } finally {
    await closeSql();
  }
}

/**
 * A `COPY … FROM stdin` block, split into the command and its payload.
 *
 * The backup WRITER emits table data as `COPY … FROM stdin;`, raw TSV, then a
 * `\.` terminator (see the writer above). The statement reader hands that back
 * as ONE string, so the naive `sql.unsafe(statement)` pushes the TSV rows at
 * the parser as if they were SQL and the restore dies on the first data line —
 * measured as `syntax error at or near "1"`.
 *
 * Returns null for anything that is not such a block, so ordinary DDL keeps
 * its existing path untouched.
 */
function parseCopyFromStdin(statement: string): { command: string; payload: string } | null {
  // The writer prefixes each data block with `-- Data for: schema.table (n rows)`,
  // so the COPY command is not the first line. Skipping leading comments and
  // blanks is load-bearing: reading line 0 as the header silently returns null
  // here and hands the whole block — TSV and all — back to sql.unsafe(), which
  // is exactly the failure this function exists to prevent.
  const allLines = statement.split("\n");
  let headerIndex = 0;
  while (
    headerIndex < allLines.length &&
    (allLines[headerIndex]!.trim() === "" || allLines[headerIndex]!.trim().startsWith("--"))
  ) {
    headerIndex += 1;
  }
  if (headerIndex >= allLines.length) return null;

  const header = allLines[headerIndex]!.trim();
  if (!/^COPY\s.+\sFROM\s+stdin\s*;?$/i.test(header)) return null;

  const body = allLines.slice(headerIndex + 1).join("\n");
  // The terminator is a lone `\.` on its own line. Everything before it is
  // payload; anything after it is not ours to interpret.
  const lines = body.split("\n");
  const terminator = lines.findIndex((line) => line === "\\.");
  const dataLines = terminator === -1 ? lines : lines.slice(0, terminator);
  const payload = dataLines.length > 0 ? `${dataLines.join("\n")}\n` : "";

  return {
    // postgres.js wants the command without the trailing semicolon.
    command: header.replace(/;$/, ""),
    payload,
  };
}

/**
 * Stream one COPY block in through the driver's own COPY support.
 *
 * This exists because there is no `psql` on a deployment that uses embedded
 * PostgreSQL — the embedded package ships only `initdb`, `pg_ctl` and
 * `postgres`. `restoreWithPsql` therefore cannot succeed there, and this node
 * path is not a fallback but the ONLY path. Until this function existed, every
 * backup written by this very library was unrestorable on such a host: the
 * backups ran nightly, were retained, and could not have been used.
 */
async function restoreCopyBlock(
  sql: ReturnType<typeof postgres>,
  copy: { command: string; payload: string },
): Promise<void> {
  // AgentDash (GH #907 review): when the server refuses the COPY (a bad row, a
  // CHECK violation), postgres.js reports it only through the query's own
  // reject(), which is a no-op by then because the query already resolved
  // with the stream; the stream never finishes or errors, and the restore
  // used to hang forever. Capture that rejection and fail the block with it.
  const query = sql.unsafe(copy.command) as unknown as {
    reject: (error: unknown) => void;
    writable(): Promise<NodeJS.WritableStream>;
  };
  // This hooks a postgres.js internal (pinned to 3.4.8 in package.json). If a
  // future version drops it, fail loudly instead of silently hanging again.
  if (typeof query.reject !== "function") {
    throw new Error(
      "restoreCopyBlock: postgres.js query.reject is not a function; this version of postgres.js is not supported for COPY restore (pinned 3.4.8)",
    );
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
  await new Promise<void>((resolve, reject) => {
    if (copyError) {
      reject(copyError);
      return;
    }
    failCopy = reject;
    writable.on("error", reject);
    writable.on("finish", resolve);
    if (copy.payload.length > 0) writable.write(copy.payload);
    writable.end();
  });
}

export async function runDatabaseRestore(opts: RunDatabaseRestoreOptions): Promise<void> {
  const connectTimeout = Math.max(1, Math.trunc(opts.connectTimeoutSeconds ?? 5));
  try {
    await restoreWithPsql(opts, connectTimeout);
    return;
  } catch (error) {
    if (!(await hasStatementBreakpoints(opts.backupFile))) {
      throw new Error(
        `Failed to restore ${basename(opts.backupFile)} with psql: ${sanitizeRestoreErrorMessage(error)}`,
      );
    }
  }

  const sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });

  try {
    await sql`SELECT 1`;
    for await (const statement of readRestoreStatements(opts.backupFile)) {
      const copy = parseCopyFromStdin(statement);
      if (copy) {
        await restoreCopyBlock(sql, copy);
        continue;
      }
      await sql.unsafe(statement).execute();
    }
  } catch (error) {
    const statementPreview = typeof error === "object" && error !== null && typeof (error as Record<string, unknown>).query === "string"
      ? String((error as Record<string, unknown>).query)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("--"))
      : null;
    throw new Error(
      `Failed to restore ${basename(opts.backupFile)}: ${sanitizeRestoreErrorMessage(error)}${statementPreview ? ` [statement: ${statementPreview.slice(0, 120)}]` : ""}`,
    );
  } finally {
    await sql.end();
  }
}

export function formatDatabaseBackupResult(result: RunDatabaseBackupResult): string {
  const size = formatBackupSize(result.sizeBytes);
  const pruned = result.prunedCount > 0 ? `; pruned ${result.prunedCount} old backup(s)` : "";
  return `${result.backupFile} (${size}${pruned})`;
}
