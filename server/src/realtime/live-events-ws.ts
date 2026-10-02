import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, agents, authSessions } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { edgeUpgradeAllowed } from "../middleware/edge-gate.js";
// AgentDash (GH #708): access changes close sockets that no longer authorize.
import { subscribeLiveEventAccessChanges, type LiveEventAccessChange } from "./live-events-access.js";
import {
  createLiveEventVisibility,
  loadBoardUserActor,
  type LiveEventActor,
} from "./live-event-visibility.js";

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
  // AgentDash (GH #830 part A follow-up): how the subscriber is authenticated,
  // so live events can be filtered by the same project rule as REST.
  source: "local_implicit" | "session" | "agent_key";
  // AgentDash (GH #708): the exact credential the socket was opened with, so
  // re-authorization checks that credential and not just the principal.
  keyId?: string;
  sessionId?: string | null;
  // AgentDash (GH #937): what the authorization check observed at the upgrade —
  // a passing re-check invalidates the cached actor only when this changed.
  actorFingerprint: string;
}

// AgentDash (GH #708): policy-violation close code for a revoked subscriber.
export const LIVE_EVENTS_REVOKED_CLOSE_CODE = 1008;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_RECHECK_TIMEOUT_MS = 5_000;
const MAX_HEARTBEAT_CHECK_ERRORS = 3;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("live websocket re-authorization timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
// Agents that REST auth refuses (middleware/auth.ts) cannot subscribe either.
const INACTIVE_AGENT_STATUSES = new Set(["terminated", "pending_approval"]);

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
        source: "local_implicit",
        actorFingerprint: "local_implicit",
      };
    }

    if (opts.deploymentMode !== "authenticated" || !opts.resolveSessionFromHeaders) {
      return null;
    }

    const session = await opts.resolveSessionFromHeaders(headersFromIncomingMessage(req));
    const userId = session?.user?.id;
    if (!userId) return null;

    const access = await boardUserAccess(db, userId, companyId);
    if (!access.allowed) return null;

    return {
      companyId,
      actorType: "board",
      actorId: userId,
      source: "session",
      sessionId: session?.session?.id ?? null,
      actorFingerprint: access.fingerprint,
    };
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
  // AgentDash (GH #708): parity with REST auth — a terminated or unapproved agent's key does not subscribe.
  const agentAccess = await agentAccessInCompany(db, key.agentId, companyId);
  if (!agentAccess.allowed) {
    return null;
  }

  await db
    .update(agentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentApiKeys.id, key.id));

  return {
    companyId,
    actorType: "agent",
    actorId: key.agentId,
    source: "agent_key",
    keyId: key.id,
    actorFingerprint: agentAccess.fingerprint,
  };
}

/**
 * AgentDash (GH #708 + #937): the checks the upgrade made, repeatable for an
 * open socket. The fingerprint names the state the re-check actually observed
 * (instance-admin flag plus this company's active membership for a user —
 * the socket only serves that company's events; the agent's status for a
 * key), so a passing check refreshes the cached actor and bumps it only when
 * that state changed instead of on every heartbeat.
 */
interface ActorAccess {
  allowed: boolean;
  fingerprint: string;
  // AgentDash (GH #937): the actor the check already loaded — a passing
  // re-check hands it to the subscriber filter so the event path's cached
  // actor is refreshed (and its TTL renewed) instead of re-read.
  actor?: LiveEventActor;
}

async function boardUserAccess(db: Db, userId: string, companyId: string): Promise<ActorAccess> {
  // Targeted: this socket only ever receives events for `companyId`, so the
  // actor needs only that membership, not every company the user belongs to.
  const actor = await loadBoardUserActor(db, userId, companyId);
  const memberships = actor.memberships ?? [];
  const allowed = Boolean(actor.isInstanceAdmin) || memberships.length > 0;
  const fingerprint = JSON.stringify({
    admin: Boolean(actor.isInstanceAdmin),
    memberships: memberships
      .map((m) => `${m.companyId}:${m.membershipRole ?? ""}:${m.status ?? ""}`)
      .sort(),
  });
  return { allowed, fingerprint, actor };
}

