// AgentDash: the control plane's database role split (GH #763 precondition 1,
// from the #779 security review).
//
//   cloud_owner  NOLOGIN. Owns every table, sequence, trigger function and
//                the drizzle schema. Migrations run as this role (the
//                migrator connects as a superuser or CREATEROLE role and
//                does SET ROLE cloud_owner), so nobody logs in as it.
//   cloud_app    LOGIN. What the running service connects as. SELECT, INSERT,
//                UPDATE, DELETE on ordinary tables; only SELECT and INSERT on
//                the audit tables (operator_audit, box_events); no TRUNCATE,
//                TRIGGER or REFERENCES anywhere; owns nothing, so it cannot
//                ALTER, DROP, DISABLE TRIGGER or replace a trigger function.
//
// Why: the append-only triggers from #779 stop an application bug, not a
// compromised connection. An owner can drop the trigger or the table. With
// the split, a compromised cloud-control process holds only cloud_app.
//
// The migrator never sends a plaintext password to Postgres: the runtime
// role's password is set as a SCRAM-SHA-256 verifier computed here, so even a
// failed ALTER ROLE logged by the server carries nothing reusable.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type postgres from "postgres";

export const OWNER_ROLE = "cloud_owner";
export const RUNTIME_ROLE = "cloud_app";
/** Append-only tables: the runtime role may only read and add rows. */
export const AUDIT_TABLES = ["operator_audit", "box_events"] as const;

type Sql = postgres.Sql | postgres.ReservedSql;

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
function ident(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`not a safe role name: ${name}`);
  return `"${name}"`;
}

