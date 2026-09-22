import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

/**
 * Truncate teardown tables, retrying on Postgres deadlocks.
 *
 * TRUNCATE ... CASCADE takes ACCESS EXCLUSIVE on every table in the FK
 * closure. Background work started by the code under test (heartbeat
 * sweeps, webhook delivery, async event recording) can still hold row
 * locks in a competing order when afterEach fires, and Postgres resolves
 * that by killing one side: "deadlock detected" (40P01). The victim is
 * chosen arbitrarily, so the correct response is simply to retry — the
 * background transaction it collided with has been rolled back or has
 * committed by the next attempt. Release run 35767860346 flaked exactly
 * this way in heartbeat-wake-gate.test.ts.
 */
export async function truncateWithRetry(db: Db, tables: SQL, attempts = 4): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.execute(sql`truncate table ${tables} cascade`);
      return;
    } catch (error) {
      if (attempt >= attempts || !isDeadlock(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

function isDeadlock(error: unknown): boolean {
  for (let e = error; e; e = (e as { cause?: unknown }).cause) {
    const { code, message } = e as { code?: string; message?: string };
    if (code === "40P01" || /deadlock detected/i.test(message ?? "")) return true;
  }
  return false;
}
