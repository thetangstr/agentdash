import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createBufferedTextFileWriter, runDatabaseBackup, runDatabaseRestore } from "./backup-lib.js";
import { ensurePostgresDatabase } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-backup-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

// AgentDash (GH #939, #944): point pg_dump and psql at paths that do not
// exist — this host has both binaries, but these tests must exercise the
// JavaScript backup engine and the postgres.js restore fallback, never the
// real tools.
function forceJavaScriptBackupAndRestore(): void {
  const saved = {
    PAPERCLIP_PG_DUMP_PATH: process.env.PAPERCLIP_PG_DUMP_PATH,
    PAPERCLIP_PSQL_PATH: process.env.PAPERCLIP_PSQL_PATH,
  };
  process.env.PAPERCLIP_PG_DUMP_PATH = path.join(os.tmpdir(), "no-such-pg_dump");
  process.env.PAPERCLIP_PSQL_PATH = path.join(os.tmpdir(), "no-such-psql");
  cleanups.push(() => {
    if (saved.PAPERCLIP_PG_DUMP_PATH === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
    else process.env.PAPERCLIP_PG_DUMP_PATH = saved.PAPERCLIP_PG_DUMP_PATH;
    if (saved.PAPERCLIP_PSQL_PATH === undefined) delete process.env.PAPERCLIP_PSQL_PATH;
    else process.env.PAPERCLIP_PSQL_PATH = saved.PAPERCLIP_PSQL_PATH;
  });
}

async function createSiblingDatabase(connectionString: string, databaseName: string): Promise<string> {
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  await ensurePostgresDatabase(adminUrl.toString(), databaseName);
  const targetUrl = new URL(connectionString);
  targetUrl.pathname = `/${databaseName}`;
  return targetUrl.toString();
}

afterEach(
  async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      await cleanup?.();
    }
  },
  60_000,
);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres backup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("createBufferedTextFileWriter", () => {
  it("preserves line boundaries across buffered flushes", async () => {
    const tempDir = createTempDir("paperclip-buffered-writer-");
    const outputPath = path.join(tempDir, "backup.sql");
    const writer = createBufferedTextFileWriter(outputPath, 16);
    const lines = [
      "-- header",
      "BEGIN;",
      "",
      "INSERT INTO test VALUES (1);",
      "-- footer",
    ];

    for (const line of lines) {
      writer.emit(line);
    }

    await writer.close();

    expect(fs.readFileSync(outputPath, "utf8")).toBe(lines.join("\n"));
  });
});

