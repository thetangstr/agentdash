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

export interface GitHubConnectionRouteDeps extends GitHubConnectionDeps {
  logActivity?: typeof logActivity;
}

export function githubConnectionRoutes(db: Db, deps: GitHubConnectionRouteDeps = {}) {
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
      connections: await svc.list(companyId),
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
      if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId || req.actor.readOnly) {
        res.status(403).send("");
        return;
      }
      const request = parseGitCredentialRequest(raw);
      const granted = await svc.credentialForRun({
        companyId: req.actor.companyId,
        agentId: req.actor.agentId,
        runId: req.actor.runId,
        protocol: request.protocol,
        host: request.host,
        path: request.path,
      });
      if (!granted) {
        logger.info(
          { companyId: req.actor.companyId, agentId: req.actor.agentId, runId: req.actor.runId, host: request.host },
          "[github-connection] git credential refused",
        );
        res.status(404).send("");
        return;
      }
      await log(db, {
        companyId: req.actor.companyId,
        actorType: "agent",
        actorId: req.actor.agentId,
        agentId: req.actor.agentId,
        runId: req.actor.runId ?? null,
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
