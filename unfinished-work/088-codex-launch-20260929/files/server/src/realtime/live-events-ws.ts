import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, authSessions, authUsers, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { edgeUpgradeAllowed } from "../middleware/edge-gate.js";

interface WsSocket {
  readyState: number;
  ping(): void;
  send(data: string): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  on(event: "connection", listener: (socket: WsSocket, req: IncomingMessage) => void): void;
  on(event: "close", listener: () => void): void;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

interface UpgradeContext {
  companyId: string;
  actorType: "board" | "agent";
  actorId: string;
  // AgentDash (#708): bind every refresh to the credential used for this upgrade.
  authorization:
    | { kind: "local_trusted" }
    | { kind: "session"; sessionId: string }
    | { kind: "agent_key"; keyId: string; tokenHash: string };
}

interface IncomingMessageWithContext extends IncomingMessage {
  paperclipUpgradeContext?: UpgradeContext;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function isWritableUpgradeSocket(socket: Duplex) {
  const maybeWritableState = socket as Duplex & { writable?: boolean; writableEnded?: boolean; writableDestroyed?: boolean };
  return !socket.destroyed && maybeWritableState.writable !== false && !maybeWritableState.writableEnded && !maybeWritableState.writableDestroyed;
}

function closeUpgradeSocket(socket: Duplex) {
  if (!socket.destroyed) {
    socket.destroy();
  }
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  if (!isWritableUpgradeSocket(socket)) {
    closeUpgradeSocket(socket);
    return;
  }

  try {
    socket.once("finish", () => closeUpgradeSocket(socket));
    socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  } catch (err) {
    logger.warn({ err }, "failed to reject live websocket upgrade");
    closeUpgradeSocket(socket);
  }
}

function parseCompanyId(pathname: string) {
  const match = pathname.match(/^\/api\/companies\/([^/]+)\/events\/ws$/);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

function parseBearerToken(rawAuth: string | string[] | undefined) {
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function headersFromIncomingMessage(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

// AgentDash (#708): direct session-row reads bypass any resolver cookie cache;
// key refreshes never substitute another key or update lastUsedAt.
async function isSubscriptionAuthorized(db: Db, context: UpgradeContext): Promise<boolean> {
  const authorization = context.authorization;
  if (authorization.kind === "local_trusted") return true;

  if (authorization.kind === "agent_key") {
    const key = await db
      .select({ id: agentApiKeys.id, status: agents.status })
      .from(agentApiKeys)
      .innerJoin(agents, eq(agents.id, agentApiKeys.agentId))
      .where(and(
        eq(agentApiKeys.id, authorization.keyId),
        eq(agentApiKeys.keyHash, authorization.tokenHash),
        isNull(agentApiKeys.revokedAt),
        eq(agentApiKeys.companyId, context.companyId),
        eq(agentApiKeys.agentId, context.actorId),
        eq(agents.companyId, context.companyId),
      ))
      .then((rows) => rows[0] ?? null);
    return key !== null && key.status !== "terminated" && key.status !== "pending_approval";
  }

  const [session, role, membership] = await Promise.all([
    db.select({ id: authSessions.id })
      .from(authSessions)
      .innerJoin(authUsers, eq(authUsers.id, authSessions.userId))
      .where(and(
        eq(authSessions.id, authorization.sessionId),
        eq(authSessions.userId, context.actorId),
        gt(authSessions.expiresAt, new Date()),
      ))
      .then((rows) => rows[0] ?? null),
    db.select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, context.actorId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null),
    db.select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, context.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, context.actorId),
        eq(companyMemberships.status, "active"),
      ))
      .then((rows) => rows[0] ?? null),
  ]);
  return session !== null && (role !== null || membership !== null);
}

async function authorizeUpgrade(
  db: Db,
  req: IncomingMessage,
  companyId: string,
  url: URL,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
): Promise<UpgradeContext | null> {
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const authToken = parseBearerToken(req.headers.authorization);
  const token = authToken ?? (queryToken.length > 0 ? queryToken : null);

  // Browser board context has no bearer token in local_trusted and authenticated modes.
  if (!token) {
    if (opts.deploymentMode === "local_trusted") {
      return {
        companyId,
        actorType: "board",
        actorId: "board",
        authorization: { kind: "local_trusted" },
      };
    }

    if (opts.deploymentMode !== "authenticated" || !opts.resolveSessionFromHeaders) {
      return null;
    }

    const session = await opts.resolveSessionFromHeaders(headersFromIncomingMessage(req));
    const userId = session?.user?.id;
    if (!userId || !session?.session?.id || session.session.userId !== userId) return null;

    const context: UpgradeContext = {
      companyId,
      actorType: "board",
      actorId: userId,
      authorization: { kind: "session", sessionId: session.session.id },
    };
    return await isSubscriptionAuthorized(db, context) ? context : null;
  }

  const tokenHash = hashToken(token);
  const key = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);

  if (!key || key.companyId !== companyId) {
    return null;
  }

  const context: UpgradeContext = {
    companyId,
    actorType: "agent",
    actorId: key.agentId,
    authorization: { kind: "agent_key", keyId: key.id, tokenHash },
  };
  if (!await isSubscriptionAuthorized(db, context)) return null;

  await db
    .update(agentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentApiKeys.id, key.id));

  return context;
}