describeEmbeddedPostgres("runDatabaseBackup", () => {
  /**
   * The test that was missing, and its absence cost the product its backups.
   *
   * Every round-trip case below passes `backupEngine: "javascript"` — the ONE
   * mode that emits INSERT statements. Production defaults to "auto", which
   * emits `COPY … FROM stdin` + raw TSV. So the suite was green while every
   * backup this library actually wrote was unrestorable: the psql path cannot
   * run where embedded PostgreSQL ships no psql binary, and the node path fed
   * the TSV rows to the SQL parser (`syntax error at or near "1"`).
   *
   * Measured before the fix: all 7 nightly backups on the live host failed to
   * restore. This case pins the DEFAULT engine, so a green suite means the
   * thing an operator would reach for in an incident actually works.
   */
  it(
    "restores a backup written by the DEFAULT engine, which emits COPY rather than INSERTs",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_restore_copy_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-copy-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TABLE "public"."copy_roundtrip" (
            "id" serial PRIMARY KEY,
            "label" text NOT NULL,
            "notes" text,
            "meta" jsonb
          );
        `);
        // Values chosen to break naive TSV handling: a tab, a newline, a
        // backslash, a NULL, and a literal "\." that must not be read as the
        // COPY terminator.
        await sourceSql.unsafe(`
          INSERT INTO "public"."copy_roundtrip" ("label", "notes", "meta") VALUES
            ('plain', 'nothing special', '{"a":1}'::jsonb),
            ('tabbed', E'has\\ttab', '{"b":2}'::jsonb),
            ('newlined', E'line one\\nline two', NULL),
            ('slashed', E'back\\\\slash', '{"c":3}'::jsonb),
            ('terminator-ish', '\\.', '{"d":4}'::jsonb),
            ('nulled', NULL, NULL);
        `);

        // NO backupEngine override — this is what production does.
        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-copy-test",
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const rows = await restoreSql.unsafe<
          { label: string; notes: string | null; meta: unknown }[]
        >(`SELECT "label", "notes", "meta" FROM "public"."copy_roundtrip" ORDER BY "id"`);

        expect(rows).toHaveLength(6);
        expect(rows.map((row) => row.label)).toEqual([
          "plain",
          "tabbed",
          "newlined",
          "slashed",
          "terminator-ish",
          "nulled",
        ]);
        // Every awkward value survives the round trip intact.
        expect(rows[1]?.notes).toBe("has\ttab");
        expect(rows[2]?.notes).toBe("line one\nline two");
        expect(rows[3]?.notes).toBe("back\\slash");
        expect(rows[4]?.notes).toBe("\\.");
        expect(rows[5]?.notes).toBeNull();
        expect(rows[5]?.meta).toBeNull();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    120_000,
  );

  it(
    "backs up and restores large table payloads without materializing one giant string",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-output-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TYPE "public"."backup_test_state" AS ENUM ('pending', 'done');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_test_records" (
            "id" serial PRIMARY KEY,
            "title" text NOT NULL,
            "payload" text NOT NULL,
            "state" "public"."backup_test_state" NOT NULL,
            "metadata" jsonb,
            "created_at" timestamptz NOT NULL DEFAULT now()
          );
        `);

        const payload = "x".repeat(8192);
        for (let index = 0; index < 160; index += 1) {
          const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
          await sourceSql`
            INSERT INTO "public"."backup_test_records" (
              "title",
              "payload",
              "state",
              "metadata",
              "created_at"
            )
            VALUES (
              ${`row-${index}`},
              ${payload},
              ${index % 2 === 0 ? "pending" : "done"}::"public"."backup_test_state",
              ${JSON.stringify({ index, even: index % 2 === 0 })}::jsonb,
              ${createdAt}
            )
          `;
        }

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-test",
          backupEngine: "javascript",
        });

        expect(result.backupFile).toMatch(/paperclip-test-.*\.sql\.gz$/);
        expect(result.sizeBytes).toBeGreaterThan(0);
        expect(fs.existsSync(result.backupFile)).toBe(true);

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const counts = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."backup_test_records"
        `);
        expect(counts[0]?.count).toBe(160);

        const sampleRows = await restoreSql.unsafe<{
          title: string;
          payload: string;
          state: string;
          metadata: { index: number; even: boolean } | string;
        }[]>(`
          SELECT "title", "payload", "state"::text AS "state", "metadata"
          FROM "public"."backup_test_records"
          WHERE "title" IN ('row-0', 'row-159')
          ORDER BY "title"
        `);
        expect(sampleRows.map((row) => ({
          ...row,
          metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
        }))).toEqual([
          {
            title: "row-0",
            payload,
            state: "pending",
            metadata: { index: 0, even: true },
          },
          {
            title: "row-159",
            payload,
            state: "done",
            metadata: { index: 159, even: false },
          },
        ]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "backs up and restores non-public database schemas and migration history",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_full_logical_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-full-logical-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE SCHEMA IF NOT EXISTS "drizzle";
          CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
            "id" serial PRIMARY KEY,
            "hash" text NOT NULL,
            "created_at" bigint
          );
          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES ('paperclip-migration-history', 1770000000000);
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_parent_records" (
            "id" uuid PRIMARY KEY,
            "name" text NOT NULL
          );
          INSERT INTO "public"."backup_parent_records" ("id", "name")
          VALUES ('11111111-1111-4111-8111-111111111111', 'parent');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "note" text NOT NULL
          );
          CREATE TABLE "public"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          INSERT INTO "public"."plugin_rows" ("note")
          VALUES ('public-collision');
          INSERT INTO "public"."audit_rows" ("secret_note")
          VALUES ('public-secret');
        `);
        await sourceSql.unsafe(`
          CREATE SCHEMA "plugin_backup_scope";
          CREATE TYPE "plugin_backup_scope"."plugin_status" AS ENUM ('ready', 'done');
          CREATE TABLE "plugin_backup_scope"."plugin_rows" (
            "id" serial PRIMARY KEY,
            "parent_id" uuid NOT NULL REFERENCES "public"."backup_parent_records"("id") ON DELETE CASCADE,
            "status" "plugin_backup_scope"."plugin_status" NOT NULL,
            "note" text NOT NULL
          );
          CREATE TABLE "plugin_backup_scope"."audit_rows" (
            "id" serial PRIMARY KEY,
            "secret_note" text
          );
          CREATE UNIQUE INDEX "plugin_rows_note_uq" ON "plugin_backup_scope"."plugin_rows" ("note");
          INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'ready', 'first');
          INSERT INTO "plugin_backup_scope"."audit_rows" ("secret_note")
          VALUES ('plugin-secret');
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-full-logical-test",
          backupEngine: "javascript",
          excludeTables: ["plugin_rows"],
          nullifyColumns: {
            audit_rows: ["secret_note"],
          },
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const migrationRows = await restoreSql.unsafe<{ hash: string }[]>(`
          SELECT "hash"
          FROM "drizzle"."__drizzle_migrations"
          WHERE "hash" = 'paperclip-migration-history'
        `);
        expect(migrationRows).toEqual([{ hash: "paperclip-migration-history" }]);

        const pluginRows = await restoreSql.unsafe<{ note: string; status: string; parent_name: string }[]>(`
          SELECT r."note", r."status"::text AS "status", p."name" AS "parent_name"
          FROM "plugin_backup_scope"."plugin_rows" r
          JOIN "public"."backup_parent_records" p ON p."id" = r."parent_id"
        `);
        expect(pluginRows).toEqual([{ note: "first", status: "ready", parent_name: "parent" }]);

        const publicCollisionRows = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."plugin_rows"
        `);
        expect(publicCollisionRows[0]?.count).toBe(0);

        const publicAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "public"."audit_rows"
        `);
        expect(publicAuditRows).toEqual([{ secret_note: null }]);

        const pluginAuditRows = await restoreSql.unsafe<{ secret_note: string | null }[]>(`
          SELECT "secret_note"
          FROM "plugin_backup_scope"."audit_rows"
        `);
        expect(pluginAuditRows).toEqual([{ secret_note: "plugin-secret" }]);

        await expect(
          restoreSql.unsafe(`
            INSERT INTO "plugin_backup_scope"."plugin_rows" ("parent_id", "status", "note")
            VALUES ('11111111-1111-4111-8111-111111111111', 'done', 'first')
          `),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  // AgentDash (GH #940): the INSERT path (backupEngine "javascript" and any
  // nullified table, which is how worktree seeds are written) used to rebuild
  // SQL from postgres.js's JS values: bytea became Buffer JSON, naive
  // timestamps shifted by the host time zone and arrays failed to restore.
  // Run with the process away from UTC so a time zone shift cannot hide, using
  // the same options the worktree seed passes, and require every value to come
  // back with the same canonical text.
  it(
    "round-trips bytea, timestamps, arrays, jsonb, numeric, interval, enums and NULLs through the INSERT path away from UTC",
    async () => {
      const previousTz = process.env.TZ;
      process.env.TZ = "America/Los_Angeles";
      cleanups.push(() => {
        if (previousTz === undefined) delete process.env.TZ;
        else process.env.TZ = previousTz;
      });
      expect(new Date(2026, 0, 15, 12).getTimezoneOffset()).not.toBe(0);

      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_restore_insert_types_target",
      );
      const backupDir = createTempDir("paperclip-db-insert-types-backup-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      const columns = [
        "raw_bytes",
        "naive_ts",
        "zoned_ts",
        "int_list",
        "text_list",
        "doc",
        "amount",
        "span",
        "mood",
        "mood_list",
        "short_code",
        "note",
      ];
      const selectCanonicalRows = (db: ReturnType<typeof postgres>) =>
        db.unsafe<Record<string, string | null>[]>(`
          SELECT "id"::text AS "id", ${columns.map((column) => `"${column}"::text AS "${column}"`).join(", ")},
                 "secret"::text AS "secret"
          FROM "public"."typed_rows"
          ORDER BY "typed_rows"."id"
        `);

      try {
        await sourceSql.unsafe(`
          CREATE TYPE "public"."row_mood" AS ENUM ('calm', 'it''s "busy"');
          CREATE DOMAIN "public"."short_code" AS varchar(8) CHECK (VALUE <> '');
          CREATE TABLE "public"."typed_rows" (
            "id" integer PRIMARY KEY,
            "raw_bytes" bytea,
            "naive_ts" timestamp without time zone,
            "zoned_ts" timestamp with time zone,
            "int_list" integer[],
            "text_list" text[],
            "doc" jsonb,
            "amount" numeric(20,10),
            "span" interval,
            "mood" "public"."row_mood",
            "mood_list" "public"."row_mood"[],
            "short_code" "public"."short_code",
            "note" text,
            "secret" text
          );
          INSERT INTO "public"."typed_rows" VALUES (
            1,
            '\\x00015c27ff'::bytea,
            '2026-01-15 12:34:56.789012',
            '2026-07-04 23:59:59.5+05:30',
            ARRAY[1, -2, NULL, 2147483647],
            ARRAY['plain', 'it''s "quoted"', 'back\\slash', 'comma,brace{}', NULL, ''],
            '{"nested": {"list": [1, 2.50, "x"]}, "quote": "it''s \\"q\\""}'::jsonb,
            1234567890.0123456789,
            '1 year 2 mons 3 days 04:05:06.789',
            'it''s "busy"',
            ARRAY['calm', 'it''s "busy"']::"public"."row_mood"[],
            'AB-12',
            E'line one\\nline "two"\\r\\n\\\\backslash and it''s $paperclip$ tag',
            'do-not-copy'
          );
          INSERT INTO "public"."typed_rows" ("id", "secret") VALUES (2, 'also-secret');
        `);
        // Quoting edge cases (GH #940 review): a value ending in the old
        // dollar-quote tag's prefix closed the literal early, and a lone CR or a
        // line equal to the restore's statement breakpoint must not split or
        // rewrite a value.
        const trickyNotes = [
          "hello $paperclip",
          "$paperclip$",
          "x$",
          "$$",
          "",
          "lone\rcarriage return",
          "before\n-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900\nafter",
          "it's \\ E'escaped' \\n not a newline",
        ];
        for (const [index, note] of trickyNotes.entries()) {
          await sourceSql`
            INSERT INTO "public"."typed_rows" ("id", "note", "text_list")
            VALUES (${100 + index}, ${note}, ARRAY[${note}]::text[])
          `;
        }

        const sourceRows = await selectCanonicalRows(sourceSql);
        expect(sourceRows.slice(2).map((row) => row.note)).toEqual(trickyNotes);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-insert-types-test",
          // The worktree seed's options: INSERT engine plus a nullified column.
          backupEngine: "javascript",
          nullifyColumns: { typed_rows: ["secret"] },
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const restoredRows = await selectCanonicalRows(restoreSql);
        expect(restoredRows).toEqual(sourceRows.map((row) => ({ ...row, secret: null })));
        expect(restoredRows[0]).toMatchObject({
          raw_bytes: "\\x00015c27ff",
          naive_ts: "2026-01-15 12:34:56.789012",
          int_list: "{1,-2,NULL,2147483647}",
          amount: "1234567890.0123456789",
        });
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  // AgentDash (GH #907): the pg_dump-less engine used to drop CHECK
  // constraints, views, functions and triggers (the evaluation ledger's
  // immutability trigger among them), so a restore came back weaker than the
  // source. Round trip a fully migrated database the way a box does it (no
  // pg_dump, no psql) and require the catalogs to match.
  it(
    "round-trips CHECK constraints, views, functions, triggers and NULLS NOT DISTINCT without pg_dump or psql",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_schema_objects_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-schema-objects-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const savedEnv = {
        PAPERCLIP_PG_DUMP_PATH: process.env.PAPERCLIP_PG_DUMP_PATH,
        PAPERCLIP_PSQL_PATH: process.env.PAPERCLIP_PSQL_PATH,
      };
      // As on a box or a Mac mini on embedded Postgres: neither binary exists.
      process.env.PAPERCLIP_PG_DUMP_PATH = path.join(os.tmpdir(), "no-such-pg_dump");
      process.env.PAPERCLIP_PSQL_PATH = path.join(os.tmpdir(), "no-such-psql");

      const catalog = async (sql: ReturnType<typeof postgres>) => {
        const rows = async (text: string) => (await sql.unsafe<{ e: string }[]>(text)).map((row) => row.e).sort();
        const userNs = `n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'`;
        return {
          checks: await rows(`
            SELECT n.nspname || '.' || t.relname || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid) AS e
            FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE c.contype = 'c' AND ${userNs}`),
          views: await rows(`
            SELECT n.nspname || '.' || c.relname || ' = ' || pg_get_viewdef(c.oid) AS e
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('v', 'm') AND ${userNs}`),
          functions: await rows(`
            SELECT pg_get_functiondef(p.oid) AS e
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.prokind IN ('f', 'p') AND ${userNs}
              AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`),
          checksValidated: await rows(`
            SELECT n.nspname || '.' || t.relname || '.' || c.conname || ' validated=' || c.convalidated::text AS e
            FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE c.contype = 'c' AND ${userNs}`),
          triggers: await rows(`SELECT pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text AS e FROM pg_trigger t WHERE NOT t.tgisinternal`),
          tables: await rows(`
            SELECT n.nspname || '.' || c.relname || ':' || c.relkind::text AS e
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'v', 'm') AND ${userNs}`),
          nullsNotDistinct: await rows(`
            SELECT pg_get_indexdef(i.indexrelid) AS e
            FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE ${userNs} AND pg_get_indexdef(i.indexrelid) ILIKE '%NULLS NOT DISTINCT%'`),
          constraints: await rows(`
            SELECT n.nspname || '.' || t.relname || '.' || c.conname || ' ' || c.contype::text || ' ' || pg_get_constraintdef(c.oid) AS e
            FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE c.contype IN ('p', 'u', 'f', 'c') AND ${userNs}`),
          indexes: await rows(`
            SELECT pg_get_indexdef(i.indexrelid) AS e
            FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE ${userNs}`),
        };
      };

      try {
        const [company] = await sourceSql<{ id: string }[]>`
          INSERT INTO companies (name) VALUES ('Ledger Co') RETURNING id
        `;
        await sourceSql`
          INSERT INTO evaluation_events
            (company_id, actor_type, source_table, source_id, source_version, event_type, event_time, dedupe_key)
          VALUES
            (${company!.id}, 'system', 'issues', 'issue-1', 'v1', 'issue.created', now(), 'dedupe-1')
        `;

        // Review cases (PR #929), all in the same source database:
        //  - a NOT VALID CHECK over a row that violates it (must restore, still NOT VALID);
        //  - a function and a table whose quoted names contain newlines and SQL
        //    (a `--` comment line must not let that SQL run on restore);
        //  - a disabled trigger (must come back disabled);
        //  - a function returning a VIEW's row type, a BEGIN ATOMIC function
        //    that reads a table, a view calling it, and a materialized view
        //    (each must be created after what it needs).
        await sourceSql.unsafe(`
          CREATE TABLE "public"."nv_rows" ("id" int PRIMARY KEY, "n" int NOT NULL);
          INSERT INTO "public"."nv_rows" VALUES (1, -5), (2, 7);
          ALTER TABLE "public"."nv_rows" ADD CONSTRAINT "nv_rows_n_positive" CHECK ("n" > 0) NOT VALID;
          CREATE FUNCTION "public"."nv_touch"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
          CREATE TRIGGER "nv_rows_touch" BEFORE UPDATE ON "public"."nv_rows" FOR EACH ROW EXECUTE FUNCTION "public"."nv_touch"();
          ALTER TABLE "public"."nv_rows" DISABLE TRIGGER "nv_rows_touch";
          CREATE TRIGGER "nv_rows_touch_always" BEFORE INSERT ON "public"."nv_rows" FOR EACH ROW EXECUTE FUNCTION "public"."nv_touch"();
          ALTER TABLE "public"."nv_rows" ENABLE ALWAYS TRIGGER "nv_rows_touch_always";
          CREATE FUNCTION "public"."x
CREATE TABLE injected_by_name (z int);
--"() RETURNS int LANGUAGE sql AS 'select 1';
          CREATE TABLE "public"."t
CREATE TABLE injected_by_table (z int);
--" ("id" int);
          INSERT INTO "public"."t
CREATE TABLE injected_by_table (z int);
--" VALUES (1);
          CREATE VIEW "public"."nv_view" AS SELECT "id", "n" FROM "public"."nv_rows";
          CREATE FUNCTION "public"."nv_view_rows"() RETURNS SETOF "public"."nv_view" LANGUAGE sql AS 'SELECT * FROM public.nv_view';
          CREATE FUNCTION "public"."nv_count"() RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT count(*) FROM "public"."nv_rows"; END;
          CREATE VIEW "public"."nv_counted" AS SELECT "public"."nv_count"() AS "c";
          CREATE MATERIALIZED VIEW "public"."nv_mat" AS SELECT count(*) AS "c" FROM "public"."nv_rows";
        `);

        const source = await catalog(sourceSql);

        // The migrated schema really has each kind of object, so equality is not vacuous.
        expect(source.checks.length).toBeGreaterThan(0);
        expect(source.views.some((view) => view.startsWith("public.issue_review_timeline_v ="))).toBe(true);
        expect(source.functions.some((fn) => fn.includes("evaluation_events_immutable"))).toBe(true);
        expect(source.triggers.some((trigger) => trigger.includes("evaluation_events_no_update_trg"))).toBe(true);
        expect(source.triggers.some((trigger) => trigger.includes("evaluation_events_no_delete_trg"))).toBe(true);
        expect(source.nullsNotDistinct.some((index) => index.includes("plugin_state_unique_entry_idx"))).toBe(true);
        expect(source.checksValidated).toContain("public.nv_rows.nv_rows_n_positive validated=false");
        expect(source.triggers.some((trigger) => trigger.includes("nv_rows_touch ") && trigger.endsWith("enabled=D"))).toBe(true);
        expect(source.triggers.some((trigger) => trigger.includes("nv_rows_touch_always") && trigger.endsWith("enabled=A"))).toBe(true);

        // Both engines: the default (COPY) and the JavaScript one (INSERTs).
        for (const engine of ["auto", "javascript"] as const) {
          const targetConnectionString = engine === "auto"
            ? restoreConnectionString
            : await createSiblingDatabase(sourceConnectionString, "paperclip_schema_objects_restore_js");
          const targetSql = engine === "auto"
            ? restoreSql
            : postgres(targetConnectionString, { max: 1, onnotice: () => {} });
          try {
            const result = await runDatabaseBackup({
              connectionString: sourceConnectionString,
              backupDir,
              retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
              filenamePrefix: `paperclip-schema-objects-${engine}`,
              backupEngine: engine,
            });
            await runDatabaseRestore({
              connectionString: targetConnectionString,
              backupFile: result.backupFile,
            });

            const restored = await catalog(targetSql);
            expect(restored.checks, engine).toEqual(source.checks);
            expect(restored.checksValidated, engine).toEqual(source.checksValidated);
            expect(restored.views, engine).toEqual(source.views);
            expect(restored.functions, engine).toEqual(source.functions);
            expect(restored.triggers, engine).toEqual(source.triggers);
            expect(restored.nullsNotDistinct, engine).toEqual(source.nullsNotDistinct);
            expect(restored.constraints, engine).toEqual(source.constraints);
            expect(restored.indexes, engine).toEqual(source.indexes);
            // Same tables, views and materialized views: nothing injected by a name.
            expect(restored.tables, engine).toEqual(source.tables);
            const [injected] = await targetSql<{ name: string | null; table: string | null }[]>`
              SELECT to_regclass('public.injected_by_name')::text AS name, to_regclass('public.injected_by_table')::text AS table
            `;
            expect(injected, engine).toEqual({ name: null, table: null });

            // The ledger row came back, and the immutability trigger still guards it.
            const [ledger] = await targetSql<{ n: number }[]>`SELECT count(*)::int AS n FROM evaluation_events`;
            expect(ledger?.n, engine).toBe(1);
            await expect(
              targetSql`UPDATE evaluation_events SET event_type = 'tampered'`,
            ).rejects.toThrow(/append-only: UPDATE refused/);
            await expect(targetSql`DELETE FROM evaluation_events`).rejects.toThrow(/append-only: DELETE refused/);
            // The views, the BEGIN ATOMIC function and the materialized view answer.
            await expect(targetSql`SELECT count(*) FROM issue_review_timeline_v`).resolves.toBeDefined();
            const [answers] = await targetSql<{ violating: number; counted: number; mat: number; via_view: number }[]>`
              SELECT (SELECT count(*)::int FROM nv_rows WHERE n <= 0) AS violating,
                     (SELECT c::int FROM nv_counted) AS counted,
                     (SELECT c::int FROM nv_mat) AS mat,
                     (SELECT count(*)::int FROM nv_view_rows()) AS via_view
            `;
            expect(answers, engine).toEqual({ violating: 1, counted: 2, mat: 2, via_view: 2 });
          } finally {
            if (targetSql !== restoreSql) await targetSql.end();
          }
        }
      } finally {
        process.env.PAPERCLIP_PG_DUMP_PATH = savedEnv.PAPERCLIP_PG_DUMP_PATH;
        process.env.PAPERCLIP_PSQL_PATH = savedEnv.PAPERCLIP_PSQL_PATH;
        if (savedEnv.PAPERCLIP_PG_DUMP_PATH === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
        if (savedEnv.PAPERCLIP_PSQL_PATH === undefined) delete process.env.PAPERCLIP_PSQL_PATH;
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    180_000,
  );

  // AgentDash (GH #907 review): a COPY block the server refuses used to hang
  // the restore forever (postgres.js reported the error nowhere the stream
  // could see). It must fail promptly with the server's error.
  it(
    "fails a restore promptly when the server refuses a COPY block",
    async () => {
      const restoreConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-restore-copy-error-");
      const backupFile = path.join(backupDir, "copy-error.sql");
      const breakpoint = "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";
      const savedPsql = process.env.PAPERCLIP_PSQL_PATH;
      process.env.PAPERCLIP_PSQL_PATH = path.join(os.tmpdir(), "no-such-psql");
      try {
        await fs.promises.writeFile(
          backupFile,
          [
            "BEGIN;",
            breakpoint,
            "CREATE TABLE public.copy_error_test (id integer PRIMARY KEY, n integer NOT NULL CHECK (n > 0));",
            breakpoint,
            "-- Data for: public.copy_error_test (2 rows)",
            "COPY \"public\".\"copy_error_test\" (\"id\", \"n\") FROM stdin;",
            "1\t5",
            "2\t-1",
            "\\.",
            breakpoint,
            "COMMIT;",
            breakpoint,
          ].join("\n"),
          "utf8",
        );

        const startedAt = Date.now();
        const outcome = await Promise.race([
          runDatabaseRestore({ connectionString: restoreConnectionString, backupFile }).then(
            () => "resolved",
            (error: unknown) => error,
          ),
          new Promise((resolve) => setTimeout(() => resolve("hung"), 15_000).unref()),
        ]);
        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).message).toMatch(/copy_error_test_n_check|violates check constraint/);
        expect(Date.now() - startedAt).toBeLessThan(15_000);
      } finally {
        if (savedPsql === undefined) delete process.env.PAPERCLIP_PSQL_PATH;
        else process.env.PAPERCLIP_PSQL_PATH = savedPsql;
      }
    },
    60_000,
  );

  // AgentDash (GH #939): a column DEFAULT that calls a function which can only
  // be created after the tables (it reads one) used to be emitted inline, so
  // the restore died parsing the default before the function existed. pg_dump
  // emits it as ALTER TABLE … SET DEFAULT afterwards — the dump must do the
  // same and the restored column must still carry the default.
  it(
    "restores a column default that calls a function created only after the tables",
    async () => {
      forceJavaScriptBackupAndRestore();
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_late_default_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-late-default-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TABLE public.late_default_ref (n integer);
          INSERT INTO public.late_default_ref VALUES (7), (9);
          -- BEGIN ATOMIC records a real pg_depend edge to the table, so the
          -- dump must place this function after the tables — after any CREATE
          -- TABLE that would have carried the default inline.
          CREATE FUNCTION public.late_default_fn() RETURNS bigint LANGUAGE sql
            BEGIN ATOMIC SELECT count(*) FROM public.late_default_ref; END;
          CREATE TABLE public.late_default_rows (
            id integer PRIMARY KEY,
            counted bigint DEFAULT public.late_default_fn()
          );
          INSERT INTO public.late_default_rows (id, counted) VALUES (1, 99), (2, 5);
        `);

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-late-default",
          backupEngine: "javascript",
        });

        const dump = gunzipSync(fs.readFileSync(result.backupFile)).toString("utf8");
        const createTableAt = dump.indexOf('CREATE TABLE "public"."late_default_rows"');
        const functionAt = dump.indexOf("CREATE OR REPLACE FUNCTION public.late_default_fn");
        const setDefaultAt = dump.indexOf(
          'ALTER TABLE "public"."late_default_rows" ALTER COLUMN "counted" SET DEFAULT public.late_default_fn()',
        );
        expect(createTableAt).toBeGreaterThanOrEqual(0);
        expect(functionAt).toBeGreaterThanOrEqual(0);
        expect(setDefaultAt).toBeGreaterThan(functionAt);
        // The default must not appear inside the CREATE TABLE itself.
        const createTableBody = dump.slice(createTableAt, dump.indexOf(");", createTableAt));
        expect(createTableBody).not.toContain("late_default_fn");

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const [column] = await restoreSql.unsafe<{ generated: string; default_expr: string | null }[]>(`
          SELECT a.attgenerated::text AS generated, pg_get_expr(ad.adbin, ad.adrelid) AS default_expr
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
          WHERE n.nspname = 'public' AND c.relname = 'late_default_rows' AND a.attname = 'counted'
        `);
        expect(column?.generated).toBe("");
        expect(column?.default_expr).toBe("late_default_fn()");

        const rows = await restoreSql.unsafe<{ id: number; counted: number }[]>(
          `SELECT id, counted::int AS counted FROM public.late_default_rows ORDER BY id`,
        );
        expect(rows).toEqual([
          { id: 1, counted: 99 },
          { id: 2, counted: 5 },
        ]);
        // The restored default still runs.
        await restoreSql.unsafe(`INSERT INTO public.late_default_rows (id) VALUES (3)`);
        const [inserted] = await restoreSql.unsafe<{ counted: number }[]>(
          `SELECT counted::int AS counted FROM public.late_default_rows WHERE id = 3`,
        );
        expect(inserted?.counted).toBe(2);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  // AgentDash (GH #944): the information_schema column query flattened a
  // domain column to the base type, losing the domain's NOT NULL, DEFAULT and
  // CHECK constraints. The catalog-driven dump must recreate the domain first
  // and keep it on the column — including a domain built on another domain.
  it(
    "round-trips domains with their base types, NOT NULL, defaults and CHECK constraints",
    async () => {
      forceJavaScriptBackupAndRestore();
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_domains_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-domains-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      const domainCatalog = async (db: ReturnType<typeof postgres>) => ({
        domains: (await db.unsafe<{ e: string }[]>(`
          SELECT t.typname || ' AS ' || format_type(t.typbasetype, t.typtypmod)
                 || ' notnull=' || t.typnotnull::text
                 || coalesce(' default=' || pg_get_expr(t.typdefaultbin, 0), '') AS e
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typtype = 'd' AND n.nspname = 'public'
          ORDER BY t.typname`)).map((row) => row.e),
        domainConstraints: (await db.unsafe<{ e: string }[]>(`
          SELECT t.typname || '.' || c.conname || ' ' || pg_get_constraintdef(c.oid)
                 || ' validated=' || c.convalidated::text AS e
          FROM pg_constraint c
          JOIN pg_type t ON t.oid = c.contypid
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = 'public'
          ORDER BY t.typname, c.conname`)).map((row) => row.e),
        columns: (await db.unsafe<{ e: string }[]>(`
          SELECT a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                 || ' notnull=' || a.attnotnull::text AS e
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'domain_rows'
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`)).map((row) => row.e),
      });

      try {
        await sourceSql.unsafe(`
          CREATE DOMAIN public.short_code AS varchar(8) CHECK (VALUE <> '') NOT NULL;
          CREATE DOMAIN public.code_defaulted AS public.short_code DEFAULT 'hi';
          CREATE TABLE public.domain_rows (
            id integer PRIMARY KEY,
            code public.short_code,
            defaulted public.code_defaulted,
            codes public.short_code[]
          );
          INSERT INTO public.domain_rows (id, code, defaulted, codes)
          VALUES (1, 'AB-12', 'ZZ-99', '{AB-12,CD-34}'::public.short_code[]),
                 (2, 'CD-34', DEFAULT, '{}'::public.short_code[]);
        `);

        const source = await domainCatalog(sourceSql);
        // The source really has the domain (the check is not vacuous).
        expect(source.domains.some((d) => d.startsWith("short_code AS character varying(8) notnull=true"))).toBe(true);
        expect(source.columns).toContain("code short_code notnull=false");

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-domains",
          backupEngine: "javascript",
        });

        const dump = gunzipSync(fs.readFileSync(result.backupFile)).toString("utf8");
        // CREATE DOMAIN comes before the table that uses it (and before any
        // array column — PostgreSQL refuses ALTER DOMAIN once an array of the
        // domain backs a column, so the CHECK must be inside CREATE DOMAIN).
        const domainAt = dump.indexOf('CREATE DOMAIN "public"."short_code"');
        expect(domainAt).toBeGreaterThanOrEqual(0);
        expect(dump.indexOf('CREATE TABLE "public"."domain_rows"')).toBeGreaterThan(domainAt);
        expect(dump.slice(domainAt, dump.indexOf(";", domainAt))).toContain("CHECK");

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const restored = await domainCatalog(restoreSql);
        expect(restored.domains).toEqual(source.domains);
        expect(restored.domainConstraints).toEqual(source.domainConstraints);
        expect(restored.columns).toEqual(source.columns);

        const rows = await restoreSql.unsafe<{ id: number; code: string; defaulted: string; codes: string }[]>(
          `SELECT id, code::text AS code, defaulted::text AS defaulted, codes::text AS codes FROM public.domain_rows ORDER BY id`,
        );
        expect(rows).toEqual([
          { id: 1, code: "AB-12", defaulted: "ZZ-99", codes: "{AB-12,CD-34}" },
          { id: 2, code: "CD-34", defaulted: "hi", codes: "{}" },
        ]);
        // The CHECK survived: an empty string must be refused.
        await expect(
          restoreSql.unsafe(`INSERT INTO public.domain_rows (id, code) VALUES (9, '')`),
        ).rejects.toThrow(/short_code_check/);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  // AgentDash (GH #944): information_schema rebuilt temporal and bit typmods
  // lossily — timestamp(3) came back plain timestamp, bit(5) lost its length.
  // format_type(atttypid, atttypmod) preserves them; pin the exact spellings.
  it(
    "round-trips temporal, interval, bit and numeric typmods exactly",
    async () => {
      forceJavaScriptBackupAndRestore();
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_typmods_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-typmods-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      const columnTypes = async (db: ReturnType<typeof postgres>) =>
        (await db.unsafe<{ e: string }[]>(`
          SELECT a.attname || ' ' || format_type(a.atttypid, a.atttypmod) AS e
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'typmod_rows'
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`)).map((row) => row.e);

      try {
        await sourceSql.unsafe(`
          CREATE TABLE public.typmod_rows (
            id integer PRIMARY KEY,
            ts timestamp(3) NOT NULL,
            tstz timestamptz(0),
            tm time(4),
            iv interval year to month,
            ivs interval second(3),
            b bit(5),
            vb varbit(9),
            vc varchar(7),
            nn numeric(9,4)
          );
          INSERT INTO public.typmod_rows
            (id, ts, tstz, tm, iv, ivs, b, vb, vc, nn)
          VALUES
            (1, '2026-01-02 03:04:05.678', '2026-01-02 03:04:05+00', '12:13:14.5678',
             '1 year 2 months', '5.678 seconds', '10101', '101', 'abc', 12.3456);
        `);

        const source = await columnTypes(sourceSql);
        expect(source).toContain("ts timestamp(3) without time zone");
        expect(source).toContain("tstz timestamp(0) with time zone");
        expect(source).toContain("iv interval year to month");
        expect(source).toContain("b bit(5)");
        expect(source).toContain("vb bit varying(9)");

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-typmods",
          backupEngine: "javascript",
        });

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        expect(await columnTypes(restoreSql)).toEqual(source);

        const rows = await restoreSql.unsafe<Record<string, string>[]>(`
          SELECT ts::text AS ts, tstz::text AS tstz, tm::text AS tm, iv::text AS iv,
                 ivs::text AS ivs, b::text AS b, vb::text AS vb, vc, nn::text AS nn
          FROM public.typmod_rows
        `);
        expect(rows).toEqual([{
          ts: "2026-01-02 03:04:05.678",
          tstz: "2026-01-01 19:04:05-08",
          tm: "12:13:14.5678",
          iv: "1 year 2 mons",
          ivs: "00:00:05.678",
          b: "10101",
          vb: "101",
          vc: "abc",
          nn: "12.3456",
        }]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  // AgentDash (GH #944): an array of a domain or composite type was emitted
  // with a mangled type name (the information_schema UDT spellings), so the
  // CREATE TABLE failed or silently changed type. The catalog spellings keep
  // them — and recreate the composite types they name, before the tables.
  it(
    "round-trips arrays of domains and composite types",
    async () => {
      forceJavaScriptBackupAndRestore();
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_arrays_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-arrays-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      const typeCatalog = async (db: ReturnType<typeof postgres>) => ({
        composites: (await db.unsafe<{ e: string }[]>(`
          SELECT t.typname || ' (' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ')' AS e
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          JOIN pg_class tc ON tc.oid = t.typrelid AND tc.relkind = 'c'
          JOIN pg_attribute a ON a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped
          WHERE n.nspname = 'public'
          ORDER BY t.typname, a.attnum`)).map((row) => row.e),
        columns: (await db.unsafe<{ e: string }[]>(`
          SELECT a.attname || ' ' || format_type(a.atttypid, a.atttypmod) AS e
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'array_rows'
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`)).map((row) => row.e),
      });

      try {
        await sourceSql.unsafe(`
          CREATE DOMAIN public.array_code AS text CHECK (length(VALUE) > 0);
          CREATE TYPE public.pair AS (a integer, b text);
          CREATE TYPE public.weighted_pair AS (sub public.pair, w numeric(5,2));
          CREATE TABLE public.array_rows (
            id integer PRIMARY KEY,
            codes public.array_code[],
            pairs public.pair[],
            weighted public.weighted_pair
          );
          INSERT INTO public.array_rows (id, codes, pairs, weighted)
          VALUES (1, '{x,y}'::public.array_code[],
                  ARRAY[ROW(1,'one')::public.pair, ROW(2,'two')::public.pair],
                  ROW(ROW(9,'nine')::public.pair, 3.14)::public.weighted_pair);
        `);

        const source = await typeCatalog(sourceSql);
        expect(source.columns).toContain("codes array_code[]");
        expect(source.columns).toContain("pairs pair[]");

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-arrays",
          backupEngine: "javascript",
        });

        const dump = gunzipSync(fs.readFileSync(result.backupFile)).toString("utf8");
        expect(dump).toContain('CREATE TYPE "public"."pair" AS');
        expect(dump).toContain('"codes" public.array_code[]');
        expect(dump.indexOf('CREATE DOMAIN "public"."array_code"')).toBeGreaterThanOrEqual(0);

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const restored = await typeCatalog(restoreSql);
        expect(restored.composites).toEqual(source.composites);
        expect(restored.columns).toEqual(source.columns);

        const rows = await restoreSql.unsafe<{ codes: string; pairs: string; weighted: string }[]>(
          `SELECT codes::text AS codes, pairs::text AS pairs, weighted::text AS weighted FROM public.array_rows`,
        );
        expect(rows).toEqual([{
          codes: "{x,y}",
          pairs: '{"(1,one)","(2,two)"}',
          weighted: '("(9,nine)",3.14)',
        }]);
        // The domain still enforces its CHECK through the array column.
        await expect(
          restoreSql.unsafe(`INSERT INTO public.array_rows (id, codes) VALUES (9, '{""}'::public.array_code[])`),
        ).rejects.toThrow();
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  // AgentDash (GH #944): generated columns were written as plain columns and
  // then INSERTed into — which PostgreSQL refuses. They must be emitted as
  // GENERATED ALWAYS AS (…) STORED, left out of every row statement, and —
  // when the expression calls a function created after the tables — added by
  // a deferred ALTER TABLE … ADD COLUMN, with the constraint that uses it.
  it(
    "round-trips generated columns, including one whose expression calls a later function",
    async () => {
      forceJavaScriptBackupAndRestore();
      const sourceConnectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-generated-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });

      const generatedCatalog = async (db: ReturnType<typeof postgres>) =>
        (await db.unsafe<{ e: string }[]>(`
          SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
                 || ' generated=' || a.attgenerated::text
                 || coalesce(' expr=' || pg_get_expr(ad.adbin, ad.adrelid), '') AS e
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
          WHERE n.nspname = 'public' AND c.relname IN ('gen_plain', 'gen_late')
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY c.relname, a.attnum`)).map((row) => row.e);

      try {
        await sourceSql.unsafe(`
          CREATE TABLE public.gen_ref (n integer);
          INSERT INTO public.gen_ref VALUES (4);
          CREATE FUNCTION public.gen_count_fn() RETURNS bigint LANGUAGE sql IMMUTABLE
            BEGIN ATOMIC SELECT count(*) FROM public.gen_ref; END;
          CREATE TABLE public.gen_plain (
            id integer PRIMARY KEY,
            doubled integer GENERATED ALWAYS AS (id * 2) STORED
          );
          CREATE TABLE public.gen_late (
            id integer,
            counted bigint GENERATED ALWAYS AS (public.gen_count_fn()) STORED,
            PRIMARY KEY (id, counted)
          );
          INSERT INTO public.gen_plain (id) VALUES (1), (2);
          INSERT INTO public.gen_late (id) VALUES (1);
        `);

        const source = await generatedCatalog(sourceSql);
        expect(source).toContain("gen_plain.doubled integer generated=s expr=(id * 2)");
        expect(source.some((e) => e.startsWith("gen_late.counted bigint generated=s"))).toBe(true);

        // Both engines: generated columns must stay out of COPY headers too.
        for (const engine of ["auto", "javascript"] as const) {
          const targetConnectionString = await createSiblingDatabase(
            sourceConnectionString,
            `paperclip_generated_restore_${engine}`,
          );
          const targetSql = postgres(targetConnectionString, { max: 1, onnotice: () => {} });
          try {
            const result = await runDatabaseBackup({
              connectionString: sourceConnectionString,
              backupDir,
              retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
              filenamePrefix: `paperclip-generated-${engine}`,
              backupEngine: engine,
            });

            const dump = gunzipSync(fs.readFileSync(result.backupFile)).toString("utf8");
            // The plain generated column stays inline; the function-dependent
            // one is added after the function exists.
            expect(dump).toContain('"doubled" integer GENERATED ALWAYS AS ((id * 2)) STORED');
            const addColumnAt = dump.indexOf('ALTER TABLE "public"."gen_late" ADD COLUMN "counted"');
            expect(addColumnAt).toBeGreaterThan(
              dump.indexOf("CREATE OR REPLACE FUNCTION public.gen_count_fn"),
            );
            // No row statement ever names a generated column.
            for (const line of dump.split("\n")) {
              if (line.startsWith('INSERT INTO "public"."gen_') || line.startsWith('COPY "public"."gen_')) {
                expect(line).not.toContain('"doubled"');
                expect(line).not.toContain('"counted"');
              }
            }

            await runDatabaseRestore({
              connectionString: targetConnectionString,
              backupFile: result.backupFile,
            });

            expect(await generatedCatalog(targetSql), engine).toEqual(source);
            const rows = await targetSql.unsafe<{ id: number; doubled: number }[]>(
              `SELECT id, doubled FROM public.gen_plain ORDER BY id`,
            );
            expect(rows, engine).toEqual([
              { id: 1, doubled: 2 },
              { id: 2, doubled: 4 },
            ]);
            const lateRows = await targetSql.unsafe<{ id: number; counted: number }[]>(
              `SELECT id, counted::int AS counted FROM public.gen_late`,
            );
            expect(lateRows, engine).toEqual([{ id: 1, counted: 1 }]);
            // The deferred PRIMARY KEY still enforces on the late column.
            await expect(
              targetSql.unsafe(`INSERT INTO public.gen_late (id) VALUES (1)`),
            ).rejects.toThrow();
          } finally {
            await targetSql.end();
          }
        }
      } finally {
        await sourceSql.end();
      }
    },
    120_000,
  );

  it(
    "restores legacy public-only backups without migration history",
    async () => {
      const restoreConnectionString = await createTempDatabase();
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const backupDir = createTempDir("paperclip-db-restore-manual-");
      const backupFile = path.join(backupDir, "manual.sql");

      try {
        await fs.promises.writeFile(
          backupFile,
          [
            "-- Paperclip database backup",
            "-- Created: 2026-04-06T00:00:00.000Z",
            "",
            "BEGIN;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "CREATE TABLE public.restore_stream_test (id integer primary key, payload text not null);",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "INSERT INTO public.restore_stream_test (id, payload)",
            "VALUES (1, 'hello');",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "COMMIT;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          ].join("\n"),
          "utf8",
        );

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile,
        });

        const rows = await restoreSql.unsafe<{ payload: string }[]>(`
          SELECT payload
          FROM public.restore_stream_test
        `);
        expect(rows).toEqual([{ payload: "hello" }]);
      } finally {
        await restoreSql.end();
      }
    },
    20_000,
  );
});
