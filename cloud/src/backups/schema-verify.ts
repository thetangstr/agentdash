// AgentDash (GH #733 security review): verify a replayed database before it is
// ever promoted. Its schema must be explainable by OUR migrations:
//
//   1. the applied-migration list is read from the RESTORED
//      drizzle.__drizzle_migrations (never from the box-written header) and
//      its hashes — in row order — must form an UNBROKEN PREFIX of this
//      repository's journal (packages/db/src/migrations), each the SHA-256 of
//      its migration file as the box's own migrator records it. A known hash
//      that is not the next journal entry means the box skipped or reordered
//      a migration, and the restore fails;
//   2. a reference database is built by applying exactly those migrations,
//      from this repository, to an empty database in the same sandbox;
//   3. the two catalogs are compared object by object: tables, columns,
//      defaults, constraints, indexes, sequences, types, triggers, rules,
//      views, functions, policies, row-level security, extensions, event
//      triggers, casts, operators, languages, foreign servers, publications,
//      owners and ACLs. Any object in the restored database that the
//      reference does not have fails the check. Objects the reference has and
//      the restore lacks are reported (replay never runs a dump's functions,
//      triggers, views or CHECK constraints, and older dumps do not carry
//      them; GH #907) but do not fail it.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

export interface BoxMigration {
  tag: string;
  hash: string;
  content: string;
}

