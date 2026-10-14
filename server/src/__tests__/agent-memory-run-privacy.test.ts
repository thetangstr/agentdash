// AgentDash: an agent's memory, and the corrections ("What changed") it is
// built from, are readable only by the agent, its steward and administrators.
// These tests guard the copies that live OUTSIDE the memory route — the run's
// context snapshot, the `adapter.invoke` event (prompt, context, wake payload
// env), the live bus, feedback trace bundles — plus the agent, activity and
// export payloads a company member can read.
import express from "express";
// These fixtures inject req.actor without running the auth middleware, so no
// verified credential exists (same arrangement as document-run-protection).
vi.mock("../services/issue-current-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/issue-current-authority.js")>()),
  issueCurrentAuthority: () => undefined,
}));
import request from "supertest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentStewardships,
  agents,
  companies,
  companyMemberships,
  createDb,
  feedbackExports,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  renderAgentMemoryPrompt,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import { AGENT_MEMORY_CONTEXT_KEY, FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { agentMemoryService } from "../services/agent-memory.ts";
import { AGENT_CORRECTIONS_WITHHELD_TEXT, AGENT_MEMORY_WITHHELD_TEXT } from "../services/run-private-content.ts";
import { recordAgentCorrection } from "../services/agent-corrections.ts";
import { featureFlagsService } from "../services/feature-flags.ts";
import { feedbackService } from "../services/feedback.ts";
import { companyPortabilityService } from "../services/company-portability.ts";
import { subscribeCompanyLiveEvents } from "../services/live-events.ts";
import { getRunLogStore, resetRunLogStoreForTests } from "../services/run-log-store.ts";
import { resetInstanceSecretsCacheForTests } from "../services/run-log-redaction.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.ts";
import { agentRoutes } from "../routes/agents.js";
import { activityRoutes } from "../routes/activity.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SECRET = "SENTINEL-agent-memory-5d1c";
const CORRECTION_SECRET = "SENTINEL-correction-77e0";
/** A tool line that is not memory traffic; it must reach the log unchanged. */
const OTHER_TOOL_LINE = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "toolu_issue", name: "mcp__agentdash__get_issue", input: { issueId: "AMP-1" } }] },
  session_id: "sess-1",
});

/**
 * What claude_local (stream-json) and codex_local (exec --json) print when the
 * agent reads and rewrites its memory, plus an echo of a lesson in the
 * agent's own words and an unrelated tool call.
 */
