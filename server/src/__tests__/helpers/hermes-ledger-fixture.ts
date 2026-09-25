// AgentDash (OBS-5, #698): a minimal Hermes `state.db` for liveness-probe tests.
// Only the columns the probe reads; shaped like the live profile ledgers
// (`sessions` + `session_model_usage`, times as unix seconds).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface LedgerSessionFixture {
  id: string;
  startedAt: Date;
  endedAt?: Date | null;
  parentSessionId?: string | null;
  /** One usage row per entry. */
  usage?: Array<{ firstSeen: Date; lastSeen: Date; model?: string; apiCalls?: number }>;
}

const sec = (date: Date) => date.getTime() / 1000;

export function createHermesLedgerFixture(sessions: LedgerSessionFixture[], dir?: string) {
  const root = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "hermes-ledger-"));
  const dbPath = path.join(root, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      parent_session_id TEXT,
      started_at REAL NOT NULL,
      ended_at REAL,
      message_count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS session_model_usage (
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      task TEXT NOT NULL DEFAULT '',
      api_call_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      first_seen REAL,
      last_seen REAL,
      PRIMARY KEY (session_id, model, task)
    );
  `);
  const insertSession = db.prepare(
    "INSERT INTO sessions (id, source, parent_session_id, started_at, ended_at) VALUES (?, 'tool', ?, ?, ?)",
  );
  const insertUsage = db.prepare(
    "INSERT INTO session_model_usage (session_id, model, task, api_call_count, input_tokens, output_tokens, first_seen, last_seen) VALUES (?, ?, ?, ?, 1000, 100, ?, ?)",
  );
  for (const session of sessions) {
    insertSession.run(
      session.id,
      session.parentSessionId ?? null,
      sec(session.startedAt),
      session.endedAt ? sec(session.endedAt) : null,
    );
    (session.usage ?? []).forEach((row, index) => {
      insertUsage.run(
        session.id,
        row.model ?? "glm-5.3-flash",
        `task-${index}`,
        row.apiCalls ?? 1,
        sec(row.firstSeen),
        sec(row.lastSeen),
      );
    });
  }
  db.close();
  return {
    dir: root,
    dbPath,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
