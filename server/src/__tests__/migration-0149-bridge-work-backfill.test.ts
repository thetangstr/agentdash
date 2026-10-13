import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, bridgeEndpoints, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateWithRetry } from "./helpers/truncate.js";

/**
 * Migration 0149 (coworker bridge, decision D8): every live endpoint that
 * already reads its owner's steward inbox gains `bridge:work` on deploy, and
 * each upgrade is one activity-log row, so the widening is auditable per
 * endpoint. Run against a real Postgres: the `?` jsonb operator and the
 * activity_log columns are the properties at stake.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type TestDb = ReturnType<typeof createDb>;

const MIGRATION = fs.readFileSync(
  fileURLToPath(
    new URL("../../../packages/db/src/migrations/0149_bridge_work_capability_backfill.sql", import.meta.url),
  ),
  "utf8",
);
const ACTOR = "migration:0149_bridge_work_capability_backfill";

describeEmbeddedPostgres("migration 0149: bridge:work backfill for inbox endpoints", () => {
  let db!: TestDb;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-migration-0149-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await truncateWithRetry(db, sql`${companies}`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function runMigration() {
    for (const statement of MIGRATION.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
      await db.execute(sql.raw(statement));
    }
  }

  async function company() {
    return db
      .insert(companies)
      .values({ name: `Backfill ${randomUUID()}`, issuePrefix: `BW${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function endpoint(companyId: string, capabilities: string[], extra: { revokedAt?: Date; enrolledAt?: Date | null } = {}) {
    return db
      .insert(bridgeEndpoints)
      .values({
        companyId,
        userId: `person-${randomUUID().slice(0, 8)}`,
        label: `laptop-${randomUUID().slice(0, 8)}`,
        tokenHash: `hash-${randomUUID()}`,
        capabilities,
        enrolledAt: extra.enrolledAt === undefined ? new Date() : extra.enrolledAt,
        revokedAt: extra.revokedAt ?? null,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function capabilitiesOf(id: string) {
    return db
      .select({ capabilities: bridgeEndpoints.capabilities })
      .from(bridgeEndpoints)
      .where(eq(bridgeEndpoints.id, id))
      .then((rows) => rows[0]!.capabilities);
  }

  it("adds bridge:work to every live inbox endpoint, one activity row each, and a re-run changes nothing", async () => {
    const c = await company();
    const inbox = await endpoint(c.id, ["bridge:read", "bridge:inbox"]);
    const pending = await endpoint(c.id, ["bridge:read", "bridge:inbox"], { enrolledAt: null });
    const readOnly = await endpoint(c.id, ["bridge:read"]);
    const revoked = await endpoint(c.id, ["bridge:read", "bridge:inbox"], { revokedAt: new Date() });
    const already = await endpoint(c.id, ["bridge:read", "bridge:inbox", "bridge:work"]);

    await runMigration();

    expect(await capabilitiesOf(inbox.id)).toEqual(["bridge:read", "bridge:inbox", "bridge:work"]);
    expect(await capabilitiesOf(pending.id)).toEqual(["bridge:read", "bridge:inbox", "bridge:work"]);
    // Never widened: a machine that cannot read the inbox, and a dead credential.
    expect(await capabilitiesOf(readOnly.id)).toEqual(["bridge:read"]);
    expect(await capabilitiesOf(revoked.id)).toEqual(["bridge:read", "bridge:inbox"]);
    // Not duplicated.
    expect(await capabilitiesOf(already.id)).toEqual(["bridge:read", "bridge:inbox", "bridge:work"]);

    const rows = await db.select().from(activityLog).where(eq(activityLog.actorId, ACTOR));
    expect(rows.map((row) => row.entityId).sort()).toEqual([inbox.id, pending.id].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        companyId: c.id,
        actorType: "system",
        action: "bridge.endpoint_capability_added",
        entityType: "bridge_endpoint",
      });
      expect(row.details).toMatchObject({ capability: "bridge:work", reason: "upgrade_backfill" });
    }
    const inboxRow = rows.find((row) => row.entityId === inbox.id)!;
    expect(inboxRow.details).toMatchObject({ label: inbox.label, userId: inbox.userId });

    await runMigration();
    expect(await db.select().from(activityLog).where(eq(activityLog.actorId, ACTOR))).toHaveLength(2);
    expect(await capabilitiesOf(inbox.id)).toEqual(["bridge:read", "bridge:inbox", "bridge:work"]);
  });
});