function memoryTrafficLines(memoryContent: string, lesson: string): string[] {
  const memoryJson = JSON.stringify({ memory: { version: 1, content: memoryContent, authorKind: "agent" } });
  const rewritten = `${memoryContent}\n- ${lesson}`;
  return [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_get", name: "mcp__agentdash__agentdashGetMyMemory", input: {} }] }, session_id: "sess-1" }),
    JSON.stringify({ type: "user", message: { content: [{ tool_use_id: "toolu_get", type: "tool_result", content: [{ type: "text", text: memoryJson }] }] }, session_id: "sess-1", tool_use_result: [{ type: "text", text: memoryJson }] }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_put", name: "mcp__agentdash__agentdashUpdateMyMemory", input: { content: rewritten, expectedVersion: 1 } }] }, session_id: "sess-1" }),
    JSON.stringify({ type: "user", message: { content: [{ tool_use_id: "toolu_put", type: "tool_result", content: [{ type: "text", text: JSON.stringify({ memory: { version: 2, content: rewritten } }) }] }] }, session_id: "sess-1" }),
    JSON.stringify({ type: "item.started", item: { id: "item_4", type: "mcp_tool_call", server: "agentdash", tool: "agentdashGetMyMemory", arguments: {}, result: null, error: null, status: "in_progress" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_4", type: "mcp_tool_call", server: "agentdash", tool: "agentdashGetMyMemory", arguments: {}, result: { content: [{ type: "text", text: memoryJson }], structured_content: null }, error: null, status: "completed" } }),
    JSON.stringify({ type: "item.completed", item: { id: "item_5", type: "mcp_tool_call", server: "agentdash", tool: "agentdashUpdateMyMemory", arguments: { content: rewritten, expectedVersion: 1 }, result: { content: [{ type: "text", text: "{\"memory\":{\"version\":2}}" }], structured_content: null }, error: null, status: "completed" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `Done. I will keep: ${lesson}` }] }, session_id: "sess-1" }),
    OTHER_TOOL_LINE,
  ];
}
const FAKE_ADAPTER = "agent_memory_privacy_test";

async function waitForRunToFinish(heartbeat: ReturnType<typeof heartbeatService>, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

/**
 * A run as it was recorded before memory and corrections were withheld: both
 * in the context snapshot, and in the adapter.invoke event's prompt, context
 * and wake payload env.
 */
async function seedHistoricalRun(db: ReturnType<typeof createDb>, companyId: string, agentId: string) {
  const runId = randomUUID();
  const memory = { version: 1, content: `old ${SECRET} note`, writtenAt: "2026-09-01T00:00:00.000Z", authorKind: "agent" };
  const corrections = [
    {
      id: randomUUID(),
      kind: "task_reopened",
      issueId: null,
      issueIdentifier: null,
      summary: `Reopened. Their reason: "${CORRECTION_SECRET}".`,
      lessons: [`lesson ${CORRECTION_SECRET}`],
      createdAt: "2026-09-01T00:00:00.000Z",
    },
  ];
  const wake = { reason: "issue_reopened", corrections, correctionsRemaining: 0 };
  const context = {
    wakeReason: "manual",
    [AGENT_MEMORY_CONTEXT_KEY]: memory,
    paperclipAgentCorrections: corrections,
    paperclipAgentCorrectionsRemaining: 0,
    paperclipWake: wake,
  };
  await db.insert(heartbeatRuns).values({
    id: runId,
    companyId,
    agentId,
    invocationSource: "on_demand",
    status: "succeeded",
    contextSnapshot: context,
  });
  const [event] = await db.insert(heartbeatRunEvents).values({
    companyId,
    runId,
    agentId,
    seq: 1,
    eventType: "adapter.invoke",
    stream: "system",
    level: "info",
    message: "adapter invocation",
    payload: {
      prompt: `intro\n\n${renderAgentMemoryPrompt(memory)}\n\n${renderPaperclipWakePrompt(wake)}\n\n## Task\nwork`,
      context,
      env: { PAPERCLIP_WAKE_PAYLOAD_JSON: stringifyPaperclipWakePayload(wake) ?? "", HOME: "/home/agent" },
    },
  }).returning();
  return { runId, eventId: event!.id };
}

describeEmbeddedPostgres("agent memory stays out of run records and shared payloads", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home: string;
  const saved: Record<string, string | undefined> = {};

  const COMPANY = randomUUID();
  const AGENT = randomUUID();
  const STEWARD = "memory-steward-user";
  const MEMBER = "memory-member-user";
  const ADMIN = "memory-admin-user";
  let receivedMemory: unknown = null;
  let receivedCorrections: unknown = null;
  /** When set, the next run fails with an error message that repeats a lesson. */
  let failNextWithLesson = false;

  beforeAll(async () => {
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_SECRETS_MASTER_KEY", "RUN_LOG_BASE_PATH"]) {
      saved[key] = process.env[key];
    }
    home = await mkdtemp(join(tmpdir(), "agent-memory-run-privacy-"));
    process.env.PAPERCLIP_HOME = home;
    process.env.PAPERCLIP_INSTANCE_ID = "agent-memory-run-privacy-test";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "d".repeat(64);
    process.env.RUN_LOG_BASE_PATH = join(home, "run-logs");
    resetRunLogStoreForTests();
    resetInstanceSecretsCacheForTests();
    tempDb = await startEmbeddedPostgresTestDatabase("agent-memory-run-privacy-");
    db = createDb(tempDb.connectionString);

    await db.insert(companies).values({
      id: COMPANY,
      name: "Memory Co",
      issuePrefix: "AMP",
      requireBoardApprovalForNewAgents: false,
      productProfile: "agentdash_mk",
    });
    await featureFlagsService(db).set(COMPANY, FEATURE_FLAG_KEYS.COWORKER_BRIDGE, true);
    for (const [userId, role] of [[STEWARD, "member"], [MEMBER, "member"], [ADMIN, "admin"]] as const) {
      await db.insert(companyMemberships).values({
        companyId: COMPANY,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: role,
      });
    }
    await db.insert(agents).values({
      id: AGENT,
      companyId: COMPANY,
      name: "Forge",
      role: "engineer",
      status: "idle",
      adapterType: FAKE_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentStewardships).values({ companyId: COMPANY, agentId: AGENT, userId: STEWARD });
    await agentMemoryService(db).writeAndLog(
      COMPANY,
      AGENT,
      { content: `Lessons.\n- ${SECRET}: label figures as estimated.`, authorKind: "agent", authorAgentId: AGENT },
      { actorType: "agent", actorId: AGENT, agentId: AGENT },
    );

    await recordAgentCorrection(db, {
      companyId: COMPANY,
      agentId: AGENT,
      issueId: null,
      kind: "task_reopened",
      summary: `Person A reopened the note. Their reason: "${CORRECTION_SECRET} totals are off".`,
      details: { lessons: [`Check the totals twice ${CORRECTION_SECRET}`] },
      sourceActorType: "user",
      sourceActorId: STEWARD,
    });

    // Renders memory and the wake (with its What changed section) into its
    // prompt and the wake payload into its env, the way claude_local and
    // codex_local do, and reports the invocation the way they do.
    registerServerAdapter({
      type: FAKE_ADAPTER,
      rendersAgentCorrections: true,
      execute: async (ctx: AdapterExecutionContext) => {
        receivedMemory = ctx.context[AGENT_MEMORY_CONTEXT_KEY] ?? null;
        receivedCorrections = (ctx.context.paperclipWake as { corrections?: unknown } | undefined)?.corrections ?? null;
        const prompt = [
          "## Directives\nbe brief",
          renderAgentMemoryPrompt(ctx.context[AGENT_MEMORY_CONTEXT_KEY]),
          renderPaperclipWakePrompt(ctx.context.paperclipWake),
          "## Task\nwork",
        ].join("\n\n");
        const env = { PAPERCLIP_WAKE_PAYLOAD_JSON: stringifyPaperclipWakePayload(ctx.context.paperclipWake) ?? "" };
        await ctx.onMeta?.({ adapterType: FAKE_ADAPTER, command: "fake", prompt, context: ctx.context, env });
        const memoryContent = String((ctx.context[AGENT_MEMORY_CONTEXT_KEY] as { content?: string } | undefined)?.content ?? "");
        const lines = memoryTrafficLines(memoryContent, `Check the totals twice ${CORRECTION_SECRET}`);
        // Split mid-line across writes, as a pipe can.
        const text = `${lines.join("\n")}\n`;
        const cut = Math.floor(text.length / 2);
        await ctx.onLog("stdout", text.slice(0, cut));
        await ctx.onLog("stdout", text.slice(cut));
        if (failNextWithLesson) {
          failNextWithLesson = false;
          return { exitCode: 1, signal: null, timedOut: false, errorMessage: `Stopped before: Check the totals twice ${CORRECTION_SECRET}` };
        }
        return { exitCode: 0, signal: null, timedOut: false, summary: `Kept the lesson: Check the totals twice ${CORRECTION_SECRET}` };
      },
      testEnvironment: async () => ({ adapterType: FAKE_ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    } as never);
  }, 60_000);

  afterAll(async () => {
    unregisterServerAdapter(FAKE_ADAPTER);
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

  function appAs(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use("/api", activityRoutes(db));
    app.use("/api", issueRoutes(db));
    app.use(errorHandler);
    return app;
  }
  const asUser = (userId: string, role: string) => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [COMPANY],
    memberships: [{ companyId: COMPANY, membershipRole: role, status: "active" }],
  });

  it("the agent gets its memory and corrections; the run row, its events and the live bus keep neither", async () => {
    const live: string[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(COMPANY, (event) => {
      live.push(JSON.stringify(event));
    });
    try {
      const heartbeat = heartbeatService(db);
      const queued = await heartbeat.invoke(AGENT, "on_demand", {}, "manual");
      expect(queued).not.toBeNull();
      const finished = await waitForRunToFinish(heartbeat, queued!.id);
      expect(finished?.status).toBe("succeeded");

      // The agent itself still wakes with its memory and its corrections.
      expect(JSON.stringify(receivedMemory)).toContain(SECRET);
      expect(JSON.stringify(receivedCorrections)).toContain(CORRECTION_SECRET);

      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
      for (const secret of [SECRET, CORRECTION_SECRET]) expect(JSON.stringify(row)).not.toContain(secret);
      expect(row!.contextSnapshot).not.toHaveProperty(AGENT_MEMORY_CONTEXT_KEY);
      expect(row!.contextSnapshot).not.toHaveProperty("paperclipAgentCorrections");
      // Marked as written through the live stripper, so reads skip their pass.
      expect(row!.contextSnapshot).toMatchObject({ paperclipPrivateLogStripped: true });

      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, queued!.id));
      const invoke = events.find((event) => event.eventType === "adapter.invoke");
      expect(invoke).toBeTruthy();
      for (const secret of [SECRET, CORRECTION_SECRET]) expect(JSON.stringify(events)).not.toContain(secret);
      const prompt = (invoke!.payload as { prompt: string }).prompt;
      expect(prompt).toContain(AGENT_MEMORY_WITHHELD_TEXT);
      expect(prompt).toContain(AGENT_CORRECTIONS_WITHHELD_TEXT);
      expect(prompt).toContain("## Task\nwork");

      expect(live.length).toBeGreaterThan(0);
      for (const secret of [SECRET, CORRECTION_SECRET]) expect(live.join("\n")).not.toContain(secret);

      // And through the routes a member reads.
      const member = appAs(asUser(MEMBER, "member"));
      const detail = await request(member).get(`/api/heartbeat-runs/${queued!.id}`);
      expect(detail.status).toBe(200);
      const served = await request(member).get(`/api/heartbeat-runs/${queued!.id}/events`);
      expect(served.status).toBe(200);
      const log = await request(member).get(`/api/heartbeat-runs/${queued!.id}/log`);
      expect(log.status).toBe(200);
      for (const secret of [SECRET, CORRECTION_SECRET]) {
        expect(JSON.stringify(detail.body)).not.toContain(secret);
        expect(JSON.stringify(served.body)).not.toContain(secret);
        expect(JSON.stringify(log.body)).not.toContain(secret);
        // The stored log file, the excerpt and the result, as written.
        expect(JSON.stringify(row)).not.toContain(secret);
      }
      // Members still read the run log: the memory calls are there, their
      // content is not, and other tool calls are untouched.
      expect(log.body.content).toContain("agentdashGetMyMemory");
      expect(log.body.content).toContain(JSON.stringify(OTHER_TOOL_LINE).slice(1, -1));
      expect(detail.body.stdoutExcerpt).toContain("mcp__agentdash__get_issue");
      expect(detail.body.stdoutExcerpt).toContain(AGENT_MEMORY_WITHHELD_TEXT);
      const liveLog = live.filter((entry) => entry.includes("heartbeat.run.log")).join("\n");
      expect(liveLog).toContain("agentdashUpdateMyMemory");
      for (const secret of [SECRET, CORRECTION_SECRET]) expect(liveLog).not.toContain(secret);
    } finally {
      unsubscribe();
    }
  }, 30_000);

  it("a run recorded before the fix serves no memory or corrections to a member", async () => {
    const { runId } = await seedHistoricalRun(db, COMPANY, AGENT);

    const member = appAs(asUser(MEMBER, "member"));
    const detail = await request(member).get(`/api/heartbeat-runs/${runId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.contextSnapshot.wakeReason).toBe("manual");
    const served = await request(member).get(`/api/heartbeat-runs/${runId}/events`);
    expect(served.status).toBe(200);
    expect(served.body[0].payload.prompt).toContain("## Task\nwork");
    for (const secret of [SECRET, CORRECTION_SECRET]) {
      expect(JSON.stringify(detail.body)).not.toContain(secret);
      expect(JSON.stringify(served.body)).not.toContain(secret);
    }
  });

  it("a run log and excerpt written before the fix are served to a member without memory traffic or lessons", async () => {
    const { runId } = await seedHistoricalRun(db, COMPANY, AGENT);
    const store = getRunLogStore();
    const handle = await store.begin({ companyId: COMPANY, agentId: AGENT, runId });
    const currentMemory = (await agentMemoryService(db).active(COMPANY, AGENT))!.content;
    const lines = memoryTrafficLines(currentMemory, `Check the totals twice ${CORRECTION_SECRET}`);
    for (const [index, line] of lines.entries()) {
      await store.append(handle, { stream: "stdout", chunk: `${line}\n`, ts: new Date().toISOString(), seq: index + 1 });
    }
    const finalized = await store.finalize(handle);
    await db
      .update(heartbeatRuns)
      .set({
        logStore: handle.store,
        logRef: handle.logRef,
        logBytes: finalized.bytes,
        stdoutExcerpt: lines.join("\n"),
      })
      .where(eq(heartbeatRuns.id, runId));
    // The raw file does hold it: this is the old-data case.
    expect(JSON.stringify(await store.read({ store: handle.store, logRef: handle.logRef }))).toContain(SECRET);

    const member = appAs(asUser(MEMBER, "member"));
    const log = await request(member).get(`/api/heartbeat-runs/${runId}/log`);
    expect(log.status).toBe(200);
    const detail = await request(member).get(`/api/heartbeat-runs/${runId}`);
    for (const secret of [SECRET, CORRECTION_SECRET]) {
      expect(JSON.stringify(log.body)).not.toContain(secret);
      expect(JSON.stringify(detail.body)).not.toContain(secret);
    }
    expect(log.body.content).toContain("mcp__agentdash__get_issue");
    expect(detail.body.stdoutExcerpt).toContain(OTHER_TOOL_LINE);
  });

  it("a failed run's error is stored without a lesson echo", async () => {
    // The correction was delivered and spent by the first run; queue another.
    await recordAgentCorrection(db, {
      companyId: COMPANY, agentId: AGENT, issueId: null, kind: "task_reopened",
      summary: `Reopened again. Their reason: "${CORRECTION_SECRET} still off".`,
      details: { lessons: [`Check the totals twice ${CORRECTION_SECRET}`] }, sourceActorType: "user", sourceActorId: STEWARD,
    });
    failNextWithLesson = true;
    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.invoke(AGENT, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    expect(finished?.status).toBe("failed");
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
    expect(row!.error).toBeTruthy();
    expect(row!.error).not.toContain(CORRECTION_SECRET);
  }, 30_000);

  it("the run list cleans the summary and error of runs written before the fix, and leaves marked runs as stored", async () => {
    const oldRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: oldRunId, companyId: COMPANY, agentId: AGENT, invocationSource: "on_demand", status: "failed",
      contextSnapshot: { wakeReason: "manual" },
      resultJson: { summary: `Kept: Check the totals twice ${CORRECTION_SECRET}` },
      error: `Failed after: Check the totals twice ${CORRECTION_SECRET}`,
    });
    const markedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: markedRunId, companyId: COMPANY, agentId: AGENT, invocationSource: "on_demand", status: "succeeded",
      contextSnapshot: { wakeReason: "manual", paperclipPrivateLogStripped: true },
      resultJson: { summary: "Clean summary, written through the stripper" },
    });
    const member = appAs(asUser(MEMBER, "member"));
    const list = await request(member).get(`/api/companies/${COMPANY}/heartbeat-runs`).query({ agentId: AGENT, limit: 200 });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(CORRECTION_SECRET);
    const old = (list.body as Array<{ id: string; resultJson: { summary?: string } | null; error: string | null }>).find((r) => r.id === oldRunId);
    expect(old?.resultJson?.summary).toContain(AGENT_CORRECTIONS_WITHHELD_TEXT);
    expect(old?.error).toContain(AGENT_CORRECTIONS_WITHHELD_TEXT);
    const marked = (list.body as Array<{ id: string; resultJson: { summary?: string } | null }>).find((r) => r.id === markedRunId);
    expect(marked?.resultJson?.summary).toBe("Clean summary, written through the stripper");
  });

  it("migration 0152 removes memory and corrections from runs recorded before the fix, once, keeping the rest", async () => {
    const { runId, eventId } = await seedHistoricalRun(db, COMPANY, AGENT);
    // A truncated stored prompt: the exact section cannot be found, so it is
    // withheld from its heading on.
    const truncated = await seedHistoricalRun(db, COMPANY, AGENT);
    await db
      .update(heartbeatRunEvents)
      .set({
        payload: sql`jsonb_set(${heartbeatRunEvents.payload}, '{prompt}', to_jsonb(left(${heartbeatRunEvents.payload} ->> 'prompt', strpos(${heartbeatRunEvents.payload} ->> 'prompt', ${CORRECTION_SECRET}) + 4)))`,
      })
      .where(eq(heartbeatRunEvents.id, truncated.eventId));

    // Not affected: a run whose wake carried an empty correction list and no
    // memory is left exactly as it is.
    const untouchedRunId = randomUUID();
    const untouchedContext = { wakeReason: "manual", paperclipWake: { reason: "x", corrections: [], correctionsRemaining: 0 } };
    await db.insert(heartbeatRuns).values({
      id: untouchedRunId, companyId: COMPANY, agentId: AGENT, invocationSource: "on_demand", status: "succeeded", contextSnapshot: untouchedContext,
    });
    const [untouchedEvent] = await db.insert(heartbeatRunEvents).values({
      companyId: COMPANY, runId: untouchedRunId, agentId: AGENT, seq: 1, eventType: "adapter.invoke", stream: "system", level: "info",
      message: "adapter invocation", payload: { prompt: "plain prompt", context: untouchedContext },
    }).returning();

    const migration = await readFile(
      new URL("../../../packages/db/src/migrations/0152_withhold_agent_lessons_from_runs.sql", import.meta.url),
      "utf8",
    );
    const statements = migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);
    const apply = () =>
      db.transaction(async (tx) => {
        for (const statement of statements) await tx.execute(sql.raw(statement));
      });
    await apply();

    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [event] = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.id, eventId));
    const [cut] = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.id, truncated.eventId));
    for (const secret of [SECRET, CORRECTION_SECRET]) {
      expect(JSON.stringify(row)).not.toContain(secret);
      expect(JSON.stringify(event)).not.toContain(secret);
      expect(JSON.stringify(cut)).not.toContain(secret);
    }
    expect(row!.contextSnapshot).toEqual({ wakeReason: "manual", paperclipWake: { reason: "issue_reopened" } });
    const payload = event!.payload as { prompt: string; env: Record<string, string>; context: Record<string, unknown> };
    // Exact replacement keeps the prompt around the withheld sections.
    expect(payload.prompt.startsWith("intro\n\n")).toBe(true);
    expect(payload.prompt).toContain(AGENT_MEMORY_WITHHELD_TEXT);
    expect(payload.prompt).toContain(AGENT_CORRECTIONS_WITHHELD_TEXT);
    expect(payload.prompt).toContain("## Task\nwork");
    expect(JSON.parse(payload.env.PAPERCLIP_WAKE_PAYLOAD_JSON).reason).toBe("issue_reopened");
    expect(payload.env.HOME).toBe("/home/agent");
    expect(payload.context).toEqual({ wakeReason: "manual", paperclipWake: { reason: "issue_reopened" } });
    expect((cut!.payload as { prompt: string }).prompt.endsWith(AGENT_CORRECTIONS_WITHHELD_TEXT)).toBe(true);
    // Each section goes as a whole, heading included.
    expect(payload.prompt).not.toContain("## Your Memory");
    expect(payload.prompt).not.toContain("## What changed");
    const [untouchedRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, untouchedRunId));
    expect(untouchedRow!.contextSnapshot).toEqual(untouchedContext);
    const [untouchedAfter] = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.id, untouchedEvent!.id));
    expect(untouchedAfter!.payload).toEqual(untouchedEvent!.payload);

    // Idempotent: a second pass changes nothing.
    await apply();
    const [again] = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.id, eventId));
    expect(again!.payload).toEqual(event!.payload);
  });

  it("a member's agent detail, agent list and activity feed carry no memory content", async () => {
    const member = appAs(asUser(MEMBER, "member"));
    const detail = await request(member).get(`/api/agents/${AGENT}`).query({ companyId: COMPANY });
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain(SECRET);
    const list = await request(member).get(`/api/companies/${COMPANY}/agents`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
    const activity = await request(member).get(`/api/companies/${COMPANY}/activity`);
    expect(activity.status).toBe(200);
    // The write is on the feed (that it happened, its version and length) but
    // never what was written.
    expect(JSON.stringify(activity.body)).toContain("agent.memory_written");
    expect(JSON.stringify(activity.body)).not.toContain(SECRET);
  });

  it("a company export carries no memory content", async () => {
    const exported = await companyPortabilityService(db).exportBundle(COMPANY, {
      include: { company: true, agents: true, projects: false, issues: false },
    } as never);
    expect(JSON.stringify(exported)).not.toContain(SECRET);
  });

  it("a feedback trace bundle carries no memory or corrections, and withholds adapter transcripts of an agent that has either", async () => {
    const claudeDir = await mkdtemp(join(home, "claude-config-"));
    const previousClaudeDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    try {
      // A claude_local agent whose session transcript holds its prompt, memory
      // section included — as a real transcript does.
      const agentId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        companyId: COMPANY,
        name: "Quill",
        role: "engineer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      const memory = await agentMemoryService(db).write(COMPANY, agentId, {
        content: `lesson ${SECRET}`,
        authorKind: "agent",
        authorAgentId: agentId,
      });
      const runId = randomUUID();
      const sessionId = `sess-${runId.slice(0, 8)}`;
      await mkdir(join(claudeDir, "projects", "p"), { recursive: true });
      await writeFile(
        join(claudeDir, "projects", "p", `${sessionId}.jsonl`),
        `${JSON.stringify({ type: "user", message: { content: renderAgentMemoryPrompt(memory) } })}\n`,
        "utf8",
      );
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: COMPANY,
        agentId,
        invocationSource: "on_demand",
        status: "succeeded",
        sessionIdAfter: sessionId,
        contextSnapshot: {
          [AGENT_MEMORY_CONTEXT_KEY]: { version: memory.version, content: memory.content },
          paperclipWake: { corrections: [{ kind: "task_reopened", summary: `x ${CORRECTION_SECRET}`, lessons: [] }] },
        },
      });
      await db.insert(heartbeatRunEvents).values({
        companyId: COMPANY,
        runId,
        agentId,
        seq: 1,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        message: "adapter invocation",
        payload: { prompt: renderAgentMemoryPrompt(memory), context: { [AGENT_MEMORY_CONTEXT_KEY]: memory } },
      });
      // Its run log holds the memory traffic too (an old log: written raw).
      const store = getRunLogStore();
      const handle = await store.begin({ companyId: COMPANY, agentId, runId });
      for (const [index, line] of memoryTrafficLines(memory.content, `Check the totals twice ${CORRECTION_SECRET}`).entries()) {
        await store.append(handle, { stream: "stdout", chunk: `${line}\n`, ts: new Date().toISOString(), seq: index + 1 });
      }
      const finalized = await store.finalize(handle);
      await db
        .update(heartbeatRuns)
        .set({ logStore: handle.store, logRef: handle.logRef, logBytes: finalized.bytes })
        .where(eq(heartbeatRuns.id, runId));
      const issueId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId: COMPANY, title: "Feedback target", status: "todo" });
      const [comment] = await db.insert(issueComments).values({
        companyId: COMPANY, issueId, authorAgentId: agentId, createdByRunId: runId, body: "agent answer",
      }).returning();
      await feedbackService(db).saveIssueVote({
        issueId, targetType: "issue_comment", targetId: comment!.id, vote: "up", authorUserId: MEMBER, allowSharing: true,
      });
      const [exported] = await db.select().from(feedbackExports).where(eq(feedbackExports.issueId, issueId));

      const bundle = await request(appAs(asUser(MEMBER, "member"))).get(`/api/feedback-traces/${exported!.id}/bundle`);
      expect(bundle.status).toBe(200);
      expect(JSON.stringify(bundle.body)).not.toContain(SECRET);
      expect(JSON.stringify(bundle.body)).not.toContain(CORRECTION_SECRET);
      expect((bundle.body.files as Array<{ path: string }>).some((f) => f.path === "paperclip/run.json")).toBe(true);
      const runLog = (bundle.body.files as Array<{ path: string; contents: string }>).find((f) => f.path === "paperclip/run-log.ndjson");
      expect(runLog?.contents).toContain("agentdashGetMyMemory");
      expect((bundle.body.files as Array<{ path: string }>).some((f) => f.path.startsWith("adapter/"))).toBe(false);
    } finally {
      if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
    }
  }, 30_000);
});
