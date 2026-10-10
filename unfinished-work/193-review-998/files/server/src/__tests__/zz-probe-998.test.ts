import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, agentTaskSessions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { resetInstanceSecretsCacheForTests } from "../services/run-log-redaction.ts";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("probe #998", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "probe998-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "probe998";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "c".repeat(64);
    process.env.HERMES_PROFILES_DIR = join(home, "none");
    resetInstanceSecretsCacheForTests();
    tempDb = await startEmbeddedPostgresTestDatabase("probe998-");
    console.log("PG port", tempDb.connectionString.replace(/:[^:@/]+@/, ":***@"));
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 1000));
    await tempDb?.cleanup();
    await rm(home, { recursive: true, force: true });
  });

  async function seed(script: string) {
    const company = await db.insert(companies).values({ name: "P", issuePrefix: `P${randomUUID().slice(0, 5).toUpperCase()}`, requireBoardApprovalForNewAgents: false }).returning().then((r) => r[0]!);
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: company.id, name: "E", role: "engineer", status: "idle", adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", script] }, runtimeConfig: {}, permissions: {} });
    return { company, agentId };
  }

  it("getRun on a running row redacts contextSnapshot.taskKey (executeRun path)", async () => {
    const { company, agentId } = await seed("process.exit(0)");
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId: company.id, agentId, invocationSource: "on_demand", status: "running",
      contextSnapshot: { taskKey: "issue-task-A", issueId: randomUUID(), wakeReason: "x" } });
    const hb = heartbeatService(db, { autoDispatchQueuedRuns: false } as any);
    const run = await hb.getRun(id);
    console.log("GETRUN contextSnapshot", JSON.stringify(run?.contextSnapshot));
    const served = await (hb as any).getRunForResponse(id);
    console.log("GETRUNFORRESPONSE contextSnapshot", JSON.stringify(served?.contextSnapshot));
  });

  it("end-to-end: two tasks, what taskKey does execution use", async () => {
    // Process adapter prints nothing secret; we inspect the taskKey the run recorded in sessions/runtime.
    const { agentId } = await seed("console.log('hi'); process.exit(0)");
    const hb = heartbeatService(db);
    const q = await hb.invoke(agentId, "on_demand", { taskKey: "task-A" }, "manual");
    const deadline = Date.now() + 15000;
    let r: any;
    while (Date.now() < deadline) { r = await hb.getRun(q!.id, { unsafeFullResultJson: true }); if (!["queued","running"].includes(r.status)) break; await new Promise((x) => setTimeout(x, 100)); }
    console.log("RUN status", r.status, "raw ctx taskKey", (r.contextSnapshot as any)?.taskKey);
    const sessions = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, agentId));
    console.log("SESSIONS", JSON.stringify(sessions.map((s) => s.taskKey)));
  });

  it("readLog NDJSON stays parseable for quoted secret assignment", async () => {
    const { agentId } = await seed(`console.log('echo "API_KEY=abcdef123456"'); console.log('ok line'); process.exit(0)`);
    const hb = heartbeatService(db);
    const q = await hb.invoke(agentId, "on_demand", {}, "manual");
    const deadline = Date.now() + 15000;
    let r: any;
    while (Date.now() < deadline) { r = await hb.getRun(q!.id); if (!["queued","running"].includes(r.status)) break; await new Promise((x) => setTimeout(x, 100)); }
    const log = await hb.readLog(q!.id);
    const bad = log.content.split("\n").filter(Boolean).filter((l: string) => { try { JSON.parse(l); return false; } catch { return true; } });
    console.log("READLOG unparseable lines:", bad.length, JSON.stringify(bad));
  });
});
