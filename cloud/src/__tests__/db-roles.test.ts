// GH #763 precondition 1: the owner/runtime role split. The runtime role can
// read and append to the audit tables and nothing more: no UPDATE, DELETE,
// TRUNCATE, no ALTER/DROP (it owns nothing), no trigger changes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { MIGRATIONS_FOLDER, migrateCloudDb, migrateWithRoles, verifyRuntimeDb } from "../db/client.js";
import { pendingMigrations, runtimeRoleProblems, scramVerifier } from "../db/roles.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";

const RUNTIME_PASSWORD = "rtpw0123456789abcdefABCDEF0123"; // synthetic

let tdb: TestDatabase;
let runtimeUrl: string;
let rt: postgres.Sql;
let su: postgres.Sql;

function withUser(url: string, user: string, password: string, db?: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  if (db) u.pathname = `/${db}`;
  return u.toString();
}

async function denied(p: Promise<unknown>): Promise<string> {
  const err = (await p.then(
    () => null,
    (e: unknown) => e,
  )) as { code?: string } | null;
  expect(err, "expected the statement to be refused").not.toBeNull();
  return err!.code ?? "";
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  // A database as SC-1 left it: migrated by the superuser, which owns everything.
  await migrateCloudDb(tdb.url);
  su = postgres(tdb.url, { max: 1, onnotice: () => {} });
  await su`insert into box_events (kind, actor) values ('before_split', 'test')`;
  const { transferred } = await migrateWithRoles(tdb.url, { runtimePassword: RUNTIME_PASSWORD });
  expect(transferred).toBeGreaterThan(5);
  runtimeUrl = withUser(tdb.url, "cloud_app", RUNTIME_PASSWORD);
  rt = postgres(runtimeUrl, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await rt?.end({ timeout: 5 });
  await su?.end({ timeout: 5 });
  await tdb?.stop();
});

describe("role split", () => {
  it("hands every control-plane table, sequence and trigger function to cloud_owner", async () => {
    const notOwned = await su`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'drizzle') and c.relkind in ('r', 'S')
         and pg_get_userbyid(c.relowner) <> 'cloud_owner'`;
    expect(notOwned).toEqual([]);
    const fns = await su`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'cloud_%' and pg_get_userbyid(p.proowner) <> 'cloud_owner'`;
    expect(fns).toEqual([]);
    const [owner] = await su`select rolcanlogin from pg_roles where rolname = 'cloud_owner'`;
    expect(owner!.rolcanlogin).toBe(false);
  });

  it("the runtime role passes the boot check; the superuser does not", async () => {
    expect(await verifyRuntimeDb(runtimeUrl)).toEqual([]);
    const problems = await verifyRuntimeDb(tdb.url);
    expect(problems.join("\n")).toMatch(/superuser/);
  });

  it("the runtime role can INSERT and SELECT the audit tables", async () => {
    await rt`insert into box_events (kind, actor) values ('runtime_insert', 'test')`;
    await rt`insert into operator_audit (kind, actor) values ('admin_refused', 'test')`;
    const rows = await rt`select kind from box_events order by id`;
    expect(rows.map((r) => r.kind)).toEqual(["before_split", "runtime_insert"]);
    expect((await rt`select count(*)::int as n from operator_audit`)[0]!.n).toBe(1);
  });

  it("the runtime role cannot UPDATE, DELETE or TRUNCATE an audit table (privilege, not just the trigger)", async () => {
    for (const t of ["box_events", "operator_audit"]) {
      expect(await denied(rt.unsafe(`update ${t} set actor = 'x'`))).toBe("42501");
      expect(await denied(rt.unsafe(`delete from ${t}`))).toBe("42501");
      expect(await denied(rt.unsafe(`truncate ${t}`))).toBe("42501");
    }
    // The permission error, not the append-only trigger, is what stops it.
    const err = await rt`update box_events set actor = 'x'`.catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/permission denied/);
  });

  it("the runtime role cannot ALTER, DROP or touch triggers on an audit table", async () => {
    const attempts = [
      "alter table box_events disable trigger all",
      "alter table box_events disable trigger box_events_append_only",
      "drop trigger box_events_append_only on box_events",
      "drop table operator_audit",
      "alter table operator_audit add column x int",
      "create trigger t2 before insert on box_events for each row execute function cloud_append_only()",
      "create or replace function cloud_append_only() returns trigger language plpgsql as $$ begin return new; end $$",
      "create table sneaky (id int)",
      'set role "cloud_owner"',
    ];
    for (const stmt of attempts) {
      expect(await denied(rt.unsafe(stmt)), stmt).toBe("42501");
    }
  });

  it("the runtime role keeps ordinary read-write access to the working tables", async () => {
    const [acct] = await rt`insert into accounts (email) values ('rt@example.test') returning id`;
    const [box] = await rt`insert into boxes (account_id, slug) values (${acct!.id}, 'rtbox') returning id`;
    await rt`update boxes set state = 'provisioning' where id = ${box!.id}`;
    await rt`insert into settings (key, value) values ('daily_cap', '5'::jsonb)`;
    await rt`delete from settings where key = 'daily_cap'`;
    const [job] = await rt`insert into jobs (box_id, kind) values (${box!.id}, 'provision') returning id`;
    expect(job!.id).toBeTruthy();
  });

  it("is idempotent without the password once the roles exist", async () => {
    await expect(migrateWithRoles(tdb.url)).resolves.toMatchObject({ transferred: 0 });
    expect(await runtimeRoleProblems(rt)).toEqual([]);
  });

  it("builds a fresh database as the owner from the first migration (citext included)", async () => {
    await su.unsafe("create database cloud_fresh");
    const freshUrl = withUser(tdb.url, "cloud", "cloud", "cloud_fresh");
    const f = postgres(freshUrl, { max: 1, onnotice: () => {} });
    try {
      expect(await pendingMigrations(f, MIGRATIONS_FOLDER)).toMatch(/no migrations/);
      await migrateWithRoles(freshUrl, { runtimePassword: RUNTIME_PASSWORD });
      expect(await pendingMigrations(f, MIGRATIONS_FOLDER)).toBeNull();
      const [t] = await f`select pg_get_userbyid(relowner) as o from pg_class where relname = 'boxes'`;
      expect(t!.o).toBe("cloud_owner");
    } finally {
      await f.end({ timeout: 5 });
    }
    expect(await verifyRuntimeDb(withUser(tdb.url, "cloud_app", RUNTIME_PASSWORD, "cloud_fresh"))).toEqual([]);
  });

  it("writes the password as a SCRAM verifier, never the plaintext", async () => {
    const v = scramVerifier(RUNTIME_PASSWORD, 4096, Buffer.alloc(16, 1));
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(v).not.toContain(RUNTIME_PASSWORD);
    const [row] = await su`select rolpassword from pg_authid where rolname = 'cloud_app'`;
    expect(String(row!.rolpassword)).toMatch(/^SCRAM-SHA-256\$/);
  });
});
