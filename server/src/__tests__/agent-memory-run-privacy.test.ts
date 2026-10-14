// AgentDash: an agent's memory is readable only by the agent, its steward and
// administrators. These tests guard the copies of it that live OUTSIDE the
// memory route — the run's context snapshot, the `adapter.invoke` event (its
// prompt and context), the live bus, feedback trace bundles — plus the agent,
// activity and export payloads a company member can read.
import express from "express";
// These fixtures inject req.actor without running the auth middleware, so no
// verified credential exists (same arrangement as document-run-protection).
vi.mock("../services/issue-current-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/issue-current-authority.js")>()),
  issueCurrentAuthority: () => undefined,
}));
import request from "supertest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
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
import { renderAgentMemoryPrompt } from "@paperclipai/adapter-utils/server-utils";
import { AGENT_MEMORY_CONTEXT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { agentMemoryService } from "../services/agent-memory.ts";
import { AGENT_MEMORY_WITHHELD_TEXT } from "../services/agent-memory-redaction.ts";
import { feedbackService } from "../services/feedback.ts";
import { companyPortabilityService } from "../services/company-portability.ts";
import { subscribeCompanyLiveEvents } from "../services/live-events.ts";
import { resetRunLogStoreForTests } from "../services/run-log-store.ts";
import { resetInstanceSecretsCacheForTests } from "../services/run-log-redaction.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/registry.ts";
import { agentRoutes } from "../routes/agents.js";
import { activityRoutes } from "../routes/activity.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SECRET = "SENTINEL-agent-memory-5d1c";
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

    await db.insert(companies).values({ id: COMPANY, name: "Memory Co", issuePrefix: "AMP", requireBoardApprovalForNewAgents: false });
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

    // Renders memory into its prompt the way claude_local / codex_local do,
    // and reports the invocation the way they do.
    registerServerAdapter({
      type: FAKE_ADAPTER,
      execute: async (ctx: AdapterExecutionContext) => {
        receivedMemory = ctx.context[AGENT_MEMORY_CONTEXT_KEY] ?? null;
        const prompt = ["## Directives\nbe brief", renderAgentMemoryPrompt(ctx.context[AGENT_MEMORY_CONTEXT_KEY]), "## Wake\nwork"].join("\n\n");
        await ctx.onMeta?.({ adapterType: FAKE_ADAPTER, command: "fake", prompt, context: ctx.context });
        return { exitCode: 0, signal: null, timedOut: false };
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

  it("the agent gets its memory; the run row, its events and the live bus do not keep it", async () => {
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

      // The agent itself still wakes with its memory.
      expect(JSON.stringify(receivedMemory)).toContain(SECRET);

      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
      expect(JSON.stringify(row)).not.toContain(SECRET);
      expect(row!.contextSnapshot).not.toHaveProperty(AGENT_MEMORY_CONTEXT_KEY);

      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, queued!.id));
      const invoke = events.find((event) => event.eventType === "adapter.invoke");
      expect(invoke).toBeTruthy();
      expect(JSON.stringify(events)).not.toContain(SECRET);
      const prompt = (invoke!.payload as { prompt: string }).prompt;
      expect(prompt).toContain(AGENT_MEMORY_WITHHELD_TEXT);
      expect(prompt).toContain("## Wake\nwork");

      expect(live.length).toBeGreaterThan(0);
      expect(live.join("\n")).not.toContain(SECRET);

      // And through the routes a member reads.
      const member = appAs(asUser(MEMBER, "member"));
      const detail = await request(member).get(`/api/heartbeat-runs/${queued!.id}`);
      expect(detail.status).toBe(200);
      expect(JSON.stringify(detail.body)).not.toContain(SECRET);
      const served = await request(member).get(`/api/heartbeat-runs/${queued!.id}/events`);
      expect(served.status).toBe(200);
      expect(JSON.stringify(served.body)).not.toContain(SECRET);
    } finally {
      unsubscribe();
    }
  }, 30_000);

  it("a run recorded before the fix serves no memory to a member", async () => {
    const runId = randomUUID();
    const memory = { version: 1, content: `old ${SECRET} note`, writtenAt: "2026-09-01T00:00:00.000Z", authorKind: "agent" };
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: COMPANY,
      agentId: AGENT,
      invocationSource: "on_demand",
      status: "succeeded",
      contextSnapshot: { wakeReason: "manual", [AGENT_MEMORY_CONTEXT_KEY]: memory },
    });
    await db.insert(heartbeatRunEvents).values({
      companyId: COMPANY,
      runId,
      agentId: AGENT,
      seq: 1,
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      message: "adapter invocation",
      payload: { prompt: `intro\n\n${renderAgentMemoryPrompt(memory)}\n\n## Wake\nwork`, context: { [AGENT_MEMORY_CONTEXT_KEY]: memory } },
    });

    const member = appAs(asUser(MEMBER, "member"));
    const detail = await request(member).get(`/api/heartbeat-runs/${runId}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain(SECRET);
    expect(detail.body.contextSnapshot.wakeReason).toBe("manual");
    const served = await request(member).get(`/api/heartbeat-runs/${runId}/events`);
    expect(served.status).toBe(200);
    expect(JSON.stringify(served.body)).not.toContain(SECRET);
    expect(served.body[0].payload.prompt).toContain("## Wake\nwork");
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

  it("a feedback trace bundle carries no memory, and withholds adapter transcripts of an agent that has memory", async () => {
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
        contextSnapshot: { [AGENT_MEMORY_CONTEXT_KEY]: { version: memory.version, content: memory.content } },
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
      expect((bundle.body.files as Array<{ path: string }>).some((f) => f.path === "paperclip/run.json")).toBe(true);
      expect((bundle.body.files as Array<{ path: string }>).some((f) => f.path.startsWith("adapter/"))).toBe(false);
    } finally {
      if (previousClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeDir;
    }
  }, 30_000);
});