/** Our box migrations, in journal order, with the hash the box's migrator records. */
export function loadBoxMigrations(dir: string): BoxMigration[] {
  const journal = JSON.parse(fs.readFileSync(path.join(dir, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((e) => {
      const content = fs.readFileSync(path.join(dir, `${e.tag}.sql`), "utf8");
      return { tag: e.tag, hash: createHash("sha256").update(content).digest("hex"), content };
    });
}

function connect(url: string) {
  return postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
}

/**
 * Which of our migrations the restored database says it applied, and any hash
 * we do not know. `applied` is the UNBROKEN PREFIX of our journal the rows
 * match, in `id` order — a known hash anywhere else is `outOfOrder`, not
 * applied, so a box that skipped migration 2 cannot claim migrations 1 and 3.
 */
export async function restoredMigrations(url: string, ours: BoxMigration[]): Promise<{ applied: BoxMigration[]; unknown: string[]; duplicates: string[]; outOfOrder: string[] }> {
  const sql = connect(url);
  try {
    const [t] = await sql<Array<{ present: boolean }>>`select to_regclass('drizzle.__drizzle_migrations') is not null as present`;
    if (!t?.present) return { applied: [], unknown: ["(no drizzle.__drizzle_migrations table)"], duplicates: [], outOfOrder: [] };
    const rows = await sql<Array<{ hash: string }>>`select hash from drizzle.__drizzle_migrations order by id`;
    const byHash = new Map(ours.map((m) => [m.hash, m]));
    const seen = new Set<string>();
    const unknown: string[] = [];
    const duplicates: string[] = [];
    const outOfOrder: string[] = [];
    const applied: BoxMigration[] = [];
    for (const r of rows) {
      if (seen.has(r.hash)) {
        duplicates.push(r.hash);
        continue;
      }
      seen.add(r.hash);
      const expected = ours[applied.length];
      if (expected && r.hash === expected.hash) {
        applied.push(expected);
        continue;
      }
      (byHash.has(r.hash) ? outOfOrder : unknown).push(r.hash);
    }
    return { applied, unknown, duplicates, outOfOrder };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Apply exactly `migrations` (ours, trusted) to an EMPTY database, as the box's migrator would. */
export async function buildReference(url: string, migrations: BoxMigration[]): Promise<void> {
  const sql = connect(url);
  try {
    const [n] = await sql<Array<{ n: number }>>`
      select count(*)::int as n from pg_class c join pg_namespace s on s.oid = c.relnamespace
       where s.nspname not in ('pg_catalog', 'information_schema') and s.nspname not like 'pg_toast%' and s.nspname not like 'pg_temp%'`;
    if ((n?.n ?? 0) > 0) throw new Error("the reference database is not empty; give it a fresh, empty database");
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
    for (const m of migrations) {
      await sql.begin(async (tx) => {
        for (const statement of m.content.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
          await tx.unsafe(statement);
        }
        await tx.unsafe("insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)", [m.hash, Date.now()]);
      });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const USER_SCHEMAS = `n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'`;
const NOT_EXTENSION = (cls: string, oid: string) => `not exists (select 1 from pg_depend d where d.classid = '${cls}'::regclass and d.objid = ${oid} and d.deptype = 'e')`;

/** Category → entries. Every entry is a stable description of one object. */
export type CatalogSnapshot = Record<string, Set<string>>;

export async function catalogSnapshot(url: string): Promise<CatalogSnapshot> {
  const sql = connect(url);
  const q = async (category: string, text: string) => [category, new Set((await sql.unsafe<Array<{ e: string }>>(text)).map((r) => r.e))] as const;
  try {
    const parts = await Promise.all([
      q("schema", `select n.nspname as e from pg_namespace n where ${USER_SCHEMAS}`),
      q("relation", `select c.relkind::text || ':' || n.nspname || '.' || c.relname as e from pg_class c join pg_namespace n on n.oid = c.relnamespace where ${USER_SCHEMAS} and c.relkind not in ('i', 'I', 't') and ${NOT_EXTENSION("pg_class", "c.oid")}`),
      q("column", `select n.nspname || '.' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || (case when a.attnotnull then ' not null' else '' end) || (case when a.attgenerated <> '' then ' generated' else '' end) as e
                   from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
                  where ${USER_SCHEMAS} and a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'p', 'v', 'm', 'f') and ${NOT_EXTENSION("pg_class", "c.oid")}`),
      q("default", `select n.nspname || '.' || c.relname || '.' || a.attname || ' = ' || pg_get_expr(d.adbin, d.adrelid) as e
                    from pg_attrdef d join pg_class c on c.oid = d.adrelid join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
                   where ${USER_SCHEMAS}`),
      q("identity", `select n.nspname || '.' || c.relname || '.' || a.attname || ' identity ' || a.attidentity::text as e
                     from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace where ${USER_SCHEMAS} and a.attidentity <> ''`),
      q("constraint", `select n.nspname || '.' || coalesce(c.relname, t.typname, '') || ':' || k.contype::text || ':' || pg_get_constraintdef(k.oid) as e
                       from pg_constraint k join pg_namespace n on n.oid = k.connamespace left join pg_class c on c.oid = k.conrelid left join pg_type t on t.oid = k.contypid
                      where ${USER_SCHEMAS} and k.contype <> 'n'`),
      q("index", `select pg_get_indexdef(i.indexrelid) as e from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace where ${USER_SCHEMAS} and ${NOT_EXTENSION("pg_class", "c.oid")}`),
      q("view", `select n.nspname || '.' || c.relname || ' = ' || pg_get_viewdef(c.oid) as e from pg_class c join pg_namespace n on n.oid = c.relnamespace where ${USER_SCHEMAS} and c.relkind in ('v', 'm')`),
      q("trigger", `select pg_get_triggerdef(t.oid) as e from pg_trigger t where not t.tgisinternal`),
      q("rule", `select r.rulename || ' on ' || r.ev_class::regclass::text as e from pg_rewrite r join pg_class c on c.oid = r.ev_class join pg_namespace n on n.oid = c.relnamespace where ${USER_SCHEMAS} and r.rulename <> '_RETURN'`),
      q("function", `select p.prokind::text || ':' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') ' || l.lanname || (case when p.prosecdef then ' security definer' else '' end) as e
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang where ${USER_SCHEMAS} and ${NOT_EXTENSION("pg_proc", "p.oid")}`),
      q("policy", `select p.polname || ' on ' || p.polrelid::regclass::text as e from pg_policy p`),
      q("rls", `select n.nspname || '.' || c.relname || (case when c.relforcerowsecurity then ' forced' else '' end) as e from pg_class c join pg_namespace n on n.oid = c.relnamespace where ${USER_SCHEMAS} and c.relrowsecurity`),
      q("extension", `select e.extname || ' in ' || n.nspname as e from pg_extension e join pg_namespace n on n.oid = e.extnamespace`),
      q("event_trigger", `select evtname as e from pg_event_trigger`),
      q("type", `select t.typtype::text || ':' || n.nspname || '.' || t.typname || coalesce(' = ' || (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid), '') as e
                 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                where ${USER_SCHEMAS} and t.typtype in ('e', 'd', 'b', 'r', 'm') and ${NOT_EXTENSION("pg_type", "t.oid")}`),
      q("cast", `select format_type(c.castsource, null) || '->' || format_type(c.casttarget, null) as e from pg_cast c where c.oid >= 16384 and ${NOT_EXTENSION("pg_cast", "c.oid")}`),
      q("operator", `select n.nspname || '.' || o.oprname as e from pg_operator o join pg_namespace n on n.oid = o.oprnamespace where ${USER_SCHEMAS} and ${NOT_EXTENSION("pg_operator", "o.oid")}`),
      q("language", `select lanname as e from pg_language where lanname not in ('internal', 'c', 'sql', 'plpgsql')`),
      q("foreign", `select 'server:' || srvname as e from pg_foreign_server union all select 'fdw:' || fdwname from pg_foreign_data_wrapper union all select 'mapping:' || srvname from pg_user_mappings`),
      q("publication", `select pubname as e from pg_publication union all select 'sub:' || subname from pg_subscription where subdbid = (select oid from pg_database where datname = current_database())`),
      q("owner", `select 'rel ' || n.nspname || '.' || c.relname || ' owned by another role' as e from pg_class c join pg_namespace n on n.oid = c.relnamespace where ${USER_SCHEMAS} and c.relowner <> (select oid from pg_roles where rolname = current_user)
                  union all select 'proc ' || n.nspname || '.' || p.proname || ' owned by another role' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ${USER_SCHEMAS} and p.proowner <> (select oid from pg_roles where rolname = current_user) and ${NOT_EXTENSION("pg_proc", "p.oid")}
                  union all select 'schema ' || n.nspname || ' owned by another role' from pg_namespace n where ${USER_SCHEMAS} and n.nspname <> 'public' and n.nspowner <> (select oid from pg_roles where rolname = current_user)`),
      q("acl", `select 'rel ' || n.nspname || '.' || c.relname || ' ' || c.relacl::text as e from pg_class c join pg_namespace n on n.oid = c.relnamespace where ${USER_SCHEMAS} and c.relacl is not null
                union all select 'proc ' || n.nspname || '.' || p.proname || ' ' || p.proacl::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ${USER_SCHEMAS} and p.proacl is not null and ${NOT_EXTENSION("pg_proc", "p.oid")}
                union all select 'schema ' || n.nspname || ' ' || n.nspacl::text from pg_namespace n where ${USER_SCHEMAS} and n.nspname <> 'public' and n.nspacl is not null`),
    ]);
    return Object.fromEntries(parts);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export interface SchemaComparison {
  /** In the restore, not in the reference: fails verification. */
  extra: string[];
  /** In the reference, not in the restore: reported only. */
  missing: string[];
}

export function compareCatalogs(restored: CatalogSnapshot, reference: CatalogSnapshot): SchemaComparison {
  const extra: string[] = [];
  const missing: string[] = [];
  for (const cat of new Set([...Object.keys(restored), ...Object.keys(reference)])) {
    const r = restored[cat] ?? new Set<string>();
    const ref = reference[cat] ?? new Set<string>();
    for (const e of r) if (!ref.has(e)) extra.push(`${cat}: ${e}`);
    for (const e of ref) if (!r.has(e)) missing.push(`${cat}: ${e}`);
  }
  return { extra: extra.sort(), missing: missing.sort() };
}

export interface SchemaVerification extends SchemaComparison {
  ok: boolean;
  appliedMigrations: number;
  unknownMigrations: string[];
  problems: string[];
}

/** The whole post-restore check: migrations from the restored table, a reference from our files, a catalog diff. */
/**
 * Re-create, in the restored database, the objects replay does not run
 * from a dump (CHECK constraints, views, functions, triggers; GH #907), taking their
 * definitions ONLY from the reference database, which was built from our own
 * migrations. Nothing here comes from the dump. Run only after the restore
 * passed the "no unexplained objects" check. Returns what it created.
 */
export async function repairFromReference(restoredUrl: string, referenceUrl: string): Promise<string[]> {
  const ref = connect(referenceUrl);
  const res = connect(restoredUrl);
  const created: string[] = [];
  try {
    const userNs = `n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'`;
    const functions = `select p.oid, format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as key, pg_get_functiondef(p.oid) as def
                         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ${userNs} and p.prokind in ('f', 'p') and ${NOT_EXTENSION("pg_proc", "p.oid")}`;
    const views = `select format('%I.%I', n.nspname, c.relname) as key, c.relkind::text as kind, pg_get_viewdef(c.oid) as def
                     from pg_class c join pg_namespace n on n.oid = c.relnamespace where ${userNs} and c.relkind in ('v', 'm') order by c.oid`;
    const checks = `select format('%I.%I', n.nspname, c.relname) || '.' || quote_ident(k.conname) as key, format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s', n.nspname, c.relname, k.conname, pg_get_constraintdef(k.oid)) as def
                      from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace where ${userNs} and k.contype = 'c'`;
    const triggers = `select format('%I.%I', n.nspname, c.relname) || '.' || quote_ident(t.tgname) as key, pg_get_triggerdef(t.oid) as def
                        from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and ${userNs}`;
    for (const [what, q, build] of [
      ["function", functions, (r: { def: string }) => r.def],
      ["view", views, (r: { key: string; kind: string; def: string }) => `CREATE ${r.kind === "m" ? "MATERIALIZED VIEW" : "VIEW"} ${r.key} AS ${r.def}`],
      ["check", checks, (r: { def: string }) => r.def],
      ["trigger", triggers, (r: { def: string }) => r.def],
    ] as const) {
      const have = new Set((await res.unsafe<Array<{ key: string }>>(q)).map((r) => r.key));
      for (const row of await ref.unsafe<Array<{ key: string; kind: string; def: string }>>(q)) {
        if (have.has(row.key)) continue;
        await res.unsafe((build as (r: typeof row) => string)(row));
        created.push(`${what} ${row.key}`);
      }
    }
    return created;
  } finally {
    await ref.end({ timeout: 5 });
    await res.end({ timeout: 5 });
  }
}

/**
 * The whole post-restore check: migrations from the restored table, a
 * reference from our files, a catalog diff (any unexplained object fails),
 * then the trusted re-creation of what replay does not run from a dump, and a
 * second diff that must now be exact.
 */
export async function verifyRestoredSchema(opts: { restoredUrl: string; referenceUrl: string; migrationsDir: string; repair?: boolean }): Promise<SchemaVerification & { repaired: string[] }> {
  const ours = loadBoxMigrations(opts.migrationsDir);
  const { applied, unknown, duplicates, outOfOrder } = await restoredMigrations(opts.restoredUrl, ours);
  const problems: string[] = [];
  if (unknown.length) problems.push(`${unknown.length} applied migration(s) are not in this repository (${unknown.slice(0, 3).map((h) => h.slice(0, 12)).join(", ")})`);
  if (duplicates.length) problems.push(`${duplicates.length} migration(s) recorded twice`);
  if (outOfOrder.length) {
    const tag = ours.find((m) => m.hash === outOfOrder[0])?.tag;
    problems.push(`${outOfOrder.length} applied migration(s) are not an unbroken prefix of this repository's journal (first: ${tag ?? outOfOrder[0]!.slice(0, 12)})`);
  }
  if (!applied.length && !outOfOrder.length) problems.push("no known migrations are recorded as applied");
  if (problems.length) return { ok: false, appliedMigrations: applied.length, unknownMigrations: unknown, problems, extra: [], missing: [], repaired: [] };
  await buildReference(opts.referenceUrl, applied);
  const [restored, reference] = await Promise.all([catalogSnapshot(opts.restoredUrl), catalogSnapshot(opts.referenceUrl)]);
  const cmp = compareCatalogs(restored, reference);
  if (cmp.extra.length) {
    problems.push(`${cmp.extra.length} object(s) in the restore that our migrations do not create`);
    return { ok: false, appliedMigrations: applied.length, unknownMigrations: [], problems, ...cmp, repaired: [] };
  }
  if (opts.repair === false || cmp.missing.length === 0) return { ok: true, appliedMigrations: applied.length, unknownMigrations: [], problems, ...cmp, repaired: [] };
  const repaired = await repairFromReference(opts.restoredUrl, opts.referenceUrl);
  const after = compareCatalogs(await catalogSnapshot(opts.restoredUrl), reference);
  if (after.extra.length || after.missing.length) problems.push(`after re-creating ${repaired.length} object(s) from our migrations the schema still differs (${after.extra.length} extra, ${after.missing.length} missing)`);
  return { ok: problems.length === 0, appliedMigrations: applied.length, unknownMigrations: [], problems, ...after, repaired };
}
