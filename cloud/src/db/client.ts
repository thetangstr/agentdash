// AgentDash: control-plane database client and migrator. Migrations live in
// ./migrations (this package's own journal), never packages/db.
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { applyRuntimeGrants, ensureRoles, OWNER_ROLE, pendingMigrations, RUNTIME_ROLE, runtimeRoleProblems, transferOwnership } from "./roles.js";
import * as schema from "./schema.js";

export type CloudDb = PostgresJsDatabase<typeof schema>;

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

export function createCloudDb(url: string, opts: { max?: number } = {}): { db: CloudDb; close: () => Promise<void> } {
  const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  return { db: drizzle(sql, { schema }), close: () => sql.end({ timeout: 5 }) };
}

/**
 * Single-role migration: the connecting role applies the migrations and owns
 * what they create. Local development and tests only (CLOUD_DB_ROLE_MODE=single);
 * production uses migrateWithRoles from the separate migrate service.
 */
export async function migrateCloudDb(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: "drizzle" });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export interface MigrateWithRolesOptions {
  /** Creates the roles if missing and sets the runtime role's password. Omit once the roles exist. */
  runtimePassword?: string;
  owner?: string;
  runtime?: string;
}

/**
 * The GH #763 role split. `migratorUrl` is a superuser (or CREATEROLE) role.
 * Every object ends up owned by the NOLOGIN owner role, the migrations run
 * as that role (SET ROLE on the one connection), and the runtime role's
 * grants are re-applied afterwards so new tables are covered.
 */
export async function migrateWithRoles(migratorUrl: string, opts: MigrateWithRolesOptions = {}): Promise<{ transferred: number }> {
  const owner = opts.owner ?? OWNER_ROLE;
  const runtime = opts.runtime ?? RUNTIME_ROLE;
  // One connection, so SET ROLE holds for the whole migration.
  const sql = postgres(migratorUrl, { max: 1, onnotice: () => {} });
  try {
    if (opts.runtimePassword) await ensureRoles(sql, { owner, runtime, runtimePassword: opts.runtimePassword });
    const roles = await sql`select rolname from pg_roles where rolname in (${owner}, ${runtime})`;
    if (roles.length !== 2) {
      throw new Error(`roles ${owner} and ${runtime} do not exist yet; set CLOUD_RUNTIME_DB_PASSWORD for the first run`);
    }
    const transferred = await transferOwnership(sql, { owner });
    await sql.unsafe(`set role "${owner}"`);
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: "drizzle" });
    await sql.unsafe("reset role");
    // Anything a migration created as the migrator itself (it should not) is handed over too.
    await transferOwnership(sql, { owner });
    await applyRuntimeGrants(sql, { runtime });
    return { transferred };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Boot check for split mode: the service's own connection must be a runtime
 * role (not an owner or superuser) and the schema must be fully migrated.
 * Returns the problems; empty means the service may start.
 */
export async function verifyRuntimeDb(url: string): Promise<string[]> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const pending = await pendingMigrations(sql, MIGRATIONS_FOLDER);
    return [...(pending ? [pending] : []), ...(await runtimeRoleProblems(sql))];
  } finally {
    await sql.end({ timeout: 5 });
  }
}
