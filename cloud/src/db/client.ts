// AgentDash: control-plane database client and migrator. Migrations live in
// ./migrations (this package's own journal), never packages/db.
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema.js";

export type CloudDb = PostgresJsDatabase<typeof schema>;

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

export function createCloudDb(url: string, opts: { max?: number } = {}): { db: CloudDb; close: () => Promise<void> } {
  const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  return { db: drizzle(sql, { schema }), close: () => sql.end({ timeout: 5 }) };
}

export async function migrateCloudDb(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: "drizzle" });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
