import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import {
  activityService,
  normalizeActivityLimit,
  normalizeIssueRunsLimit,
} from "../services/activity.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess } from "./authz.js";
import { heartbeatService, issueService } from "../services/index.js";
import { sanitizeRecord } from "../redaction.js";

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system", "plugin"]).optional().default("system"),
  actorId: z.string().min(1),
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

  async function resolveIssueByRef(rawId: string) {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      return issueSvc.getByIdentifier(rawId);
    }
    return issueSvc.getById(rawId);
  }

  router.get("/companies/:companyId/activity", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

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
    };
    const result = await svc.list(filters);
    res.json(result);
  });

  router.post("/companies/:companyId/activity", validate(createActivitySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const event = await svc.create({
      companyId,
      ...req.body,
      details: req.body.details ? sanitizeRecord(req.body.details) : null,
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
    res.json(result);
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
    res.json(result);
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
    const result = await svc.issuesForRun(runId);
    res.json(result);
  });

  return router;
}
