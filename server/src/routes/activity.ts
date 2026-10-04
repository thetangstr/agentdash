import { and } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { activityLog, issues } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import {
  activityService,
  normalizeActivityLimit,
  normalizeIssueRunsLimit,
} from "../services/activity.js";
import {
  assertAuthenticated,
  assertBoard,
  assertCompanyAccess,
  assistantGrantAttribution,
  getActorInfo,
} from "./authz.js";
import {
  activityVisibilityCondition,
  agentVisibilityCondition,
  issueVisibilityParam,
  projectScopedVisibilityCondition,
  redactHiddenIssuesInActivityRows,
  resolveAgentVisibility,
  runVisibilityParam,
} from "./visibility.js";
import { heartbeatService, issueService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";
import { redactRunLogValue } from "../services/run-log-redaction.js";

// AgentDash (consolidation PR-C): the manual activity POST no longer lets the
// caller choose who the row is attributed to. `actorType` and `actorId` are
// still accepted so existing callers keep working, but they are ignored: the
// server stamps the actor from the authenticated principal and marks the row
// `origin: "manual"`, so it can never be mistaken for a server-emitted record.
const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system", "plugin"]).optional(),
  actorId: z.string().min(1).optional(),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

export function activityRoutes(db: Db) {
  const router = Router();
  const svc = activityService(db);
  const heartbeat = heartbeatService(db);
  const issueSvc = issueService(db);

  // A5 (GH #830): an issue in a restricted project is 404 on every
  // /issues/:id route here for an actor off the project's access list.
  router.param("id", issueVisibilityParam(db));
  // ...and a run on such an issue is 404 too: its issue list names it.
  router.param("runId", runVisibilityParam(db));

  async function resolveIssueByRef(rawId: string) {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      return issueSvc.getByIdentifier(rawId);
    }
    return issueSvc.getById(rawId);
  }

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await resolveAgentVisibility(db, req, companyId);

    // AgentDash assistant MCP (#676): `since` bounds the feed to an ISO
    // timestamp so `whats_new` can ask "what changed since T" instead of
    // paging the tail. Invalid input is a 400, not a silent full feed.
    let since: Date | undefined;
    const rawSince = req.query.since as string | undefined;
    if (rawSince !== undefined) {
      const parsed = new Date(rawSince);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: "since must be an ISO 8601 timestamp" });
        return;
      }
      since = parsed;
    }

    const filters = {
      companyId,
      agentId: req.query.agentId as string | undefined,
      entityType: req.query.entityType as string | undefined,
      entityId: req.query.entityId as string | undefined,
      since,
      limit: normalizeActivityLimit(Number(req.query.limit)),
      // AgentDash (review #1003): the Activity page asks for the filtered
      // feed; every other consumer keeps the full one.
      includeSystem: req.query.includeSystem === "false" ? false : undefined,
      // A5 (GH #830): rows about an issue or project the actor cannot see
      // are absent, so `?entityType=issue&entityId=` cannot read around the
      // guarded /issues/:id/activity.
      visibleWhere: and(
        activityVisibilityCondition(req, companyId),
        // Agent visibility (2026-09-30): rows about an invisible agent are absent.
        agentVisibilityCondition(req, companyId, activityLog.agentId),
      ),
    };
    const result = await svc.list(filters);
    // GH #863: blocker and referenced-issue entries in details follow visibility.
    res.json(await redactHiddenIssuesInActivityRows(db, req, companyId, result));
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const { action, entityType, entityId, agentId } = req.body as z.infer<typeof createActivitySchema>;
    const details = req.body.details ? sanitizeRecord(req.body.details) : null;
    const event = await svc.create({
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action,
      entityType,
      entityId,
      agentId: agentId ?? null,
      // Mirror the column in details so readers that only see `details`
      // (live events, older UIs) can still tell the row was posted by hand.
      // An assistant-grant caller keeps its `via` provenance (GH #678).
      details: { ...(details ?? {}), ...assistantGrantAttribution(req), origin: "manual" },
      origin: "manual",
    });
    res.status(201).json(event);
  });

  router.get("/issues/:id/activity", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const result = await svc.forIssue(issue.id);
    // GH #863: blocker and referenced-issue entries in details follow visibility.
    res.json(await redactHiddenIssuesInActivityRows(db, req, issue.companyId, result));
  });

  router.get("/issues/:id/runs", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const rawLimit = req.query.limit as string | undefined;
    const parsedLimit = rawLimit !== undefined && /^\d+$/.test(rawLimit) ? Number.parseInt(rawLimit, 10) : null;
    if (rawLimit !== undefined && (parsedLimit === null || !Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
      res.status(400).json({ error: "limit must be a positive integer" });
      return;
    }
    const rawOffset = req.query.offset as string | undefined;
    const parsedOffset = rawOffset !== undefined && /^\d+$/.test(rawOffset) ? Number.parseInt(rawOffset, 10) : null;
    if (rawOffset !== undefined && (parsedOffset === null || !Number.isInteger(parsedOffset) || parsedOffset < 0)) {
      res.status(400).json({ error: "offset must be a non-negative integer" });
      return;
    }
    const result = await svc.runsForIssue(issue.companyId, issue.id, {
      limit: normalizeIssueRunsLimit(parsedLimit ?? undefined),
      offset: parsedOffset ?? 0,
    });
    // AgentDash (c3 review): run `error` can carry adapter detail that
    // includes secrets — serve it through the same redaction pass as the
    // heartbeat-runs routes.
    res.json(redactRunLogValue(result));
  });

  router.get("/heartbeat-runs/:runId/issues", async (req, res) => {
    assertAuthenticated(req);
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.json([]);
      return;
    }
    assertCompanyAccess(req, run.companyId);
    const result = await svc.issuesForRun(runId, {
      visibleWhere: projectScopedVisibilityCondition(req, run.companyId, issues.projectId),
    });
    res.json(result);
  });

  return router;
}