async function agentAccessInCompany(db: Db, agentId: string, companyId: string): Promise<ActorAccess> {
  const agent = await db
    .select({ companyId: agents.companyId, status: agents.status })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
  const allowed = Boolean(agent && agent.companyId === companyId && !INACTIVE_AGENT_STATUSES.has(agent.status));
  return {
    allowed,
    fingerprint: `agent:${agent?.status ?? "missing"}`,
    actor: { type: "agent", agentId, companyId, source: "agent_key" },
  };
}

/**
 * AgentDash (GH #708): does the credential this socket was opened with still
 * grant read access to its company? Run on the heartbeat and on access-change
 * signals, never per event.
 */
async function reauthorize(db: Db, context: UpgradeContext): Promise<ActorAccess> {
  if (context.source === "local_implicit") {
    return {
      allowed: true,
      fingerprint: "local_implicit",
      actor: { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" },
    };
  }

  if (context.source === "session") {
    if (context.sessionId) {
      const session = await db
        .select({ expiresAt: authSessions.expiresAt })
        .from(authSessions)
        .where(eq(authSessions.id, context.sessionId))
        .then((rows) => rows[0] ?? null);
      if (!session || session.expiresAt.getTime() <= Date.now()) {
        return { allowed: false, fingerprint: "session-expired" };
      }
    }
    return boardUserAccess(db, context.actorId, context.companyId);
  }

  if (!context.keyId) return { allowed: false, fingerprint: "no-key" };
  const key = await db
    .select({ companyId: agentApiKeys.companyId, agentId: agentApiKeys.agentId })
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.id, context.keyId), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);
  if (!key || key.companyId !== context.companyId || key.agentId !== context.actorId) {
    return { allowed: false, fingerprint: "key-revoked" };
  }
  return agentAccessInCompany(db, context.actorId, context.companyId);
}

/** One re-authorization per credential per heartbeat, however many sockets share it. */
function credentialCacheKey(context: UpgradeContext) {
  return [context.source, context.actorId, context.keyId ?? "", context.sessionId ?? "", context.companyId].join("|");
}

function accessChangeMatches(change: LiveEventAccessChange, context: UpgradeContext) {
  if (change.companyId && change.companyId !== context.companyId) return false;
  if (change.kind === "company") return true;
  if (change.kind === "user") return context.source === "session" && context.actorId === change.userId;
  return context.source === "agent_key" && context.actorId === change.agentId;
}

