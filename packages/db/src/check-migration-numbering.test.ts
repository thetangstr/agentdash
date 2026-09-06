import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkMigrations, type MigrationLayout } from "./check-migration-numbering.js";

const ORIGINAL_CWD = process.cwd();

function createLayout(): MigrationLayout {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-migrations-"));
  const migrationsDir = path.join(root, "migrations");
  const metaDir = path.join(migrationsDir, "meta");
  fs.mkdirSync(metaDir, { recursive: true });
  return {
    migrationsDir,
    metaDir,
    journalPath: path.join(metaDir, "_journal.json"),
  };
}

function writeJournal(layout: MigrationLayout, entries: Array<{ idx: number; tag: string }>) {
  fs.writeFileSync(
    layout.journalPath,
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: entries.map((entry) => ({ ...entry, version: "7", when: 0, breakpoints: true })),
    }),
  );
}

function writeMigration(layout: MigrationLayout, tag: string) {
  fs.writeFileSync(path.join(layout.migrationsDir, `${tag}.sql`), `-- ${tag}\nSELECT 1;\n`);
}

function writeSnapshot(layout: MigrationLayout, number: string) {
  fs.writeFileSync(
    path.join(layout.metaDir, `${number}_snapshot.json`),
    JSON.stringify({
      id: `00000000-0000-0000-0000-${number.padStart(12, "0")}`,
      prevId: "00000000-0000-0000-0000-000000000000",
      version: "7",
      dialect: "postgresql",
      tables: {},
    }),
  );
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
});

describe("checkMigrations tip snapshot guard", () => {
  it("fails when the journal tip has no meta snapshot", async () => {
    const layout = createLayout();
    for (const tag of [
      "0123_funny_the_stranger",
      "0124_steward_inbox",
      "0125_steward_inbox_decisions",
    ]) {
      writeMigration(layout, tag);
    }
    writeSnapshot(layout, "0123");
    // Journal tip 0125 was hand-authored: SQL + journal entry, no snapshot.
    writeJournal(layout, [
      { idx: 123, tag: "0123_funny_the_stranger" },
      { idx: 124, tag: "0124_steward_inbox" },
      { idx: 125, tag: "0125_steward_inbox_decisions" },
    ]);

    await expect(checkMigrations(layout)).rejects.toThrow(
      /0125_steward_inbox_decisions is missing a meta snapshot.*0125_snapshot\.json/s,
    );
  });

  it("passes when the journal tip has a meta snapshot, even with intermediate gaps", async () => {
    const layout = createLayout();
    for (const tag of [
      "0122_funny_valkyrie",
      "0123_funny_the_stranger",
      "0124_steward_inbox",
      "0125_steward_inbox_decisions",
      "0126_inbox_connect_actions",
    ]) {
      writeMigration(layout, tag);
    }
    // Repo precedent after #609: only 0123 (pre-gap) and 0126 (tip) have
    // snapshots; 0124/0125 are intentionally snapshot-less intermediate gaps.
    writeSnapshot(layout, "0123");
    writeSnapshot(layout, "0126");
    writeJournal(layout, [
      { idx: 122, tag: "0122_funny_valkyrie" },
      { idx: 123, tag: "0123_funny_the_stranger" },
      { idx: 124, tag: "0124_steward_inbox" },
      { idx: 125, tag: "0125_steward_inbox_decisions" },
      { idx: 126, tag: "0126_inbox_connect_actions" },
    ]);

    await expect(checkMigrations(layout)).resolves.toBeUndefined();
  });

  it("passes when the journal is empty (no tip to guard)", async () => {
    const layout = createLayout();
    writeJournal(layout, []);

    await expect(checkMigrations(layout)).resolves.toBeUndefined();
  });
});
