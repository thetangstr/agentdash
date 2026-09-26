// GH #778: DB-enforced state transitions and append-only audit tables,
// tested against a real (embedded) Postgres with the package's migrations.
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import {
  ACCOUNT_INITIAL_STATES,
  ACCOUNT_STATUSES,
  ACCOUNT_TRANSITIONS,
  BOX_INITIAL_STATES,
  BOX_STATES,
  BOX_TRANSITIONS,
  JOB_INITIAL_STATES,
  JOB_STATES,
  JOB_TRANSITIONS,
} from "../db/schema.js";
import { settingsService } from "../settings.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";

let pg: TestDatabase;
let sql: postgres.Sql;
let db: CloudDb;
let close: () => Promise<void>;
let accountId: string;
let boxId: string;
let n = 0;

beforeAll(async () => {
  pg = await startTestDatabase();
  await migrateCloudDb(pg.url);
  sql = postgres(pg.url, { max: 1, onnotice: () => {} });
  ({ db, close } = createCloudDb(pg.url));
  const [a] = await sql`insert into accounts (email) values ('fixtures@example.com') returning id`;
  accountId = a!.id as string;
  const [b] = await sql`insert into boxes (account_id, slug) values (${accountId}, 'fixture') returning id`;
  boxId = b!.id as string;
});

afterAll(async () => {
  await sql?.end();
  await close?.();
  await pg?.stop();
});

/**
 * Insert a fixture row in an arbitrary state, bypassing the triggers the way
 * only a superuser can (session_replication_role = replica), so every
 * from-state can be tested without walking a path to it.
 */
async function fixture(table: "boxes" | "jobs" | "accounts", state: string): Promise<string> {
  n += 1;
  return await sql.begin(async (tx) => {
    // postgres.js types TransactionSql without a call signature; unsafe() is typed.
    await tx.unsafe("set local session_replication_role = replica");
    if (table === "boxes") {
      const [r] = await tx.unsafe("insert into boxes (account_id, slug, state) values ($1, $2, $3) returning id", [accountId, "b" + n, state]);
      return r!.id as string;
    }
    if (table === "jobs") {
      const [r] = await tx.unsafe("insert into jobs (box_id, kind, state) values ($1, 'upgrade', $2) returning id", [boxId, state]);
      return r!.id as string;
    }
    const [r] = await tx.unsafe("insert into accounts (email, status) values ($1, $2) returning id", [`a${n}@example.com`, state]);
    return r!.id as string;
  });
}

async function tryTransition(table: "boxes" | "jobs" | "accounts", id: string, to: string): Promise<null | { code: string; message: string }> {
  const col = table === "accounts" ? "status" : "state";
  try {
    await sql.unsafe(`update ${table} set ${col} = $1 where id = $2`, [to, id]);
    return null;
  } catch (err) {
    const e = err as { code: string; message: string };
    return { code: e.code, message: e.message };
  }
}

const TABLES = [
  { table: "boxes" as const, states: BOX_STATES, transitions: BOX_TRANSITIONS as Record<string, readonly string[]>, initial: BOX_INITIAL_STATES as readonly string[] },
  { table: "jobs" as const, states: JOB_STATES, transitions: JOB_TRANSITIONS as Record<string, readonly string[]>, initial: JOB_INITIAL_STATES as readonly string[] },
  { table: "accounts" as const, states: ACCOUNT_STATUSES, transitions: ACCOUNT_TRANSITIONS as Record<string, readonly string[]>, initial: ACCOUNT_INITIAL_STATES as readonly string[] },
];

