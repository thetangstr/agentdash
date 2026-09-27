// AgentDash (consolidation PR-C): activity rows carry a server-set `origin`.
// Rows written by server code are "server"; the manual POST writes "manual";
// rows from before the migration stay NULL (origin unknown).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logActivity } from "../services/activity-log.ts";
import { activityService } from "../services/activity.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  path.resolve(here, "../../../packages/db/src/migrations/0136_activity_log_origin.sql"),
  "utf8",
);

describe("activity_log.origin migration", () => {
  it("adds a nullable column with no default, so nothing fails open to 'server'", () => {
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((chunk) => chunk.replace(/^--.*$/gm, "").trim())
      .filter(Boolean);
    expect(statements).toEqual(['ALTER TABLE "activity_log" ADD COLUMN "origin" text;']);
    expect(migrationSql).not.toMatch(/SET DEFAULT/i);
  });
});

describeEmbeddedPostgres("activity_log.origin", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-origin-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    await db.insert(companies).values({
      id: companyId,
      name: "Origin Co",
      issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  it("stamps server-emitted rows as server", async () => {
    await seedCompany();
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "issue.updated",
      entityType: "issue",
      entityId: randomUUID(),
    });
    const rows = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe("server");
  });

  it("an insert that does not set origin reads as unknown (NULL), never as a server record", async () => {
    await seedCompany();
    const [row] = await db
      .insert(activityLog)
      .values({
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.updated",
        entityType: "issue",
        entityId: randomUUID(),
      })
      .returning();
    expect(row!.origin).toBeNull();
    expect(row!.origin).not.toBe("server");
  });

  it("keeps the explicit origin each insert site sets", async () => {
    await seedCompany();
    const svc = activityService(db);
    const serverRow = await svc.create({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "company.updated",
      entityType: "company",
      entityId: companyId,
      origin: "server",
    });
    const manualRow = await svc.create({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "issue.updated",
      entityType: "issue",
      entityId: randomUUID(),
      origin: "manual",
    });
    expect(serverRow!.origin).toBe("server");
    expect(manualRow!.origin).toBe("manual");
  });
});
