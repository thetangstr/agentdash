import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { isUuidLike, type DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";
import { bridgeService } from "../services/bridge.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeRunId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return isUuidLike(trimmed) ? trimmed : undefined;
}

/**
 * The ONLY paths a `bridge_endpoint` credential may reach.
 *
 * This is the single most important control in the bridge. An endpoint token
 * lives on someone's laptop, is long-lived, and belongs to a machine we cannot
 * inspect — if it were usable as a general API key, enrolling a laptop would be
 * equivalent to issuing a company credential.
 *
 * Kept here, beside where the actor is minted, rather than in the router: a
 * check that lives far from the credential it governs is one that gets
 * forgotten when someone adds a route. Anything not on this list sees the
 * request as unauthenticated, exactly as if no token had been sent.
 */
const BRIDGE_ENDPOINT_ROUTES = new Set([
  "/api/bridge/poll",
  "/api/bridge/result",
  "/api/bridge/decline",
]);

/** Path without query string or trailing slash, for allowlist comparison. */
function normalizedPath(req: Request): string {
  const raw = (req.originalUrl || req.url || "").split("?")[0];
  return raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);
  const bridge = bridgeService(db);
  return async (req, _res, next) => {
    req.actor =
      opts.deploymentMode === "local_trusted"
        ? {
            type: "board",
            userId: "local-board",
            userName: "Local Board",
            userEmail: null,
            isInstanceAdmin: true,
            source: "local_implicit",
          }
        : { type: "none", source: "none" };

    const runIdHeader = normalizeRunId(req.header("x-paperclip-run-id"));

    let authHeader = req.header("authorization");
    // AgentDash: honor the documented `x-agent-key` agent-auth header. Every onboarding
    // AGENTS.md surface instructs agents to "send your agent key as the `x-agent-key`
    // header on every request", but the server historically only read Authorization:
    // Bearer — so agents that followed their own instructions 401'd. When no Bearer
    // credential is present, map x-agent-key onto the same token validation path.
    const agentKeyHeader = req.header("x-agent-key")?.trim();
    if (agentKeyHeader && !authHeader?.toLowerCase().startsWith("bearer ")) {
      authHeader = `Bearer ${agentKeyHeader}`;
    }
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      if (opts.deploymentMode === "authenticated" && opts.resolveSession) {
        let session: BetterAuthSessionResult | null = null;
        try {
          session = await opts.resolveSession(req);
        } catch (err) {
          logger.warn(
            { err, method: req.method, url: req.originalUrl },
            "Failed to resolve auth session from request headers",
          );
        }
        if (session?.user?.id) {
          const userId = session.user.id;
          const [roleRow, memberships] = await Promise.all([
            db
              .select({ id: instanceUserRoles.id })
              .from(instanceUserRoles)
              .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
              .then((rows) => rows[0] ?? null),
            db
              .select({
                companyId: companyMemberships.companyId,
                membershipRole: companyMemberships.membershipRole,
                status: companyMemberships.status,
              })
              .from(companyMemberships)
              .where(
                and(
                  eq(companyMemberships.principalType, "user"),
                  eq(companyMemberships.principalId, userId),
                  eq(companyMemberships.status, "active"),
                ),
              ),
          ]);
          req.actor = {
            type: "board",
            userId,
            userName: session.user.name ?? null,
            userEmail: session.user.email ?? null,
            companyIds: memberships.map((row) => row.companyId),
            memberships,
            isInstanceAdmin: Boolean(roleRow),
            runId: runIdHeader ?? undefined,
            source: "session",
          };
          next();
          return;
        }
      }
      if (runIdHeader) req.actor.runId = runIdHeader;
      next();
      return;
    }

    const token = authHeader.slice("bearer ".length).trim();
    if (!token) {
      next();
      return;
    }

    const boardKey = await boardAuth.findBoardApiKeyByToken(token);
    if (boardKey) {
      const access = await boardAuth.resolveBoardAccess(boardKey.userId);
      if (access.user) {
        await boardAuth.touchBoardApiKey(boardKey.id);
        req.actor = {
          type: "board",
          userId: boardKey.userId,
          userName: access.user?.name ?? null,
          userEmail: access.user?.email ?? null,
          companyIds: access.companyIds,
          memberships: access.memberships,
          isInstanceAdmin: access.isInstanceAdmin,
          keyId: boardKey.id,
          runId: runIdHeader || undefined,
          source: "board_key",
        };
        next();
        return;
      }
    }

    // AgentDash-MK: a human's enrolled local machine.
    //
    // Resolved ONLY on the bridge's own routes. On any other path the token is
    // not even looked up, so a leaked endpoint credential cannot be used to
    // probe which routes exist, and a future route addition cannot accidentally
    // widen what an endpoint can reach.
    if (BRIDGE_ENDPOINT_ROUTES.has(normalizedPath(req))) {
      const endpoint = await bridge.resolveEndpointByToken(token);
      if (endpoint) {
        req.actor = {
          // `type: "none"` on purpose, not an oversight. Every existing
          // authorization helper branches on `type` ("board", "agent"), so a
          // bridge actor is refused by all of them by construction. Only the
          // bridge's own explicit `source === "bridge_endpoint"` check accepts
          // it. Belt and braces: even a misrouted bridge endpoint cannot pass
          // an ordinary guard.
          type: "none",
          companyId: endpoint.companyId,
          bridgeEndpointId: endpoint.id,
          source: "bridge_endpoint",
        };
        next();
        return;
      }
    }

    const tokenHash = hashToken(token);
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    if (!key) {
      const claims = verifyLocalAgentJwt(token);
      if (!claims) {
        next();
        return;
      }

      const agentRecord = await db
        .select()
        .from(agents)
        .where(eq(agents.id, claims.sub))
        .then((rows) => rows[0] ?? null);

      if (!agentRecord || agentRecord.companyId !== claims.company_id) {
        next();
        return;
      }

      if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
        next();
        return;
      }

      req.actor = {
        type: "agent",
        agentId: claims.sub,
        companyId: claims.company_id,
        keyId: undefined,
        runId: runIdHeader || normalizeRunId(claims.run_id),
        source: "agent_jwt",
      };
      next();
      return;
    }

    await db
      .update(agentApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentApiKeys.id, key.id));

    const agentRecord = await db
      .select()
      .from(agents)
      .where(eq(agents.id, key.agentId))
      .then((rows) => rows[0] ?? null);

    if (!agentRecord || agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
      next();
      return;
    }

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      companyId: key.companyId,
      keyId: key.id,
      runId: runIdHeader || undefined,
      source: "agent_key",
    };

    next();
  };
}

export function requireBoard(req: Express.Request) {
  return req.actor.type === "board";
}
