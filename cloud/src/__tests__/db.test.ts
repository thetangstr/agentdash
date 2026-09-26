import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptField, encryptField, parseDataKey, sha256Hex } from "../crypto.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { accounts, boxes, jobs, settings, waitlist } from "../db/schema.js";
import { SETTING_DEFAULTS, settingsService } from "../settings.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";

let pg: TestDatabase;
let db: CloudDb;
let close: () => Promise<void>;

beforeAll(async () => {
  pg = await startTestDatabase();
  await migrateCloudDb(pg.url);
  ({ db, close } = createCloudDb(pg.url));
});

afterAll(async () => {
  await close?.();
  await pg?.stop();
});

describe("migrations", () => {
  it("create every §3.2 table in the control plane's own database", async () => {
    const rows = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "accounts",
      "box_events",
      "boxes",
      "email_tokens",
      "invite_codes",
      "jobs",
      "operator_audit",
      "railway_workspaces",
      "settings",
      "waitlist",
    ]);
  });

  it("are idempotent on a second run", async () => {
    await expect(migrateCloudDb(pg.url)).resolves.toBeUndefined();
  });

  it("make email case-insensitively unique (citext)", async () => {
    await db.insert(accounts).values({ email: "Founder@Example.com" });
    await expect(db.insert(accounts).values({ email: "founder@example.COM" })).rejects.toThrow();
    const [row] = await db.select().from(accounts).where(eq(accounts.email, "FOUNDER@example.com"));
    expect(row?.status).toBe("pending_verification");
  });

  it("enforce the state machine's vocabulary", async () => {
    const [acct] = await db.insert(accounts).values({ email: "states@example.com" }).returning();
    await expect(
      db.insert(boxes).values({ accountId: acct!.id, slug: "bad-state", state: "exploded" as never }),
    ).rejects.toThrow();
    const [box] = await db.insert(boxes).values({ accountId: acct!.id, slug: "states" }).returning();
    expect(box).toMatchObject({ state: "requested", kind: "dedicated", planTier: "free", holdUpgrades: false });
    await expect(db.insert(jobs).values({ boxId: box!.id, kind: "teleport" as never })).rejects.toThrow();
  });

  it("allow one live job per box and kind, and any number of finished ones", async () => {
    const [acct] = await db.insert(accounts).values({ email: "jobs@example.com" }).returning();
    const [box] = await db.insert(boxes).values({ accountId: acct!.id, slug: "jobs" }).returning();
    const [first] = await db.insert(jobs).values({ boxId: box!.id, kind: "provision" }).returning();
    expect(first).toMatchObject({ state: "queued", attempt: 0 });
    await expect(db.insert(jobs).values({ boxId: box!.id, kind: "provision" })).rejects.toThrow();
    await db.update(jobs).set({ state: "running" }).where(eq(jobs.id, first!.id));
    await db.update(jobs).set({ state: "succeeded" }).where(eq(jobs.id, first!.id));
    await expect(db.insert(jobs).values({ boxId: box!.id, kind: "provision" })).resolves.toBeDefined();
  });

  it("support SKIP LOCKED claiming on the job queue", async () => {
    const [acct] = await db.insert(accounts).values({ email: "queue@example.com" }).returning();
    const [box] = await db.insert(boxes).values({ accountId: acct!.id, slug: "queue" }).returning();
    await db.insert(jobs).values([
      { boxId: box!.id, kind: "suspend" },
      { boxId: box!.id, kind: "resume" },
    ]);
    const a = postgres(pg.url, { max: 1 });
    const b = postgres(pg.url, { max: 1 });
    try {
      const claim = `select id from jobs where state = 'queued' and run_after <= now() and box_id = '${box!.id}'
                     order by run_after limit 1 for update skip locked`;
      await a.begin(async (ta) => {
        const [ja] = await ta.unsafe(claim);
        await b.begin(async (tb) => {
          const [jb] = await tb.unsafe(claim);
          expect(ja?.id).toBeDefined();
          expect(jb?.id).toBeDefined();
          expect(jb?.id).not.toBe(ja?.id);
        });
      });
    } finally {
      await a.end();
      await b.end();
    }
  });
});

describe("settings", () => {
  it("return the launch defaults when nothing is stored", async () => {
    await db.delete(settings);
    const all = await settingsService(db).getAll();
    expect(all).toEqual(SETTING_DEFAULTS);
    expect(all).toMatchObject({ waitlist_mode: true, daily_cap: 10, max_concurrent_jobs: 3, provisioning_enabled: false });
  });

  it("validate and persist changes", async () => {
    const svc = settingsService(db);
    await svc.set("daily_cap", "25", "test");
    await svc.set("waitlist_mode", false, "test");
    await svc.set("target_release", "v2026.925.0", "test");
    expect(await svc.get("daily_cap")).toBe(25);
    expect(await svc.get("waitlist_mode")).toBe(false);
    expect(await svc.get("target_release")).toBe("v2026.925.0");
    await svc.set("target_release", "null", "test");
    expect(await svc.get("target_release")).toBeNull();
    await expect(svc.set("daily_cap", "-1", "test")).rejects.toThrow(/integer/);
    await expect(svc.set("max_concurrent_jobs", 0, "test")).rejects.toThrow(/integer/);
    await expect(svc.set("provisioning_enabled", "yes", "test")).rejects.toThrow(/true or false/);
    await expect(svc.set("target_release", "latest", "test")).rejects.toThrow(/stable tag/);
  });
});

describe("encrypted columns", () => {
  it("round-trip through the database and never hold plaintext", async () => {
    const key = parseDataKey("ab".repeat(32));
    const code = "AGD-00112233445566778899aabbcc";
    const edge = "edge-secret-fake-value-000111";
    const [acct] = await db.insert(accounts).values({ email: "enc@example.com" }).returning();
    const [box] = await db
      .insert(boxes)
      .values({
        accountId: acct!.id,
        slug: "enc",
        claimCodeEnc: encryptField(key, code, "boxes.claim_code_enc"),
        claimCodeHash: sha256Hex(code),
        edgeSecretEnc: encryptField(key, edge, "boxes.edge_secret_enc"),
      })
      .returning();
    const raw = await db.execute<Record<string, string>>(
      sql`select claim_code_enc, edge_secret_enc, claim_code_hash from boxes where id = ${box!.id}`,
    );
    const dump = JSON.stringify(raw);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(edge);
    const [row] = await db.select().from(boxes).where(eq(boxes.id, box!.id));
    expect(decryptField(key, row!.claimCodeEnc!, "boxes.claim_code_enc")).toBe(code);
    expect(decryptField(key, row!.edgeSecretEnc!, "boxes.edge_secret_enc")).toBe(edge);
    expect(row!.claimCodeHash).toBe(sha256Hex(code));
    expect(() => decryptField(parseDataKey("cd".repeat(32)), row!.claimCodeEnc!, "boxes.claim_code_enc")).toThrow();
  });
});

describe("waitlist", () => {
  it("defaults to waiting", async () => {
    const [w] = await db.insert(waitlist).values({ email: "Wait@Example.com", requestedSlug: "wait" }).returning();
    expect(w?.state).toBe("waiting");
  });
});
