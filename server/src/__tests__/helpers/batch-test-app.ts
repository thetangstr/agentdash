import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Express, type Request } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { authSessions, authUsers, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { actorMiddleware } from "../../middleware/auth.js";
import { errorHandler } from "../../middleware/index.js";
import { boardMutationGuard } from "../../middleware/board-mutation-guard.js";
import { createDefaultApiRateLimiter } from "../../middleware/rate-limit.js";
import { requestActorSourceMiddleware } from "../../lib/request-actor-source.js";
import { issueRoutes } from "../../routes/issues.js";
import { batchRoutes } from "../../routes/batches.js";
import { activityRoutes } from "../../routes/activity.js";
import { approvalRoutes } from "../../routes/approvals.js";
import { agentRoutes } from "../../routes/agents.js";
import { agentStewardshipRoutes } from "../../routes/agent-stewardships.js";
import { routineRoutes } from "../../routes/routines.js";
import { agentGovernanceRoutes } from "../../routes/agent-governance.js";
import { ceilingTemplateRoutes } from "../../routes/ceiling-templates.js";
import { companyAuditRoutes } from "../../routes/company-audit.js";
import { companyRoutes } from "../../routes/companies.js";
import { accessRoutes } from "../../routes/access.js";
import { assertBoard, assertCompanyAccess, getActorInfo, setAuthzRefusalDb } from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import { BATCH_KINDS, type BatchKind, type BatchKindRecord } from "../../services/batch/kinds.js";
import type { BatchServiceOptions } from "../../services/batch/engine.js";
import { resetRunLogStoreForTests } from "../../services/run-log-store.js";
import { resetInstanceSecretsCacheForTests } from "../../services/run-log-redaction.js";

/**
 * AgentDash admin powers, part 2: a production-shaped app for the batch
 * suites. The middleware order is app.ts's (JSON body → the real actor
 * middleware with a session resolver over real `session` rows → the actor
 * source context → the default API limiter → the CSRF guard → routes), so a
 * batch item really travels over loopback with its `pcbx_` credential and
 * really passes (or is refused by) the same guards a person's click does.
 *
 * Browser requests carry `x-test-session: <session id>` plus a trusted
 * Origin; the resolver reads the `session` row exactly as Better Auth would.
 *
 * `test.widget` is a test-only kind (never in the production registry) whose
 * route can be told to refuse, fail, fail after changing, hang or end the
 * person's session, so every outcome the engine knows is exercised for real.
 */

export type TestDb = ReturnType<typeof createDb>;

export type WidgetMode = "ok" | "refuse" | "boom" | "boom-after" | "hang" | "end-session" | "different";
export interface Widget { id: string; companyId: string; value: string; mode: WidgetMode }
export interface WidgetCall { widgetId: string; credentialKind: string | null; actorSource: string | null; userId: string | null }

type WidgetRecord = BatchKindRecord & { value: string };

export function widgetKind(widgets: Map<string, Widget>): BatchKind<{ value: string }, WidgetRecord> {
  return {
    key: "test.widget",
    entityType: "widget",
    noun: "widget",
    maxPerBatch: 200,
    parseChange: (input) => z.object({ value: z.string().min(1) }).strict().parse(input),
    async load({ companyId }, ids) {
      const out = new Map<string, WidgetRecord>();
      for (const id of ids) {
        const widget = widgets.get(id);
        if (widget && widget.companyId === companyId) {
          out.set(id, { entityType: "widget", entityId: id, label: `Widget ${id.slice(0, 4)}`, value: widget.value });
        }
      }
      return out;
    },
    describe: (record, change) => ({ before: { value: record.value }, after: { value: change.value }, noop: record.value === change.value }),
    request: (record, change) => ({ method: "PATCH", path: `/api/test-batch-widgets/${record.entityId}`, body: { value: change.value } }),
  };
}

export interface BatchTestApp {
  db: TestDb;
  app: Express;
  server: http.Server;
  baseUrl: string;
  widgets: Map<string, Widget>;
  widgetCalls: WidgetCall[];
  batches: ReturnType<typeof batchRoutes>["batchService"];
  /** A signed-in person: an `auth_users` row and a live `session` row. */
  signIn(userId: string): Promise<string>;
  /** Headers of a browser request by that session (trusted Origin included). */
  browser(sessionId: string): Record<string, string>;
  close(): Promise<void>;
}

export async function startBatchTestApp(
  prefix: string,
  options: BatchServiceOptions = {},
  listen: { host?: string; port?: number } = {},
): Promise<BatchTestApp> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_SECRETS_MASTER_KEY", "RUN_LOG_BASE_PATH", "AGENTDASH_DEFAULT_ADAPTER"]) {
    saved[key] = process.env[key];
  }
  const home = await mkdtemp(join(tmpdir(), `${prefix}home-`));
  process.env.PAPERCLIP_HOME = home;
  process.env.PAPERCLIP_INSTANCE_ID = prefix;
  process.env.PAPERCLIP_SECRETS_MASTER_KEY = "e".repeat(64);
  process.env.RUN_LOG_BASE_PATH = join(home, "run-logs");
  process.env.AGENTDASH_DEFAULT_ADAPTER = "";
  resetRunLogStoreForTests();
  resetInstanceSecretsCacheForTests();

  const tempDb = await startEmbeddedPostgresTestDatabase(prefix);
  const db = createDb(tempDb.connectionString);
  setAuthzRefusalDb(db);
  const widgets = new Map<string, Widget>();
  const widgetCalls: WidgetCall[] = [];

  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, {
    deploymentMode: "authenticated",
    resolveSession: async (req: Request) => {
      const sessionId = req.header("x-test-session");
      if (!sessionId) return null;
      const [session] = await db.select().from(authSessions).where(eq(authSessions.id, sessionId));
      if (!session || session.expiresAt.getTime() <= Date.now()) return null;
      const [user] = await db.select().from(authUsers).where(eq(authUsers.id, session.userId));
      if (!user) return null;
      return { session: { id: session.id, userId: session.userId }, user: { id: user.id, name: user.name, email: user.email } } as never;
    },
  }));
  app.use(requestActorSourceMiddleware());
  const api = express.Router();
  api.use(createDefaultApiRateLimiter({ deploymentMode: "authenticated" }));
  api.use(boardMutationGuard());
  api.use(issueRoutes(db, {} as never));
  api.use(activityRoutes(db));
  api.use(approvalRoutes(db, { autoDispatchQueuedRuns: false }));
  api.use(agentRoutes(db));
  api.use(agentStewardshipRoutes(db));
  api.use(routineRoutes(db));
  api.use(agentGovernanceRoutes(db));
  api.use(ceilingTemplateRoutes(db));
  api.use(companyAuditRoutes(db));
  api.use("/companies", companyRoutes(db, undefined, { allowMultiCompany: true, allowMultiTenantPerDomain: true, deploymentMode: "authenticated" }));
  api.use(accessRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [] }));
  const batchRouter = batchRoutes(db, {
    ...options,
    kinds: { ...BATCH_KINDS, "test.widget": widgetKind(widgets), ...(options.kinds ?? {}) },
  });
  api.use(batchRouter);
  api.patch("/test-batch-widgets/:id", async (req, res) => {
    const widget = widgets.get(req.params.id as string);
    if (!widget) { res.status(404).json({ error: "Widget not found" }); return; }
    assertBoard(req);
    assertCompanyAccess(req, widget.companyId);
    widgetCalls.push({
      widgetId: widget.id,
      credentialKind: req.verifiedCredential?.kind ?? null,
      actorSource: req.actor.source ?? null,
      userId: req.actor.userId ?? null,
    });
    const value = String((req.body as { value?: unknown }).value ?? "");
    switch (widget.mode) {
      case "refuse":
        res.status(409).json({ error: "This widget is locked." });
        return;
      case "boom":
        res.status(500).json({ error: "internal" });
        return;
      case "boom-after":
        widget.value = value;
        res.status(500).json({ error: "internal" });
        return;
      case "hang":
        return; // never answers
      case "different":
        // Answers 200 but does something other than what was asked.
        widget.value = `${value}-but-different`;
        res.json({ id: widget.id, value: widget.value });
        return;
      case "end-session":
        if (req.verifiedCredential?.kind === "batch_item" && req.verifiedCredential.origin.kind === "session") {
          await db.delete(authSessions).where(eq(authSessions.id, req.verifiedCredential.origin.sessionId));
        }
        break;
      default:
        break;
    }
    widget.value = value;
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: widget.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "widget.updated",
      entityType: "widget",
      entityId: widget.id,
      details: { value },
    });
    res.json({ id: widget.id, value });
  });
  app.use("/api", api);
  app.use(errorHandler);

  const server = http.createServer(app);
  const host = listen.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(listen.port ?? 0, host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

  return {
    db,
    app,
    server,
    baseUrl,
    widgets,
    widgetCalls,
    batches: batchRouter.batchService,
    async signIn(userId: string) {
      const sessionId = randomUUID();
      const now = new Date();
      await db.insert(authSessions).values({ id: sessionId, userId, token: randomUUID(), expiresAt: new Date(now.getTime() + 24 * 3600_000), createdAt: now, updatedAt: now });
      return sessionId;
    },
    browser(sessionId: string) {
      return { "x-test-session": sessionId, origin: baseUrl };
    },
    async close() {
      await new Promise((resolve) => setTimeout(resolve, 300));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      setAuthzRefusalDb(null);
      await tempDb.cleanup();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetRunLogStoreForTests();
      resetInstanceSecretsCacheForTests();
      await rm(home, { recursive: true, force: true });
    },
  };
}
