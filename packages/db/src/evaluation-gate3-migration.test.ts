import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// AgentDash: Agent Performance Management gate 3 (P3.1) — migration 0154 is
// additive: evaluation_events gains access_class (default 'company', which
// backfills every existing row) and subject_agent_id plus two indexes, and the
// routine_run_occurrences side table is created. The ledger's no-UPDATE
// trigger is untouched by the backfill (ADD COLUMN ... DEFAULT is DDL).

const MIGRATION = "0154_glorious_quentin_quire.sql";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

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
    `Skipping embedded Postgres migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function migrationHash(file: string): Promise<string> {
  const content = await fs.promises.readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

describeEmbeddedPostgres("migration 0154 (APM gate 3 freeze)", () => {
  it(
    "backfills existing ledger rows as 'company' and adds the columns, indexes and side table",
    async () => {
      const db = await startEmbeddedPostgresTestDatabase("paperclip-db-apm-gate3-");
      cleanups.push(db.cleanup);
      const connectionString = db.connectionString;

      await applyPendingMigrations(connectionString);

      // Roll 0154 back by hand, write a ledger row as gate 2 would have, then apply 0154 over it.
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      let eventId: string;
      try {
        await sql.unsafe(`DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${await migrationHash(MIGRATION)}'`);
        await sql.unsafe(`DROP TABLE "routine_run_occurrences"`);
        await sql.unsafe(`DROP INDEX "evaluation_events_company_subject_agent_seq_idx"`);
        await sql.unsafe(`DROP INDEX "evaluation_events_company_actor_idx"`);
        await sql.unsafe(`ALTER TABLE "evaluation_events" DROP COLUMN "access_class"`);
        await sql.unsafe(`ALTER TABLE "evaluation_events" DROP COLUMN "subject_agent_id"`);
        const [company] = await sql.unsafe<{ id: string }[]>(`INSERT INTO companies (name) VALUES ('Ledger Co') RETURNING id`);
        const [event] = await sql.unsafe<{ id: string }[]>(
          `INSERT INTO evaluation_events (company_id, actor_type, source_table, source_id, source_version, event_type, event_time, dedupe_key)
           VALUES ('${company!.id}', 'system', 'issues', 'issue-1', 'v1', 'issue.created', now(), 'gate3-backfill-1') RETURNING id`,
        );
        eventId = event!.id;
      } finally {
        await sql.end();
      }

      expect(await inspectMigrations(connectionString)).toMatchObject({ status: "needsMigrations", pendingMigrations: [MIGRATION] });
      await applyPendingMigrations(connectionString);
      expect((await inspectMigrations(connectionString)).status).toBe("upToDate");

      const verify = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const [row] = await verify.unsafe<{ access_class: string; subject_agent_id: string | null }[]>(
          `SELECT access_class, subject_agent_id FROM evaluation_events WHERE id = '${eventId}'`,
        );
        expect(row).toEqual({ access_class: "company", subject_agent_id: null });

        const columns = await verify.unsafe<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>(
          `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'evaluation_events' AND column_name IN ('access_class', 'subject_agent_id')
           ORDER BY column_name`,
        );
        expect(columns).toEqual([
          { column_name: "access_class", data_type: "text", is_nullable: "NO", column_default: "'company'::text" },
          { column_name: "subject_agent_id", data_type: "uuid", is_nullable: "YES", column_default: null },
        ]);

        const indexes = await verify.unsafe<{ indexname: string; indexdef: string }[]>(
          `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
           AND indexname IN ('evaluation_events_company_subject_agent_seq_idx', 'evaluation_events_company_actor_idx',
                             'routine_run_occurrences_routine_run_uq', 'routine_run_occurrences_company_trigger_scheduled_idx')
           ORDER BY indexname`,
        );
        expect(indexes.map((i) => i.indexname)).toEqual([
          "evaluation_events_company_actor_idx",
          "evaluation_events_company_subject_agent_seq_idx",
          "routine_run_occurrences_company_trigger_scheduled_idx",
          "routine_run_occurrences_routine_run_uq",
        ]);
        expect(indexes.find((i) => i.indexname === "evaluation_events_company_subject_agent_seq_idx")!.indexdef).toContain("(company_id, subject_agent_id, seq)");
        expect(indexes.find((i) => i.indexname === "evaluation_events_company_actor_idx")!.indexdef).toContain("(company_id, actor_id)");
        expect(indexes.find((i) => i.indexname === "routine_run_occurrences_routine_run_uq")!.indexdef).toContain("UNIQUE");

        // The ledger stays append-only after the backfill.
        await expect(verify.unsafe(`UPDATE evaluation_events SET access_class = 'company' WHERE id = '${eventId}'`)).rejects.toThrow();

        const occurrenceColumns = await verify.unsafe<{ column_name: string; is_nullable: string }[]>(
          `SELECT column_name, is_nullable FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'routine_run_occurrences' ORDER BY ordinal_position`,
        );
        expect(occurrenceColumns).toEqual([
          { column_name: "id", is_nullable: "NO" },
          { column_name: "company_id", is_nullable: "NO" },
          { column_name: "routine_run_id", is_nullable: "NO" },
          { column_name: "trigger_id", is_nullable: "NO" },
          { column_name: "scheduled_for", is_nullable: "NO" },
          { column_name: "created_at", is_nullable: "NO" },
        ]);
      } finally {
        await verify.end();
      }
    },
    120_000,
  );
});