/** The subscriber as the REST auth middleware would describe it on `req.actor`. */
async function liveEventActorFor(db: Db, context: UpgradeContext): Promise<LiveEventActor> {
  if (context.source === "local_implicit") {
    return { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" };
  }
  if (context.source === "agent_key") {
    return { type: "agent", agentId: context.actorId, companyId: context.companyId, source: "agent_key" };
  }
  return loadBoardUserActor(db, context.actorId, context.companyId);
}

export function setupLiveEventsWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
    /** AgentDash (GH #708): heartbeat (ping + re-authorization) interval; tests only. */
    heartbeatIntervalMs?: number;
    /** AgentDash (GH #708): a re-authorization slower than this counts as failed; tests only. */
    recheckTimeoutMs?: number;
  },
) {
  const wss = new WebSocketServer({ noServer: true });
  const recheckTimeoutMs = opts.recheckTimeoutMs ?? DEFAULT_RECHECK_TIMEOUT_MS;
  const cleanupByClient = new Map<WsSocket, () => void>();
  const aliveByClient = new Map<WsSocket, boolean>();
  // AgentDash (GH #830 part A follow-up): per-subscriber project visibility.
  const visibility = createLiveEventVisibility(db);

  // AgentDash (GH #708): what each open socket was authorized as, so it can be
  // re-authorized on the heartbeat and on access-change signals.
  type ClientAccess = {
    context: UpgradeContext;
    revoked: boolean;
    // AgentDash (GH #937): refreshes the subscriber filter's cached actor —
    // with the one a passing check just loaded — so the event path does not
    // re-read it when the TTL expires between heartbeats.
    refreshActor: (actor: LiveEventActor, changed: boolean) => void;
    // AgentDash (GH #937): the fingerprint the last authorization check saw;
    // the cached actor is re-read only when a passing check reports a
    // different one, not on every heartbeat.
    actorFingerprint: string;
    // An access-change re-check in flight. Events published after the change
    // wait for it, so none slips out between the commit and the close.
    pendingCheck: Promise<void> | null;
    // A chained check that has not started yet; it will read the state after any later change too.
    queuedCheck: boolean;
    // Consecutive heartbeat re-checks that failed with a database error.
    errorStreak: number;
  };
  const accessByClient = new Map<WsSocket, ClientAccess>();

  function revokeClient(socket: WsSocket, access: ClientAccess, reason: string) {
    if (access.revoked) return;
    access.revoked = true;
    // Stop queueing events at once; the close handler cleans up the rest.
    const cleanup = cleanupByClient.get(socket);
    if (cleanup) cleanup();
    cleanupByClient.delete(socket);
    logger.info?.(
      { companyId: access.context.companyId, actorType: access.context.actorType, actorId: access.context.actorId, reason },
      "live websocket access revoked; closing",
    );
    try {
      socket.close(LIVE_EVENTS_REVOKED_CLOSE_CODE, "access revoked");
    } catch {
      socket.terminate();
    }
  }

  /**
   * AgentDash (GH #937): a passing check carries the fingerprint — and the
   * actor — it observed. Refresh the event-path cache with it, bumping the
   * actor epoch only when the fingerprint moved, so a heartbeat that changes
   * nothing costs zero actor re-reads AND keeps the cache from expiring.
   */
  function applyRecheck(access: ClientAccess, result: { actor?: LiveEventActor; fingerprint?: string }) {
    if (result.actor === undefined || result.fingerprint === undefined) return;
    const changed = result.fingerprint !== access.actorFingerprint;
    access.actorFingerprint = result.fingerprint;
    access.refreshActor(result.actor, changed);
  }

  /**
   * `failClosed`: a check that errors revokes the socket (access-change signals).
   * Heartbeat checks fail open for a transient error, but revoke after
   * MAX_HEARTBEAT_CHECK_ERRORS consecutive ones.
   */
  async function recheckClient(
    socket: WsSocket,
    access: ClientAccess,
    reason: string,
    opts: { memo?: Map<string, Promise<ActorAccess>>; failClosed?: boolean } = {},
  ): Promise<{ allowed: boolean; fingerprint?: string; actor?: LiveEventActor }> {
    if (access.revoked) return { allowed: false };
    let pending: Promise<ActorAccess>;
    const key = credentialCacheKey(access.context);
    const shared = opts.memo?.get(key);
    if (shared) {
      pending = shared;
    } else {
      pending = reauthorize(db, access.context);
      opts.memo?.set(key, pending);
    }
    let result: ActorAccess;
    try {
      result = await withTimeout(pending, recheckTimeoutMs);
    } catch (err) {
      // A rejected or hung shared check must not poison later sockets this tick.
      if (opts.memo?.get(key) === pending) opts.memo.delete(key);
      logger.warn({ err, companyId: access.context.companyId }, "live websocket re-authorization failed");
      if (opts.failClosed) {
        revokeClient(socket, access, `${reason} (re-authorization failed)`);
        return { allowed: false };
      }
      access.errorStreak += 1;
      if (access.errorStreak >= MAX_HEARTBEAT_CHECK_ERRORS) {
        revokeClient(socket, access, `${reason} (re-authorization failed ${access.errorStreak} times)`);
        return { allowed: false };
      }
      return { allowed: true };
    }
    access.errorStreak = 0;
    if (!result.allowed) revokeClient(socket, access, reason);
    return result;
  }

  const unsubscribeAccessChanges = subscribeLiveEventAccessChanges((change) => {
    for (const [socket, access] of accessByClient) {
      if (access.revoked || !accessChangeMatches(change, access.context)) continue;
      // Coalesced: a check queued but not started will read the committed state
      // of this change too (changes publish after commit), so reuse it.
      if (access.queuedCheck) continue;
      access.queuedCheck = true;
      // Chained: a change during a running check waits for it, none is overwritten.
      const previous = access.pendingCheck ?? Promise.resolve();
      const check: Promise<void> = previous
        .then(() => {
          access.queuedCheck = false;
          return recheckClient(socket, access, change.reason, { failClosed: true });
        })
        .then((result) => {
          // Still allowed (e.g. admin demoted to member): apply the new role
          // to the next event — and only when the role actually moved.
          if (result.allowed) applyRecheck(access, result);
          if (access.pendingCheck === check) access.pendingCheck = null;
        });
      access.pendingCheck = check;
    }
  });

  const pingInterval = setInterval(() => {
    // AgentDash (GH #708): one re-authorization per credential per heartbeat.
    const memo = new Map<string, Promise<ActorAccess>>();
    for (const socket of wss.clients) {
      if (!aliveByClient.get(socket)) {
        socket.terminate();
        continue;
      }
      const access = accessByClient.get(socket);
      if (access) {
        void recheckClient(socket, access, "heartbeat re-authorization", { memo }).then((result) => {
          // Out-of-band role changes reach the next event only when the check
          // observed a change; either way the check's actor refreshes the
          // event-path cache before its TTL can expire (GH #937).
          if (result.allowed) applyRecheck(access, result);
        });
      }
      aliveByClient.set(socket, false);
      socket.ping();
    }
  }, opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    const context = (req as IncomingMessageWithContext).paperclipUpgradeContext;
    if (!context) {
      socket.close(1008, "missing context");
      return;
    }

    // AgentDash (GH #830 part A follow-up): an event about an issue, run or
    // project in a restricted project reaches only subscribers who could read
    // that resource over REST. Delivery stays in publish order per socket.
    const shouldDeliver = visibility.createSubscriberFilter({
      companyId: context.companyId,
      loadActor: () => liveEventActorFor(db, context),
    });
    const access: ClientAccess = {
      context,
      revoked: false,
      refreshActor: shouldDeliver.refreshActor,
      actorFingerprint: context.actorFingerprint,
      pendingCheck: null,
      queuedCheck: false,
      errorStreak: 0,
    };
    accessByClient.set(socket, access);
    let delivery: Promise<void> = Promise.resolve();
    const unsubscribe = subscribeCompanyLiveEvents(context.companyId, (event) => {
      void visibility.resolveEvent(event); // resolve (and invalidate caches) at emit time
      delivery = delivery.then(async () => {
        // AgentDash (GH #708): wait out an access-change re-check, then
        // deliver nothing more after a revocation, even if queued before it.
        if (access.pendingCheck) await access.pendingCheck;
        if (access.revoked) return;
        let deliver = false;
        try {
          deliver = await shouldDeliver(event);
        } catch (err) {
          logger.warn({ err, companyId: context.companyId, type: event.type }, "live event visibility check failed");
        }
        if (!deliver || socket.readyState !== WebSocket.OPEN) return;
        // GH #863: prune blocker / referenced-issue entries this subscriber
        // cannot see. A failure drops the event (fail closed).
        let outgoing = event;
        try {
          outgoing = await shouldDeliver.redactForSubscriber(event);
        } catch (err) {
          logger.warn({ err, companyId: context.companyId, type: event.type }, "live event redaction failed");
          return;
        }
        if (access.revoked || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify(outgoing));
      });
    });

    cleanupByClient.set(socket, unsubscribe);
    aliveByClient.set(socket, true);

    socket.on("pong", () => {
      aliveByClient.set(socket, true);
    });

    socket.on("close", () => {
      const cleanup = cleanupByClient.get(socket);
      if (cleanup) cleanup();
      cleanupByClient.delete(socket);
      aliveByClient.delete(socket);
      accessByClient.delete(socket); // AgentDash (GH #708)
    });

    socket.on("error", (err: Error) => {
      logger.warn({ err, companyId: context.companyId }, "live websocket client error");
    });
  });

  wss.on("close", () => {
    clearInterval(pingInterval);
    unsubscribeAccessChanges(); // AgentDash (GH #708)
  });

  server.on("upgrade", (req, socket, head) => {
    // AgentDash (#766, SC-5): behind the edge router, an upgrade must carry the edge secret.
    if (!edgeUpgradeAllowed(req)) {
      rejectUpgrade(socket, "403 Forbidden", "edge required");
      return;
    }
    const onRawSocketError = (err: Error) => {
      logger.warn({ err, path: req.url }, "live websocket upgrade socket error");
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

    const url = new URL(req.url, "http://localhost");
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
      .catch((err) => {
        logger.error({ err, path: req.url }, "failed websocket upgrade authorization");
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
      });
  });

  return wss;
}
