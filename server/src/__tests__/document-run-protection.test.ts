// AgentDash (per-steward document access, slice 6b): the three protections
// that gate `document_access_enabled`, against a real database and the real
// heartbeat, routers and run-log store.
//
// 1. Persist-time strip: a run whose output carries framed document text
//    (including a begin marker split across two stdout writes) leaves no
//    sentinel in heartbeat_run_events, the run row or the log file on disk;
//    an unmatched marker is left intact.
// 2. Readership: with the flag on, run detail/events/log answer 404 to a
//    company member who is not the agent's current steward (and to a company
//    admin), 200 to the steward and to an instance admin; flag off unchanged.
// 3. Retention: the purge deletes only rows/files older than the window, and
//    only for flagged companies.
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentStewardships,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { featureFlagsService } from "../services/feature-flags.ts";
import { frameUntrustedDocumentText } from "../services/document-content.ts";
import { pruneDocumentRunData } from "../services/document-run-retention.ts";
import { resetRunLogStoreForTests, runLogBasePath } from "../services/run-log-store.ts";
import { resetInstanceSecretsCacheForTests } from "../services/run-log-redaction.ts";
import { agentRoutes } from "../routes/agents.js";
import { activityRoutes } from "../routes/activity.js";
import { errorHandler } from "../middleware/index.js";
import { createLiveEventVisibility } from "../realtime/live-event-visibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SENTINEL = "SENTINEL-confidential-body-7c2e";
const DAY_MS = 24 * 60 * 60 * 1000;