describe("state transitions are enforced by the database", () => {
  for (const { table, states, transitions } of TABLES) {
    it(`${table}: every (from, to) pair matches the map in schema.ts`, async () => {
      const mismatches: string[] = [];
      for (const from of states) {
        for (const to of states) {
          const id = await fixture(table, from);
          const err = await tryTransition(table, id, to);
          const expected = from === to || transitions[from]!.includes(to);
          if (expected && err) mismatches.push(`${from} -> ${to} refused: ${err.message}`);
          if (!expected && !err) mismatches.push(`${from} -> ${to} allowed`);
          if (!expected && err && err.code !== "23514") mismatches.push(`${from} -> ${to} wrong error ${err.code}`);
          if (table === "jobs") {
            // The one-live-job index would reject the next queued/running
            // fixture for the same box and kind; retire this one.
            await sql.begin(async (tx) => {
              await tx.unsafe("set local session_replication_role = replica");
              await tx.unsafe("update jobs set state = 'dead' where id = $1", [id]);
            });
          }
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it("names the illegal transition in the error", async () => {
    const id = await fixture("boxes", "deleted");
    const err = await tryTransition("boxes", id, "active");
    expect(err).toMatchObject({ code: "23514" });
    expect(err!.message).toContain("illegal boxes.state transition: deleted -> active");
  });

  it("refuses rows inserted in a non-initial state, and accepts the initial ones", async () => {
    for (const { table, states, initial } of TABLES) {
      for (const state of states) {
        n += 1;
        let ok = true;
        try {
          if (table === "boxes") await sql`insert into boxes (account_id, slug, state) values (${accountId}, ${"i" + n}, ${state})`;
          else if (table === "accounts") await sql`insert into accounts (email, status) values (${`i${n}@example.com`}, ${state})`;
          else {
            const [b] = await sql`insert into boxes (account_id, slug) values (${accountId}, ${"j" + n}) returning id`;
            await sql`insert into jobs (box_id, kind, state) values (${b!.id}, 'provision', ${state})`;
          }
        } catch (err) {
          ok = false;
          expect((err as { code: string }).code).toBe("23514");
        }
        expect({ table, state, ok }).toEqual({ table, state, ok: initial.includes(state) });
      }
    }
  });

  it("allows writes that do not change the state, even in a terminal state", async () => {
    const id = await fixture("boxes", "deleted");
    await expect(sql`update boxes set cohort = 'late', state = 'deleted' where id = ${id}`).resolves.toBeDefined();
    const job = await fixture("jobs", "succeeded");
    await expect(sql`update jobs set last_error = 'x' where id = ${job}`).resolves.toBeDefined();
  });

  it("walks the happy path from signup to deletion", async () => {
    const [b] = await sql`insert into boxes (account_id, slug) values (${accountId}, 'happy') returning id`;
    for (const s of ["provisioning", "awaiting_claim", "active", "suspended", "active", "pending_delete", "deleted"]) {
      await sql`update boxes set state = ${s} where id = ${b!.id}`;
    }
    const [row] = await sql`select state from boxes where id = ${b!.id}`;
    expect(row!.state).toBe("deleted");
  });
});

describe("audit tables are append-only", () => {
  for (const table of ["box_events", "operator_audit"] as const) {
    it(`${table}: insert works; update, delete and truncate are refused`, async () => {
      const [row] = await sql.unsafe(`insert into ${table} (kind, actor) values ('${table === "box_events" ? "note" : "setting_changed"}', 'test') returning id`);
      const id = row!.id as number;
      for (const stmt of [
        `update ${table} set actor = 'tampered' where id = ${id}`,
        `delete from ${table} where id = ${id}`,
        `truncate ${table}`,
      ]) {
        await expect(sql.unsafe(stmt)).rejects.toMatchObject({ code: "42501" });
      }
      const [after] = await sql.unsafe(`select actor from ${table} where id = ${id}`);
      expect(after!.actor).toBe("test");
    });
  }

  it("records every setting change with the old and new value, the actor and the IP", async () => {
    const svc = settingsService(db);
    await svc.set("provisioning_enabled", "true", "admin-cli", { ip: "203.0.113.9" });
    await svc.set("provisioning_enabled", false, "admin-cli", { ip: "203.0.113.9" });
    await svc.set("target_release", "v2026.925.0", "admin-cli");
    await svc.set("target_release", null, "admin-cli");
    const rows = await sql`select kind, actor, ip, detail from operator_audit where kind = 'setting_changed' and actor = 'admin-cli' order by id`;
    expect(rows.map((r) => ({ ip: r.ip, detail: r.detail }))).toEqual([
      { ip: "203.0.113.9", detail: { setting: "provisioning_enabled", from: false, to: true } },
      { ip: "203.0.113.9", detail: { setting: "provisioning_enabled", from: true, to: false } },
      { ip: null, detail: { setting: "target_release", from: null, to: "v2026.925.0" } },
      { ip: null, detail: { setting: "target_release", from: "v2026.925.0", to: null } },
    ]);
  });

  it("writes no audit row and changes nothing when validation fails", async () => {
    const before = await sql`select count(*)::int as c from operator_audit`;
    await expect(settingsService(db).set("daily_cap", "lots", "admin-cli")).rejects.toThrow(/integer/);
    const after = await sql`select count(*)::int as c from operator_audit`;
    expect(after[0]!.c).toBe(before[0]!.c);
  });
});
