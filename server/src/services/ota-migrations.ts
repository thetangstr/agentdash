// Client-initiated OTA: what a release would do to the database.
//
// Drizzle records one row in `drizzle.__drizzle_migrations` per applied
// migration and applies them strictly in journal order. So "which migrations
// are applied" is answerable without hashing anything: it is the first N
// entries of the journal, where N is the row count. That is exactly how drizzle
// itself decides what is left to run, so this cannot drift from the migrator's
// own view.
//
// The load-bearing fact for rollback planning, and the reason this module
// exists: **drizzle migrations have no down-migrations.** There is no `.down.sql`
// and no reverse in the journal. Every pending migration is therefore
// permanently `reversible: false`, and any release carrying one is
// `forward_only` — recoverable by restoring a backup, not by moving code. That
// is not a limitation of this planner; it is the truth about the schema tooling
// and the approver is entitled to be told it before clicking.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { type OtaMigrationSummary } from "@paperclipai/shared";

export const MIGRATIONS_SUBPATH = path.join("packages", "db", "src", "migrations");
export const JOURNAL_SUBPATH = path.join(MIGRATIONS_SUBPATH, "meta", "_journal.json");

interface JournalEntry {
  idx: number;
  tag: string;
}

interface Journal {
  entries?: JournalEntry[];
}

/**
 * Ordered migration tags from a checkout's journal, or null when unreadable.
 *
 * Null rather than an empty array on failure: "this release has no migrations"
 * and "I could not tell" must not collapse into the same value, because the
 * first is safe to apply and the second is not.
 */
export function readJournalTags(repoRoot: string): string[] | null {
  const journalPath = path.join(repoRoot, JOURNAL_SUBPATH);
  if (!existsSync(journalPath)) return null;
  try {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
    if (!Array.isArray(journal.entries)) return null;
    return journal.entries
      .slice()
      .sort((a, b) => a.idx - b.idx)
      .map((entry) => entry.tag);
  } catch {
    return null;
  }
}

/**
 * Turn a journal into the summary shape the planner consumes.
 *
 * `reversible` is hard-coded false with intent — see the module header. If
 * down-migrations ever land, this is the single place that changes.
 */
export function migrationsFromJournal(tags: string[]): OtaMigrationSummary[] {
  return tags.map((tag) => ({ id: tag, name: tag, reversible: false }));
}

/**
 * The migrations a candidate release carries, read from its own checkout.
 */
export function readReleaseMigrations(releaseRoot: string): OtaMigrationSummary[] | null {
  const tags = readJournalTags(releaseRoot);
  return tags === null ? null : migrationsFromJournal(tags);
}

/**
 * How many migrations the live database has applied, or null if it cannot be
 * determined.
 *
 * A missing table is a legitimate zero — a database that has never been
 * migrated has applied nothing — but any other failure is null, because a
 * connection error must not be read as "clean slate".
 */
export async function readAppliedMigrationCount(db: Db): Promise<number | null> {
  try {
    const result = await db.execute(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );
    const rows = (result as unknown as { rows?: Array<{ count?: number }> }).rows
      ?? (result as unknown as Array<{ count?: number }>);
    const count = Array.isArray(rows) ? rows[0]?.count : undefined;
    return typeof count === "number" ? count : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // "relation does not exist" — never migrated, which is a real zero.
    if (/does not exist/i.test(message)) return 0;
    return null;
  }
}

/**
 * Applied migration ids, as journal tags.
 *
 * Derived from the count against the RUNNING release's journal, which is the
 * codebase that performed those migrations. Returns null when either half is
 * unavailable so the planner reports `unknown` rather than inventing a set.
 */
export async function listAppliedMigrationIds(
  db: Db,
  repoRoot: string = process.env.AGENTDASH_RELEASE_DIR ?? process.cwd(),
): Promise<string[] | null> {
  const [count, tags] = await Promise.all([
    readAppliedMigrationCount(db),
    Promise.resolve(readJournalTags(repoRoot)),
  ]);
  if (count === null || tags === null) return null;
  // More rows than the journal knows about means the database is ahead of this
  // checkout — a downgrade, not an upgrade. Reporting the full journal would
  // hide that; null makes the planner refuse.
  if (count > tags.length) return null;
  return tags.slice(0, count);
}
