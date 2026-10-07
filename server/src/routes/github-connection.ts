// AgentDash (GH #782): GitHub repo connections.
//
//   GET    /api/companies/:companyId/github-connections           any company member
//   PUT    /api/companies/:companyId/github-connections           instance admin, company owner or admin
//   DELETE /api/companies/:companyId/github-connections/:id       instance admin, company owner or admin
//   POST   /api/agent-git-credential                              agent runs only (git credential helper)
//
// The pasted token is write-only: no response, log line or activity entry
// carries it. The agent endpoint is the one place a token leaves the server,
// to the `git` of a running agent working in the connected project (see
// services/git-credential-helper.ts for why an env variable cannot do this).

import express, { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import type { GitHubConnectionsResponse } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { formatGitCredentialResponse, parseGitCredentialRequest } from "../services/git-credential-helper.js";
import { githubConnectionService, type GitHubConnectionDeps } from "../services/github-connection.js";
import { assertCompanyAccess, assertCompanyAdministrator, isCompanyAdministrator } from "./authz.js";
import { filterVisibleByProject } from "./visibility.js";

export interface GitHubConnectionRouteDeps extends GitHubConnectionDeps {
  logActivity?: typeof logActivity;
}

/**
 * Per-run limit on credential requests. git asks once per network operation;
 * anything far beyond that is a script harvesting the token (GH #782 review).
 */
export const AGENT_GIT_CREDENTIAL_LIMIT = { max: 30, windowMs: 60_000 };

export function githubConnectionRoutes(db: Db, deps: GitHubConnectionRouteDeps = {}) {
  const credentialHits = new Map<string, number[]>();
  function allowCredentialRequest(runId: string, now = Date.now()): boolean {
    const since = now - AGENT_GIT_CREDENTIAL_LIMIT.windowMs;
    const hits = (credentialHits.get(runId) ?? []).filter((at) => at > since);
    if (hits.length >= AGENT_GIT_CREDENTIAL_LIMIT.max) {
      credentialHits.set(runId, hits);
      return false;
    }
    hits.push(now);
    credentialHits.set(runId, hits);
    if (credentialHits.size > 5_000) {
      for (const [key, times] of credentialHits) if (!times.some((at) => at > since)) credentialHits.delete(key);
    }
    return true;
  }

  const router = Router();
  const svc = githubConnectionService(db, deps);
  const access = accessService(db);
  const log = deps.logActivity ?? logActivity;

  function boardOnly(req: Request) {
    return req.actor.type === "board";
  }

  router.get("/companies/:companyId/github-connections", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const body: GitHubConnectionsResponse = {
      // GH #1052: a connection names its project, workspace and repo; one
      // into a restricted project is absent for an actor off its access list.
      connections: await filterVisibleByProject(db, req, await svc.list(companyId)),
      canManage: boardOnly(req) && (await isCompanyAdministrator(access, req, companyId)),
    };
    res.json(body);
  });

  router.put("/companies/:companyId/github-connections", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertCompanyAdministrator(
      access,
      req,
      companyId,
      "Only a workspace owner or admin can connect GitHub.",
    );
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actorUserId = req.actor.userId ?? null;
    const result = await svc.connect(
      companyId,
      { repoUrl: body.repoUrl, token: body.githubToken, projectId: body.projectId },
      actorUserId,
    );
    const details = {
      repo: result.connection.repo,
      projectId: result.connection.projectId,
      projectWorkspaceId: result.connection.projectWorkspaceId,
      credentialSource: result.connection.credentialSource,
      rotated: result.rotated,
      projectCreated: result.projectCreated,
    };
    await log(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId ?? "unknown",
      action: result.rotated ? "github_connection.rotated" : "github_connection.connected",
      entityType: "project",
      entityId: result.connection.projectId,
      details,
    });
    logger.info({ ...details, companyId, actor: actorUserId }, "[github-connection] connected");
    res.status(result.rotated ? 200 : 201).json({ connection: result.connection, projectCreated: result.projectCreated });
  });

  router.delete("/companies/:companyId/github-connections/:connectionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertCompanyAdministrator(
      access,
      req,
      companyId,
      "Only a workspace owner or admin can disconnect GitHub.",
    );
    const removed = await svc.disconnect(companyId, req.params.connectionId as string);
    const actorUserId = req.actor.userId ?? null;
    await log(db, {
      companyId,
      actorType: "user",
      actorId: actorUserId ?? "unknown",
      action: "github_connection.disconnected",
      entityType: "project",
      entityId: removed.projectId,
      details: { repo: removed.repo },
    });
    res.json({ ok: true, id: removed.id });
  });

  // The git credential helper posts git's own request (text, key=value lines).
  // Parsed into a local and then dropped from req.body so no error path can
  // echo it into a log line.
  router.post(
    "/agent-git-credential",
    express.text({ type: () => true, limit: "4kb" }),
    async (req, res) => {
      const raw = typeof req.body === "string" ? req.body : "";
      req.body = {};
      res.setHeader("Cache-Control", "no-store");
      res.type("text/plain");
      // Only the short-lived JWT the heartbeat mints for one run, never a
      // long-lived agent API key: a member can create an agent and read its
      // key, and would otherwise present any running run's id in a header.
      // The run is the one signed into the JWT; a header naming another is refused.
      const actor = req.actor;
      if (
        actor.type !== "agent" ||
        actor.source !== "agent_jwt" ||
        !actor.agentId ||
        !actor.companyId ||
        !actor.jwtRunId ||
        actor.readOnly ||
        (actor.runId && actor.runId !== actor.jwtRunId)
      ) {
        res.status(403).send("");
        return;
      }
      if (!allowCredentialRequest(actor.jwtRunId)) {
        res.setHeader("Retry-After", String(Math.ceil(AGENT_GIT_CREDENTIAL_LIMIT.windowMs / 1000)));
        res.status(429).send("");
        return;
      }
      const request = parseGitCredentialRequest(raw);
      const granted = await svc.credentialForRun({
        companyId: actor.companyId,
        agentId: actor.agentId,
        runId: actor.jwtRunId,
        protocol: request.protocol,
        host: request.host,
        path: request.path,
      });
      if (!granted) {
        logger.info(
          { companyId: actor.companyId, agentId: actor.agentId, runId: actor.jwtRunId, host: request.host },
          "[github-connection] git credential refused",
        );
        res.status(404).send("");
        return;
      }
      await log(db, {
        companyId: actor.companyId,
        actorType: "agent",
        actorId: actor.agentId,
        agentId: actor.agentId,
        runId: actor.jwtRunId,
        action: "github_connection.credential_issued",
        entityType: "project",
        entityId: granted.projectId,
        details: { repo: granted.repo, connectionId: granted.connectionId },
      });
      res.status(200).send(formatGitCredentialResponse(granted.token));
    },
  );

  return router;
}