export function setupLiveEventsWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const wss = new WebSocketServer({ noServer: true });
  const cleanupByClient = new Map<WsSocket, () => void>();
  const aliveByClient = new Map<WsSocket, boolean>();
  const refreshByClient = new Map<WsSocket, () => Promise<boolean>>();

  const pingInterval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!aliveByClient.get(socket)) {
        cleanupByClient.get(socket)?.();
        socket.terminate();
        continue;
      }
      // AgentDash (#708): idle subscriptions also lose revoked authorization.
      const refresh = refreshByClient.get(socket);
      if (!refresh) continue;
      void refresh().then((authorized) => {
        if (!authorized || socket.readyState !== WebSocket.OPEN) return;
        aliveByClient.set(socket, false);
        socket.ping();
      }).catch(() => {
        cleanupByClient.get(socket)?.();
        socket.terminate();
      });
    }
  // AgentDash (#708): 19s poll + 5s prior round + 5s fresh round + 1s close grace <= 30s.
  }, 19_000);

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    const context = (req as IncomingMessageWithContext).paperclipUpgradeContext;
    if (!context) {
      socket.close(1008, "missing context");
      return;
    }

    let stopped = false;
    let inFlight: Promise<boolean> | undefined;
    let cancelRefresh: (() => void) | undefined;
    let closeDeadline: ReturnType<typeof setTimeout> | undefined;
    let queuedEvents = 0;
    let delivery = Promise.resolve();
    let unsubscribe = () => {};
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      cancelRefresh?.();
      cleanupByClient.delete(socket);
      aliveByClient.delete(socket);
      refreshByClient.delete(socket);
    };
    const close = (code: number, reason: string) => {
      cleanup();
      socket.close(code, reason);
      // A peer cannot keep a revoked connection alive by withholding its close reply.
      closeDeadline = setTimeout(() => socket.terminate(), 1_000);
      closeDeadline.unref?.();
    };
    const refresh = (): Promise<boolean> => {
      if (stopped) return Promise.resolve(false);
      if (inFlight) return inFlight;
      let timeout: ReturnType<typeof setTimeout>;
      const expires = new Promise<boolean>((resolve) => {
        cancelRefresh = () => resolve(false);
        timeout = setTimeout(() => resolve(false), 5_000);
      });
      inFlight = Promise.race([isSubscriptionAuthorized(db, context), expires])
        .catch(() => false)
        .then((authorized) => {
          if (!authorized && !stopped) close(1008, "authorization changed");
          return authorized && !stopped;
        })
        .finally(() => {
          clearTimeout(timeout);
          cancelRefresh = undefined;
          inFlight = undefined;
        });
      return inFlight;
    };

    const refreshAfterPending = async (): Promise<boolean> => {
      // Neither a new event nor an idle tick may use a snapshot from an older round.
      // Waiting first retains one non-overlapping authorization round per socket.
      if (inFlight && !await inFlight) return false;
      return refresh();
    };

    unsubscribe = subscribeCompanyLiveEvents(context.companyId, (event) => {
      if (stopped || socket.readyState !== WebSocket.OPEN) return;
      // AgentDash (#708): serialize checks/sends so async authorization preserves
      // event order; cap retained events while a database check is stalled.
      if (queuedEvents >= 256) {
        close(1013, "event delivery overloaded");
        return;
      }
      queuedEvents += 1;
      delivery = delivery.then(async () => {
        if (stopped || !await refreshAfterPending() || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify(event));
      }).catch(() => close(1011, "event delivery failed"))
        .finally(() => { queuedEvents -= 1; });
    });

    cleanupByClient.set(socket, cleanup);
    refreshByClient.set(socket, refreshAfterPending);
    aliveByClient.set(socket, true);

    socket.on("pong", () => {
      if (!stopped) aliveByClient.set(socket, true);
    });

    socket.on("close", () => {
      clearTimeout(closeDeadline);
      cleanup();
    });

    socket.on("error", (err: Error) => {
      logger.warn({ err, companyId: context.companyId }, "live websocket client error");
    });
  });

  wss.on("close", () => {
    clearInterval(pingInterval);
    for (const cleanup of cleanupByClient.values()) cleanup();
  });

  server.on("upgrade", (req, socket, head) => {
    // AgentDash (#766, SC-5): behind the edge router, an upgrade must carry the edge secret.
    if (!edgeUpgradeAllowed(req)) {
      rejectUpgrade(socket, "403 Forbidden", "edge required");
      return;
    }
    // AgentDash (#708): URL queries can contain bearer tokens and never enter logs.
    let url: URL;
    try {
      url = new URL(req.url ?? "", "http://localhost");
    } catch {
      rejectUpgrade(socket, "400 Bad Request", "invalid url");
      return;
    }
    const path = url.pathname;
    const onRawSocketError = (err: Error) => {
      logger.warn({ err, path }, "live websocket upgrade socket error");
    };
    const cleanupRawSocketListeners = () => {
      socket.off("error", onRawSocketError);
      socket.off("close", cleanupRawSocketListeners);
    };

    socket.on("error", onRawSocketError);
    socket.once("close", cleanupRawSocketListeners);

    if (!req.url) {
      rejectUpgrade(socket, "400 Bad Request", "missing url");
      return;
    }

    const companyId = parseCompanyId(url.pathname);
    if (!companyId) {
      closeUpgradeSocket(socket);
      return;
    }

    void authorizeUpgrade(db, req, companyId, url, {
      deploymentMode: opts.deploymentMode,
      resolveSessionFromHeaders: opts.resolveSessionFromHeaders,
    })
      .then((context) => {
        if (!context) {
          rejectUpgrade(socket, "403 Forbidden", "forbidden");
          return;
        }

        if (!isWritableUpgradeSocket(socket)) {
          cleanupRawSocketListeners();
          return;
        }

        const reqWithContext = req as IncomingMessageWithContext;
        reqWithContext.paperclipUpgradeContext = context;

        cleanupRawSocketListeners();
        wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
          wss.emit("connection", ws, reqWithContext);
        });
      })
      .catch(() => {
        logger.error({ path }, "failed websocket upgrade authorization");
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
      });
  });

  return wss;
}
