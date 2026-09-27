// SC-4 (GH #765): the router's database side. cloud_edge reads only the
// edge_routes view and calls two functions; the route table refreshes, looks
// up misses at once, and keeps serving when Postgres is down.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { encryptField, parseKeyring } from "../crypto.js";
import { migrateWithRoles } from "../db/client.js";
import { edgeRoleProblems } from "../db/roles.js";
import { pgRouteSource, RouteTable, type RouteSource } from "../edge/routes.js";
import { createLogger } from "../logger.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";

const KEYS = parseKeyring("77".repeat(32));
const EDGE_PW = "edgepw0123456789abcdefABCDEF01"; // synthetic
const RUNTIME_PW = "rtpw0123456789abcdefABCDEF0123"; // synthetic
const SECRET = "box-edge-secret-fake-0123456789abcdef0123456789abcdef";
const lines: string[] = [];
const log = createLogger({ write: (l) => lines.push(l), level: "debug" });

let tdb: TestDatabase;
let su: postgres.Sql;
let edge: postgres.Sql;

function asUser(user: string, password: string): string {
  const u = new URL(tdb.url);
  u.username = user;
  u.password = password;
  return u.toString();
}

async function box(slug: string, state: string, host: string | null = `web-${slug}.up.railway.app`) {
  const [a] = await su`insert into accounts (email) values (${`${slug}@example.test`}) returning id`;
  const [b] = await su`insert into boxes (account_id, slug) values (${a!.id}, ${slug}) returning id`;
  const path: Record<string, string[]> = {
    active: ["provisioning", "awaiting_claim", "active"],
    awaiting_claim: ["provisioning", "awaiting_claim"],
    suspended: ["provisioning", "awaiting_claim", "active", "suspended"],
    provisioning: ["provisioning"],
  };
  for (const s of path[state] ?? []) await su`update boxes set state = ${s} where id = ${b!.id}`;
  await su`update boxes set upstream_host = ${host}, edge_secret_enc = ${encryptField(KEYS, SECRET, "boxes.edge_secret_enc")} where id = ${b!.id}`;
  return b!.id as string;
}

beforeAll(async () => {
  tdb = await startTestDatabase();
  await migrateWithRoles(tdb.url, { runtimePassword: RUNTIME_PW, edgePassword: EDGE_PW });
  su = postgres(tdb.url, { max: 1, onnotice: () => {} });
  edge = postgres(asUser("cloud_edge", EDGE_PW), { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await edge?.end({ timeout: 5 });
  await su?.end({ timeout: 5 });
  await tdb?.stop();
});

async function refused(p: Promise<unknown>) {
  const err = (await p.then(() => null, (e: unknown) => e)) as { code?: string } | null;
  expect(err, "expected a refusal").not.toBeNull();
  return err!.code;
}

describe("the cloud_edge role", () => {
  it("passes its own boot check and reads the view", async () => {
    expect(await edgeRoleProblems(edge)).toEqual([]);
    await box("viewbox", "active");
    const rows = await edge`select slug, state, upstream_host from edge_routes where slug = 'viewbox'`;
    expect(rows).toEqual([{ slug: "viewbox", state: "active", upstream_host: "web-viewbox.up.railway.app" }]);
  });

  it("cannot read or write any table, or change the view", async () => {
    for (const stmt of [
      "select * from boxes",
      "select * from accounts",
      "select * from settings",
      "update boxes set state = 'active'",
      "insert into jobs (box_id, kind) values (gen_random_uuid(), 'resume')",
      "update edge_routes set upstream_host = 'evil.example'",
      "delete from edge_routes",
      "create table sneaky (id int)",
    ]) {
      expect(await refused(edge.unsafe(stmt)), stmt).toBe("42501");
    }
  });

  it("records activity only for running, handed-over boxes", async () => {
    const active = await box("busyone", "active");
    const young = await box("youngone", "provisioning");
    const [r] = await edge`select edge_record_activity(${["busyone", "youngone", "nosuch"]}::text[]) as n`;
    expect(r!.n).toBe(1);
    const rows = await su`select id, last_human_request_at from boxes where id in (${active}, ${young})`;
    const byId = Object.fromEntries(rows.map((x) => [x.id, x.last_human_request_at]));
    expect(byId[active]).not.toBeNull();
    expect(byId[young]).toBeNull();
  });

  it("asks to resume a suspended box once (one live resume job)", async () => {
    const id = await box("sleeper", "suspended");
    expect((await edge`select edge_request_resume('sleeper') as ok`)[0]!.ok).toBe(true);
    expect((await edge`select edge_request_resume('sleeper') as ok`)[0]!.ok).toBe(true);
    expect((await edge`select edge_request_resume('busyone') as ok`)[0]!.ok).toBe(false);
    const jobs = await su`select kind, state from jobs where box_id = ${id}`;
    expect(jobs).toEqual([{ kind: "resume", state: "queued" }]);
  });

  it("the runtime role cannot call the router's functions", async () => {
    const rt = postgres(asUser("cloud_app", RUNTIME_PW), { max: 1, onnotice: () => {} });
    try {
      expect(await refused(rt`select edge_request_resume('sleeper')`)).toBe("42501");
    } finally {
      await rt.end({ timeout: 5 });
    }
  });
});

describe("route table", () => {
  it("refreshes, decrypts edge secrets, looks up a new box on a miss, and never prints a secret", async () => {
    await box("tableone", "active");
    const table = new RouteTable({ source: pgRouteSource(edge), dataKeys: KEYS, log });
    expect(await table.refresh()).toBe(true);
    const r = await table.lookup("tableone");
    expect(r).toMatchObject({ slug: "tableone", state: "active", upstreamHost: "web-tableone.up.railway.app" });
    expect(r!.edgeSecret!.reveal()).toBe(SECRET);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    // Published after the refresh: routable at once.
    await box("latebox", "awaiting_claim");
    expect((await table.lookup("latebox"))?.state).toBe("awaiting_claim");
    expect(await table.lookup("nosuchbox")).toBeNull();
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  it("keeps serving the last good table when Postgres is down", async () => {
    await box("cached", "active");
    let down = false;
    const real = pgRouteSource(edge);
    const source: RouteSource = {
      all: async () => {
        if (down) throw new Error("connection refused");
        return real.all();
      },
      one: async (slug) => {
        if (down) throw new Error("connection refused");
        return real.one(slug);
      },
    };
    const table = new RouteTable({ source, dataKeys: KEYS, log });
    await table.refresh();
    down = true;
    expect(await table.refresh()).toBe(false);
    expect((await table.lookup("cached"))?.upstreamHost).toBe("web-cached.up.railway.app");
    expect(await table.lookup("unknown-while-down")).toBeNull();
    expect(table.size).toBeGreaterThan(0);
  });

  it("a box whose edge secret does not decrypt is not routable", async () => {
    await box("badkey", "active");
    const table = new RouteTable({ source: pgRouteSource(edge), dataKeys: parseKeyring("88".repeat(32)), log });
    await table.refresh();
    expect((await table.lookup("badkey"))?.edgeSecret).toBeNull();
  });
});