/** A SCRAM-SHA-256 verifier for ALTER ROLE … PASSWORD (RFC 5802, PG's format). */
export function scramVerifier(password: string, iterations = 4096, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

export interface RoleNames {
  owner?: string;
  runtime?: string;
}

/**
 * Create both roles if missing and (re)set the runtime role's password.
 * Needs a superuser or CREATEROLE connection. Idempotent.
 */
export async function ensureRoles(sql: Sql, opts: RoleNames & { runtimePassword: string }): Promise<void> {
  const owner = ident(opts.owner ?? OWNER_ROLE);
  const runtime = ident(opts.runtime ?? RUNTIME_ROLE);
  if (opts.runtimePassword.length < 24) throw new Error("the runtime role password must be at least 24 characters");
  const exists = async (name: string) =>
    (await sql`select 1 from pg_roles where rolname = ${name}`).length > 0;
  if (!(await exists(opts.owner ?? OWNER_ROLE))) {
    await sql.unsafe(`create role ${owner} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
  }
  if (!(await exists(opts.runtime ?? RUNTIME_ROLE))) {
    await sql.unsafe(`create role ${runtime} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
  }
  // Re-assert the attributes every run, in case someone changed them by hand.
  await sql.unsafe(`alter role ${owner} nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
  // The verifier is a literal (utility statements take no parameters); it is
  // not the password and is safe to appear in a server log.
  const verifier = scramVerifier(opts.runtimePassword);
  await sql.unsafe(`alter role ${runtime} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password '${verifier}'`);
  const [{ db, superuser }] = (await sql`select current_database() as db, (select rolsuper from pg_roles where rolname = current_user) as superuser`) as unknown as [
    { db: string; superuser: boolean },
  ];
  if (!superuser) await sql.unsafe(`grant ${owner} to current_user`);
  await sql.unsafe(`grant connect on database "${db.replace(/"/g, '""')}" to ${runtime}`);
  await sql.unsafe(`grant create on database "${db.replace(/"/g, '""')}" to ${owner}`);
  await sql.unsafe(`grant usage, create on schema public to ${owner}`);
}

/**
 * Hand every control-plane object that is not an extension member to the
 * owner role: tables (their serial sequences and triggers follow), free
 * sequences, views, public functions and the drizzle schema. Converts a
 * database created before the split (SC-1 migrated as the superuser).
 */
export async function transferOwnership(sql: Sql, opts: RoleNames = {}): Promise<number> {
  const ownerName = opts.owner ?? OWNER_ROLE;
  const owner = ident(ownerName);
  let changed = 0;
  const notExtension = (col: string) =>
    `not exists (select 1 from pg_depend d where d.objid = ${col} and d.deptype = 'e')`;
  const tables = await sql.unsafe<{ fq: string }[]>(
    `select format('%I.%I', n.nspname, c.relname) as fq from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'drizzle') and c.relkind in ('r', 'p', 'v', 'm')
        and pg_get_userbyid(c.relowner) <> $1 and ${notExtension("c.oid")}`,
    [ownerName],
  );
  for (const t of tables) {
    await sql.unsafe(`alter table ${t.fq} owner to ${owner}`);
    changed += 1;
  }
  // Sequences owned by a column moved with their table; the rest move here.
  const seqs = await sql.unsafe<{ fq: string }[]>(
    `select format('%I.%I', n.nspname, c.relname) as fq from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'drizzle') and c.relkind = 'S'
        and pg_get_userbyid(c.relowner) <> $1 and ${notExtension("c.oid")}`,
    [ownerName],
  );
  for (const s of seqs) {
    await sql.unsafe(`alter sequence ${s.fq} owner to ${owner}`);
    changed += 1;
  }
  const fns = await sql.unsafe<{ sig: string }[]>(
    `select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and pg_get_userbyid(p.proowner) <> $1 and ${notExtension("p.oid")}`,
    [ownerName],
  );
  for (const f of fns) {
    await sql.unsafe(`alter function ${f.sig} owner to ${owner}`);
    changed += 1;
  }
  const drizzle = await sql`select pg_get_userbyid(nspowner) as o from pg_namespace where nspname = 'drizzle'`;
  if (drizzle.length && drizzle[0]!.o !== ownerName) {
    await sql.unsafe(`alter schema drizzle owner to ${owner}`);
    changed += 1;
  }
  return changed;
}

/**
 * The runtime role's privileges, re-applied after every migration so a new
 * table is covered. Idempotent: revoke everything, grant exactly this.
 */
export async function applyRuntimeGrants(sql: Sql, opts: RoleNames = {}): Promise<void> {
  const runtime = ident(opts.runtime ?? RUNTIME_ROLE);
  const audit = AUDIT_TABLES.map((t) => `public.${ident(t)}`).join(", ");
  await sql.unsafe(`revoke create on schema public from public`);
  await sql.unsafe(`revoke all on schema public from ${runtime}`);
  await sql.unsafe(`grant usage on schema public to ${runtime}`);
  await sql.unsafe(`revoke all on all tables in schema public from ${runtime}`);
  await sql.unsafe(`grant select, insert, update, delete on all tables in schema public to ${runtime}`);
  await sql.unsafe(`revoke update, delete, truncate, trigger, references on ${audit} from ${runtime}`);
  await sql.unsafe(`revoke all on all sequences in schema public from ${runtime}`);
  await sql.unsafe(`grant usage, select on all sequences in schema public to ${runtime}`);
  await sql.unsafe(`revoke all on all functions in schema public from ${runtime}`);
  const drizzle = await sql`select 1 from pg_namespace where nspname = 'drizzle'`;
  if (drizzle.length) {
    await sql.unsafe(`revoke all on schema drizzle from ${runtime}`);
    await sql.unsafe(`grant usage on schema drizzle to ${runtime}`);
    await sql.unsafe(`revoke all on all tables in schema drizzle from ${runtime}`);
    await sql.unsafe(`grant select on drizzle.__drizzle_migrations to ${runtime}`);
  }
}

/**
 * What is wrong with the CURRENT connection's role for running the service.
 * Empty means it is a proper runtime role. The service refuses to start
 * otherwise (split mode), so a mis-set DATABASE_URL cannot silently run the
 * service as the owner again.
 */
export async function runtimeRoleProblems(sql: Sql): Promise<string[]> {
  const problems: string[] = [];
  const [role] = await sql<{ name: string; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolbypassrls: boolean }[]>`
    select current_user as name, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls from pg_roles where rolname = current_user`;
  if (!role) return ["cannot read the current role"];
  if (role.rolsuper) problems.push(`${role.name} is a superuser`);
  if (role.rolcreaterole) problems.push(`${role.name} can create roles`);
  if (role.rolcreatedb) problems.push(`${role.name} can create databases`);
  if (role.rolbypassrls) problems.push(`${role.name} bypasses row-level security`);
  for (const t of AUDIT_TABLES) {
    const [r] = await sql<{ owns: boolean; upd: boolean; del: boolean; trunc: boolean; trig: boolean; ins: boolean; sel: boolean }[]>`
      select pg_has_role(current_user, c.relowner, 'USAGE') as owns,
             has_table_privilege(current_user, c.oid, 'UPDATE') as upd,
             has_table_privilege(current_user, c.oid, 'DELETE') as del,
             has_table_privilege(current_user, c.oid, 'TRUNCATE') as trunc,
             has_table_privilege(current_user, c.oid, 'TRIGGER') as trig,
             has_table_privilege(current_user, c.oid, 'INSERT') as ins,
             has_table_privilege(current_user, c.oid, 'SELECT') as sel
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = ${t}`;
    if (!r) {
      problems.push(`audit table ${t} does not exist (run the migrations)`);
      continue;
    }
    if (r.owns) problems.push(`${role.name} owns ${t} (could ALTER, DROP or disable its triggers)`);
    for (const [k, label] of [["upd", "UPDATE"], ["del", "DELETE"], ["trunc", "TRUNCATE"], ["trig", "TRIGGER"]] as const) {
      if (r[k]) problems.push(`${role.name} has ${label} on ${t}`);
    }
    if (!r.ins || !r.sel) problems.push(`${role.name} lacks INSERT or SELECT on ${t}`);
  }
  const [schema] = await sql<{ create: boolean }[]>`select has_schema_privilege(current_user, 'public', 'CREATE') as create`;
  if (schema?.create) problems.push(`${role.name} can CREATE in schema public`);
  return problems;
}

/** The journal's migrations, in order (tag and folder timestamp). */
export function journalEntries(migrationsFolder: string): Array<{ tag: string; when: number }> {
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ tag: string; when: number }>;
  };
  return journal.entries;
}

/**
 * Null when the database has every migration in the journal applied;
 * otherwise why not. Read-only, so the runtime role can run it at boot.
 */
export async function pendingMigrations(sql: Sql, migrationsFolder: string): Promise<string | null> {
  const entries = journalEntries(migrationsFolder);
  const last = entries[entries.length - 1];
  if (!last) return null;
  const table = await sql`select to_regclass('drizzle.__drizzle_migrations') as t`;
  if (!table[0]?.t) return "no migrations have been applied (drizzle.__drizzle_migrations is missing)";
  const [row] = await sql<{ n: number; latest: string | null }[]>`
    select count(*)::int as n, max(created_at)::text as latest from drizzle.__drizzle_migrations`;
  const latest = row?.latest ? Number(row.latest) : 0;
  if (latest < last.when) {
    return `database is behind: ${row?.n ?? 0} migration(s) applied, the journal ends at ${last.tag}`;
  }
  return null;
}
