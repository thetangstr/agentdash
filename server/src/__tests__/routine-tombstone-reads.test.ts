import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, issues, routineRuns, routineTriggers, routines } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { addAgent, addCompany } from "./helpers/agent-profile-fixtures.js";
import { routineService } from "../services/routines.js";
import { loadAssignedRoutines } from "../services/agent-profile-derived.js";
import { loadAgentPerformanceProjectionInput } from "../services/agent-performance-projection.js";
import { stepRoutineBindings } from "../services/agent-profile-application.js";

/**
 * Review of be7e918cc, finding 2: a deleted (tombstoned) routine is not a
 * current responsibility and not a valid reference, while its history stays.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("deleted routines in the reads that treat routines as current", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  let companyId = "";
  let agentId = "";
  let deletedId = "";
  let archivedId = "";
  let deletedTriggerId = "";
  let keptTriggerId = "";
  let issueId = "";

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "routine-tombstone-"));
    process.env.PAPERCLIP_HOME = home;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-tombstone-");
    db = createDb(tempDb.connectionString);
    companyId = (await addCompany(db, "Tombstone", "default")).id;
    agentId = (await addAgent(db, companyId, { name: "Doer", status: "paused" })).id;
    const insert = (title: string, status = "active") => db.insert(routines).values({ companyId, title, status, assigneeAgentId: agentId }).returning().then((r) => r[0]!);
    const deleted = await insert("Gone routine");
    const archived = await insert("Archived routine", "archived");
    deletedId = deleted.id;
    archivedId = archived.id;
    deletedTriggerId = (await db.insert(routineTriggers).values({ companyId, routineId: deleted.id, kind: "schedule", cronExpression: "0 9 * * *", timezone: "UTC" }).returning())[0]!.id;
    keptTriggerId = (await db.insert(routineTriggers).values({ companyId, routineId: archived.id, kind: "schedule", cronExpression: "0 9 * * *", timezone: "UTC" }).returning())[0]!.id;
    issueId = (await db.insert(issues).values({ companyId, title: "Made by it", status: "done", priority: "medium", originKind: "routine_execution", originId: deleted.id }).returning())[0]!.id;
    await db.insert(routineRuns).values({ companyId, routineId: deleted.id, source: "schedule", status: "completed", linkedIssueId: issueId, triggeredAt: new Date() });
    expect(await routineService(db).remove(deleted.id)).not.toBeNull();
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  it("is not among an agent's routines, even where archived ones are listed", async () => {
    const all = await loadAssignedRoutines(db, companyId, agentId, { includeArchived: true });
    expect(all.map((row) => row.id)).toEqual([archivedId]);
  });

  it("is not in the agent's performance view", async () => {
    const input = await loadAgentPerformanceProjectionInput(db, { companyId, agentId, asOf: new Date(), windowDays: 30 });
    expect(JSON.stringify(input)).not.toContain("Gone routine");
    expect(JSON.stringify(input)).not.toContain(deletedId);
  });

  it("cannot be referenced by a profile application; a live routine's trigger still can", async () => {
    const body = (triggerId: string) => ({ responsibilities: [{ obligation: { kind: "routine", routineTriggerId: triggerId } }] }) as never;
    await expect(stepRoutineBindings({ db, companyId, agentId }, body(deletedTriggerId))).rejects.toMatchObject({ status: 422 });
    await expect(stepRoutineBindings({ db, companyId, agentId }, body(keptTriggerId))).resolves.toMatchObject({ status: "done" });
  });

  it("keeps its history: runs and the issues they created", async () => {
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, deletedId))).toHaveLength(1);
    expect(await db.select().from(issues).where(eq(issues.id, issueId))).toHaveLength(1);
    const [row] = await db.select({ status: routines.status, deletedAt: routines.deletedAt }).from(routines).where(eq(routines.id, deletedId));
    expect(row!.status).toBe("archived");
    expect(row!.deletedAt).not.toBeNull();
    void randomUUID;
  });
});