async function waitForRunToFinish(heartbeat: ReturnType<typeof heartbeatService>, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("document run protection (slice 6b)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home: string;
  const saved: Record<string, string | undefined> = {};

  const FLAGGED = randomUUID();
  const UNFLAGGED = randomUUID();
  const STEWARD = "steward-user";
  const SECOND_STEWARD = "second-steward-user";
  const MEMBER = "member-user";
  const COMPANY_ADMIN = "company-admin-user";
  const FLAGGED_AGENT = randomUUID();
  const UNFLAGGED_AGENT = randomUUID();

  beforeAll(async () => {
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_SECRETS_MASTER_KEY", "RUN_LOG_BASE_PATH"]) {
      saved[key] = process.env[key];
    }
    home = await mkdtemp(join(tmpdir(), "document-run-protection-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "document-run-protection-test";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "c".repeat(64);
    process.env.RUN_LOG_BASE_PATH = join(home, "run-logs");
    resetRunLogStoreForTests();
    resetInstanceSecretsCacheForTests();
    tempDb = await startEmbeddedPostgresTestDatabase("document-run-protection-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values([
      { id: FLAGGED, name: "Flagged Co", issuePrefix: "DRF", requireBoardApprovalForNewAgents: false },
      { id: UNFLAGGED, name: "Plain Co", issuePrefix: "DRP", requireBoardApprovalForNewAgents: false },
    ]);
    for (const companyId of [FLAGGED, UNFLAGGED]) {
      for (const [userId, role] of [
        [STEWARD, "member"],
        [SECOND_STEWARD, "member"],
        [MEMBER, "member"],
        [COMPANY_ADMIN, "admin"],
      ] as const) {
        await db.insert(companyMemberships).values({
          companyId,
          principalType: "user",
          principalId: userId,
          status: "active",
          membershipRole: role,
        });
      }
    }
    await featureFlagsService(db).set(FLAGGED, FEATURE_FLAG_KEYS.DOCUMENT_ACCESS, true);
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await tempDb?.cleanup();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetRunLogStoreForTests();
    resetInstanceSecretsCacheForTests();
    await rm(home, { recursive: true, force: true });
  });

  async function seedAgent(id: string, companyId: string, script: string, stewardUserId = STEWARD) {
    await db.insert(agents).values({
      id,
      companyId,
      name: `Agent ${id.slice(0, 4)}`,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", script] },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentStewardships).values({ companyId, agentId: id, userId: stewardUserId });
  }

  function appAs(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use("/api", activityRoutes(db));
    app.use(errorHandler);
    return app;
  }
  const asUser = (userId: string, role: string) => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [FLAGGED, UNFLAGGED],
    memberships: [
      { companyId: FLAGGED, membershipRole: role, status: "active" },
      { companyId: UNFLAGGED, membershipRole: role, status: "active" },
    ],
  });
  // The auth middleware lists every company for an instance admin.
  const asInstanceAdmin = () => ({
    type: "board",
    source: "session",
    userId: "instance-admin-user",
    isInstanceAdmin: true,
    companyIds: [FLAGGED, UNFLAGGED],
    memberships: [],
  });

  let flaggedRunId = "";
  let unflaggedRunId = "";

  it("strips framed document text from the log file, run events and run row; leaves an unmatched marker", async () => {
    const framed = frameUntrustedDocumentText("microsoft", `Budget line: ${SENTINEL}\nNext line.`, {
      docId: "item-42",
      title: "Board pack.docx",
    });
    const output = `tool result follows\n${framed}\ndone\n`;
    // Split INSIDE the begin marker, so the two halves arrive as two chunks.
    const splitAt = output.indexOf("[[agentdash-untrusted-document:begin") + 20;
    const unmatched = `[[agentdash-untrusted-document:end nonce=${"b".repeat(32)}]]`;
    const script = [
      `const f = ${JSON.stringify(output)};`,
      `process.stdout.write(f.slice(0, ${splitAt}));`,
      `setTimeout(() => { process.stdout.write(f.slice(${splitAt})); console.log(${JSON.stringify(`stray ${unmatched}`)}); process.exit(0); }, 150);`,
    ].join(" ");
    await seedAgent(FLAGGED_AGENT, FLAGGED, script);

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(FLAGGED_AGENT, "on_demand", {}, "manual");
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("succeeded");
    flaggedRunId = queued!.id;

    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, flaggedRunId));
    expect(row!.logRef).toBeTruthy();
    const rawLog = await readFile(join(runLogBasePath(), row!.logRef!), "utf8");
    expect(rawLog).not.toContain(SENTINEL);
    expect(rawLog).toContain("[document text withheld: item-42 Board pack.docx");
    expect(rawLog).toContain(unmatched);
    expect(JSON.stringify(row)).not.toContain(SENTINEL);

    // The adapter.invoke event carries the script (and so the framed text).
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, flaggedRunId));
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
    expect(JSON.stringify(events)).toContain("[document text withheld: item-42");
  }, 30_000);

  it("run detail, events and log are steward-only while the flag is on", async () => {
    expect(flaggedRunId).not.toBe("");
    const paths = [`/api/heartbeat-runs/${flaggedRunId}`, `/api/heartbeat-runs/${flaggedRunId}/events`, `/api/heartbeat-runs/${flaggedRunId}/log`];
    for (const path of paths) {
      expect((await request(appAs(asUser(MEMBER, "member"))).get(path)).status, `member ${path}`).toBe(404);
      expect((await request(appAs(asUser(COMPANY_ADMIN, "admin"))).get(path)).status, `company admin ${path}`).toBe(404);
      expect((await request(appAs(asUser(STEWARD, "member"))).get(path)).status, `steward ${path}`).toBe(200);
      expect((await request(appAs(asInstanceAdmin())).get(path)).status, `instance admin ${path}`).toBe(200);
    }
  });

  it("listings keep the row but drop its free text for a non-steward", async () => {
    const failedRun = randomUUID();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: FLAGGED, title: "Pack review", status: "todo" });
    await db.insert(heartbeatRuns).values({
      id: failedRun,
      companyId: FLAGGED,
      agentId: FLAGGED_AGENT,
      invocationSource: "on_demand",
      status: "failed",
      error: "adapter said: quarterly figures",
      resultJson: { summary: "summary quoting figures" },
      contextSnapshot: { issueId },
    });

    // The issue's run listing: row kept, free text dropped for a non-steward.
    const memberIssueRuns = await request(appAs(asUser(MEMBER, "member"))).get(`/api/issues/${issueId}/runs`);
    expect(memberIssueRuns.status).toBe(200);
    const memberIssueRow = (memberIssueRuns.body as Array<Record<string, unknown>>).find((r) => r.runId === failedRun);
    expect(memberIssueRow).toBeDefined();
    expect(JSON.stringify(memberIssueRow)).not.toContain("quarterly figures");
    expect(JSON.stringify(memberIssueRow)).not.toContain("summary quoting");
    const stewardIssueRuns = await request(appAs(asUser(STEWARD, "member"))).get(`/api/issues/${issueId}/runs`);
    const stewardIssueRow = (stewardIssueRuns.body as Array<Record<string, unknown>>).find((r) => r.runId === failedRun);
    expect(stewardIssueRow!.error).toBe("adapter said: quarterly figures");
    const memberList = await request(appAs(asUser(MEMBER, "member"))).get(`/api/companies/${FLAGGED}/heartbeat-runs`);
    expect(memberList.status).toBe(200);
    const memberRow = (memberList.body as Array<Record<string, unknown>>).find((r) => r.id === failedRun);
    expect(memberRow).toBeDefined();
    expect(memberRow!.status).toBe("failed");
    expect(memberRow!.error ?? null).toBeNull();
    expect(memberRow!.resultSummary ?? null).toBeNull();
    expect(JSON.stringify(memberRow)).not.toContain("quarterly figures");

    // And the run itself is 404 to the member.
    expect((await request(appAs(asUser(MEMBER, "member"))).get(`/api/heartbeat-runs/${failedRun}`)).status).toBe(404);

    const stewardList = await request(appAs(asUser(STEWARD, "member"))).get(`/api/companies/${FLAGGED}/heartbeat-runs`);
    const stewardRow = (stewardList.body as Array<Record<string, unknown>>).find((r) => r.id === failedRun);
    expect(stewardRow!.error).toBe("adapter said: quarterly figures");
  });

  it("ending the stewardship closes the run to the former steward", async () => {
    const otherAgent = randomUUID();
    await seedAgent(otherAgent, FLAGGED, "process.exit(0);", SECOND_STEWARD);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: FLAGGED, agentId: otherAgent, invocationSource: "on_demand", status: "succeeded" });
    const path = `/api/heartbeat-runs/${runId}/events`;
    expect((await request(appAs(asUser(SECOND_STEWARD, "member"))).get(path)).status).toBe(200);
    // The steward of a different agent is not this agent's steward.
    expect((await request(appAs(asUser(STEWARD, "member"))).get(path)).status).toBe(404);
    await db.update(agentStewardships).set({ endedAt: new Date() }).where(eq(agentStewardships.agentId, otherAgent));
    expect((await request(appAs(asUser(SECOND_STEWARD, "member"))).get(path)).status).toBe(404);
  });

  it("flag off: company members read runs as before", async () => {
    await seedAgent(UNFLAGGED_AGENT, UNFLAGGED, "process.exit(0);");
    unflaggedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: unflaggedRunId,
      companyId: UNFLAGGED,
      agentId: UNFLAGGED_AGENT,
      invocationSource: "on_demand",
      status: "failed",
      error: "plain error",
    });
    for (const path of [`/api/heartbeat-runs/${unflaggedRunId}`, `/api/heartbeat-runs/${unflaggedRunId}/events`, `/api/heartbeat-runs/${unflaggedRunId}/log`]) {
      expect((await request(appAs(asUser(MEMBER, "member"))).get(path)).status, path).toBe(200);
    }
    const list = await request(appAs(asUser(MEMBER, "member"))).get(`/api/companies/${UNFLAGGED}/heartbeat-runs`);
    const row = (list.body as Array<Record<string, unknown>>).find((r) => r.id === unflaggedRunId);
    expect(row!.error).toBe("plain error");
  });

  it("live run log/event messages reach only the steward and instance admins while the flag is on", async () => {
    const visibility = createLiveEventVisibility(db);
    const filterFor = (companyId: string, actor: Record<string, unknown>) =>
      visibility.createSubscriberFilter({ companyId, loadActor: async () => actor as never });
    const event = (companyId: string, runId: string, agentId: string, type: string, payload: Record<string, unknown> = {}) => ({
      id: Date.now(),
      companyId,
      type,
      createdAt: new Date().toISOString(),
      payload: { runId, agentId, ...payload },
    }) as never;

    const flaggedLog = event(FLAGGED, flaggedRunId, FLAGGED_AGENT, "heartbeat.run.log", { chunk: "x" });
    const flaggedEvent = event(FLAGGED, flaggedRunId, FLAGGED_AGENT, "heartbeat.run.event", { message: "x" });
    for (const e of [flaggedLog, flaggedEvent]) {
      expect(await filterFor(FLAGGED, asUser(MEMBER, "member"))(e)).toBe(false);
      expect(await filterFor(FLAGGED, asUser(COMPANY_ADMIN, "admin"))(e)).toBe(false);
      expect(await filterFor(FLAGGED, asUser(STEWARD, "member"))(e)).toBe(true);
      expect(await filterFor(FLAGGED, asInstanceAdmin())(e)).toBe(true);
    }

    // Status events still arrive, without their error text.
    const status = event(FLAGGED, flaggedRunId, FLAGGED_AGENT, "heartbeat.run.status", { status: "failed", error: "quarterly figures" });
    const memberFilter = filterFor(FLAGGED, asUser(MEMBER, "member"));
    expect(await memberFilter(status)).toBe(true);
    expect(((await memberFilter.redactForSubscriber(status)) as { payload: { error: unknown } }).payload.error).toBeNull();
    const stewardFilter = filterFor(FLAGGED, asUser(STEWARD, "member"));
    expect(((await stewardFilter.redactForSubscriber(status)) as { payload: { error: unknown } }).payload.error).toBe("quarterly figures");

    // Flag off: unchanged.
    const plainLog = event(UNFLAGGED, unflaggedRunId, UNFLAGGED_AGENT, "heartbeat.run.log", { chunk: "x" });
    expect(await filterFor(UNFLAGGED, asUser(MEMBER, "member"))(plainLog)).toBe(true);
  });

  it("retention purges only rows and log files older than the window, only for flagged companies", async () => {
    const base = await mkdtemp(join(home, "retention-logs-"));
    const now = new Date();
    const old = new Date(now.getTime() - 40 * DAY_MS);
    const recent = new Date(now.getTime() - 1 * DAY_MS);

    async function seedRun(companyId: string, agentId: string, finishedAt: Date) {
      const id = randomUUID();
      const logRef = `${companyId}/${agentId}/${id}.ndjson`;
      await mkdir(join(base, companyId, agentId), { recursive: true });
      await writeFile(join(base, logRef), "{}\n", "utf8");
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "succeeded",
        createdAt: finishedAt,
        finishedAt,
        logStore: "local_file",
        logRef,
      });
      await db.insert(heartbeatRunEvents).values({
        companyId,
        runId: id,
        agentId,
        seq: 1,
        eventType: "lifecycle",
        message: "run started",
        createdAt: finishedAt,
      });
      return { id, logPath: join(base, logRef) };
    }

    const flaggedOld = await seedRun(FLAGGED, FLAGGED_AGENT, old);
    const flaggedRecent = await seedRun(FLAGGED, FLAGGED_AGENT, recent);
    const unflaggedOld = await seedRun(UNFLAGGED, UNFLAGGED_AGENT, old);

    const result = await pruneDocumentRunData(db, { retentionDays: 30, now, basePath: base });
    expect(result.companies).toBe(1);
    expect(result.logFilesDeleted).toBe(1);

    const eventsOf = (runId: string) => db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(await eventsOf(flaggedOld.id)).toHaveLength(0);
    expect(await eventsOf(flaggedRecent.id)).toHaveLength(1);
    expect(await eventsOf(unflaggedOld.id)).toHaveLength(1);
    // The earlier run's events (written just now) are inside the window.
    expect((await eventsOf(flaggedRunId)).length).toBeGreaterThan(0);

    await expect(stat(flaggedOld.logPath)).rejects.toThrow();
    await expect(stat(flaggedRecent.logPath)).resolves.toBeTruthy();
    await expect(stat(unflaggedOld.logPath)).resolves.toBeTruthy();

    const [oldRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, flaggedOld.id));
    expect(oldRow!.logRef).toBeNull();
    const [recentRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, flaggedRecent.id));
    expect(recentRow!.logRef).not.toBeNull();

    // The log route answers an empty, missing log for a purged run.
    const log = await request(appAs(asUser(STEWARD, "member"))).get(`/api/heartbeat-runs/${flaggedOld.id}/log`);
    expect(log.status).toBe(200);
    expect(log.body.missing).toBe(true);
  });
});
