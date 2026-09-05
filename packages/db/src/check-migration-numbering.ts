import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const metaDir = fileURLToPath(new URL("./migrations/meta", import.meta.url));
const journalPath = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

export type MigrationLayout = {
  migrationsDir: string;
  metaDir: string;
  journalPath: string;
};

type JournalEntry = {
  idx?: number;
  tag?: string;
};

type JournalFile = {
  entries?: JournalEntry[];
};

function migrationNumber(value: string): string | null {
  const match = value.match(/^(\d{4})_/);
  return match ? match[1] : null;
}

function ensureNoDuplicates(values: string[], label: string) {
  const seen = new Map<string, string>();

  for (const value of values) {
    const number = migrationNumber(value);
    if (!number) {
      throw new Error(`${label} entry does not start with a 4-digit migration number: ${value}`);
    }
    const existing = seen.get(number);
    if (existing) {
      throw new Error(`Duplicate migration number ${number} in ${label}: ${existing}, ${value}`);
    }
    seen.set(number, value);
  }
}

function ensureStrictlyOrdered(values: string[], label: string) {
  const sorted = [...values].sort();
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== sorted[index]) {
      throw new Error(
        `${label} are out of order at position ${index}: expected ${sorted[index]}, found ${values[index]}`,
      );
    }
  }
}

function ensureJournalMatchesFiles(migrationFiles: string[], journalTags: string[]) {
  const journalFiles = journalTags.map((tag) => `${tag}.sql`);

  if (journalFiles.length !== migrationFiles.length) {
    throw new Error(
      `Migration journal/file count mismatch: journal has ${journalFiles.length}, files have ${migrationFiles.length}`,
    );
  }

  for (let index = 0; index < migrationFiles.length; index += 1) {
    const migrationFile = migrationFiles[index];
    const journalFile = journalFiles[index];
    if (migrationFile !== journalFile) {
      throw new Error(
        `Migration journal/file order mismatch at position ${index}: journal has ${journalFile}, files have ${migrationFile}`,
      );
    }
  }
}

async function ensureTipSnapshotExists(journalEntries: JournalEntry[], metaDir: string) {
  const tip = journalEntries[journalEntries.length - 1];
  if (!tip || typeof tip.tag !== "string") {
    return;
  }

  const tipNumber = migrationNumber(tip.tag);
  if (!tipNumber) {
    // Already rejected by ensureNoDuplicates for journal tags.
    return;
  }

  const tipSnapshotPath = join(metaDir, `${tipNumber}_snapshot.json`);
  let exists = true;
  try {
    await stat(tipSnapshotPath);
  } catch {
    exists = false;
  }

  if (!exists) {
    throw new Error(
      `Migration journal tip ${tip.tag} is missing a meta snapshot: expected ${tipSnapshotPath}. ` +
        "drizzle-kit reads only the newest snapshot in meta/, so without it the next generate " +
        "would re-emit this migration's changes as a new migration. Hand-authored migrations must " +
        "ship with a snapshot — run drizzle-kit generate after fixing the journal.",
    );
  }
}

export async function checkMigrations(layout: MigrationLayout): Promise<void> {
  const migrationFiles = (await readdir(layout.migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();

  ensureNoDuplicates(migrationFiles, "migration files");
  ensureStrictlyOrdered(migrationFiles, "migration files");

  const rawJournal = await readFile(layout.journalPath, "utf8");
  const journal = JSON.parse(rawJournal) as JournalFile;
  const journalEntries = journal.entries ?? [];
  journalEntries.forEach((entry, index) => {
    if (typeof entry.tag !== "string" || entry.tag.length === 0) {
      throw new Error(`Migration journal entry ${index} is missing a tag`);
    }
  });

  const journalTags = journalEntries.map((entry) => entry.tag as string);

  ensureNoDuplicates(journalTags, "migration journal");
  ensureStrictlyOrdered(journalTags, "migration journal");
  ensureJournalMatchesFiles(migrationFiles, journalTags);
  // Only the tip needs a snapshot: drizzle-kit's preparePrevSnapshot reads the
  // lexicographically newest file in meta/, so intermediate gaps are harmless
  // (repo precedent: ~30 older migrations have no snapshot).
  await ensureTipSnapshotExists(journalEntries, layout.metaDir);
}

async function main() {
  await checkMigrations({ migrationsDir, metaDir, journalPath });
}

// Run main() only when executed directly (pnpm run check:migrations / build /
// typecheck / generate / migrate), not when imported by the vitest suite.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
