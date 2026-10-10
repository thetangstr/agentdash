import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { eq } from "drizzle-orm";
import { WebSocket } from "ws";
import { agentApiKeys, agents, authSessions, authUsers, companies, companyMemberships, createDb, instanceUserRoles } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "../services/live-events.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

class FakeUpgradeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writableEnded = false;
  writableDestroyed = false;
  endedChunks: string[] = [];
  destroyCalls = 0;

  end(chunk?: string) {
    if (chunk) this.endedChunks.push(chunk);
    this.writableEnded = true;
    this.writable = false;
    setImmediate(() => {
      if (this.destroyed) return;
      this.emit("finish");
      if (!this.destroyed) {
        this.emit("close");
      }
    });
    return this;
  }

  destroy() {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("close");
    return this;
  }

  emitSocketError(err: Error) {
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("error", err);
  }
}

function createUpgradeRequest(overrides: Partial<IncomingMessage> = {}) {
  return {
    url: "/api/companies/company-1/events/ws",
    headers: {},
    ...overrides,
  } as IncomingMessage;
}

async function flushPromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("setupLiveEventsWebSocketServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not write a rejection response after the raw upgrade socket is already closed", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    socket.destroy();
    await flushPromises();

    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyCalls).toBe(1);
  });

  it("handles raw upgrade socket errors during async authorization", async () => {
    const server = new EventEmitter();
    let resolveSession: (value: null) => void = () => undefined;
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest({ url: "/api/companies/company-1/events/ws?token=DO_NOT_LOG" }), socket as unknown as Duplex, Buffer.alloc(0));
    expect(() => socket.emitSocketError(new Error("write EPIPE"))).not.toThrow();
    resolveSession(null);
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), path: "/api/companies/company-1/events/ws" }),
      "live websocket upgrade socket error",
    );
    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyed).toBe(true);
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("DO_NOT_LOG");
  });

  it("destroys and cleans up listeners after flushing a rejection response", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("finish")).toBe(0);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbedded = embeddedPostgresSupport.supported ? describe : describe.skip;

// AgentDash (#708): real sockets and disposable DB rows exercise post-upgrade revocation.
describeEmbedded("live websocket authorization after upgrade", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const servers: Server[] = [];
  const clients: WebSocket[] = [];
  const websocketServers: Array<ReturnType<typeof setupLiveEventsWebSocketServer>> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ws-revocation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const client of clients.splice(0)) client.terminate();
    for (const wss of websocketServers.splice(0)) {
      for (const socket of wss.clients) socket.terminate();
      (wss as unknown as { close(): void }).close();
    }
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(instanceUserRoles);
    await db.delete(authSessions);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Websocket test", issuePrefix: `WS${randomUUID().slice(0, 5)}` }).returning();
    const now = new Date();
    const userId = randomUUID();
    const [user] = await db.insert(authUsers).values({ id: userId, name: "Test user", email: `${userId}@example.test`, createdAt: now, updatedAt: now }).returning();
    const [session] = await db.insert(authSessions).values({ id: randomUUID(), userId, token: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000), createdAt: now, updatedAt: now }).returning();
    const [membership] = await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: userId, status: "active", membershipRole: "member" }).returning();
    return { company: company!, user: user!, session: session!, membership: membership! };
  }

  async function connect(input: Awaited<ReturnType<typeof fixture>>, token?: string) {
    const server = createServer();
    servers.push(server);
    const wss = setupLiveEventsWebSocketServer(server, db, {
      deploymentMode: "authenticated",
      // Deliberately cached: revocation must be checked against the session row.
      resolveSessionFromHeaders: async () => ({ user: input.user, session: input.session }),
    });
    websocketServers.push(wss);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/companies/${input.company.id}/events/ws`, {
      headers: token ? { authorization: `Bearer ${token}` } : { cookie: "synthetic-session-cookie" },
    });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const received: number[] = [];
    client.on("message", (data) => received.push(JSON.parse(data.toString()).payload.sequence));
    const closed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)));
    return { client, wss, received, closed };
  }

  function publish(companyId: string, sequence = 1) {
    publishLiveEvent({ companyId, type: "activity.logged", payload: { sequence } });
  }

  async function agentKey(companyId: string) {
    const [agent] = await db.insert(agents).values({ companyId, name: "Websocket agent", adapterType: "process", status: "idle" }).returning();
    const token = `synthetic-token-${randomUUID()}`;
    const [key] = await db.insert(agentApiKeys).values({ companyId, agentId: agent!.id, name: "Test key", keyHash: createHash("sha256").update(token).digest("hex") }).returning();
    return { agent: agent!, key: key!, token };
  }

  it("withholds an event and closes when company membership is removed", async () => {
    const input = await fixture();
    const connection = await connect(input);
    await db.delete(companyMemberships).where(eq(companyMemberships.id, input.membership.id));
    publish(input.company.id);
    await expect.poll(() => connection.client.readyState).toBe(WebSocket.CLOSED);
    expect(await connection.closed).toBe(1008);
    expect(connection.received).toEqual([]);
  });

  it("closes a quiet subscription on the next heartbeat after membership suspension", async () => {
    const input = await fixture();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const connection = await connect(input);
    await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.id, input.membership.id));
    await vi.advanceTimersByTimeAsync(30_000);
    await expect.poll(() => connection.client.readyState).toBe(WebSocket.CLOSED);
    expect(await connection.closed).toBe(1008);
    publish(input.company.id);
    await flushPromises();
    expect(connection.received).toEqual([]);
  });

  it("withholds events for the revoked key even when its agent has another active key", async () => {
    const input = await fixture();
    const first = await agentKey(input.company.id);
    await db.insert(agentApiKeys).values({ companyId: input.company.id, agentId: first.agent.id, name: "Other active key", keyHash: createHash("sha256").update("another-synthetic-key").digest("hex") });
    const connection = await connect(input, first.token);
    await db.update(agentApiKeys).set({ revokedAt: new Date() }).where(eq(agentApiKeys.id, first.key.id));
    publish(input.company.id);
    await expect.poll(() => connection.client.readyState).toBe(WebSocket.CLOSED);
    expect(await connection.closed).toBe(1008);
    expect(connection.received).toEqual([]);
  });

  it("closes a quiet agent socket on its next heartbeat after key revocation", async () => {
    const input = await fixture();
    const first = await agentKey(input.company.id);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const connection = await connect(input, first.token);
    await db.update(agentApiKeys).set({ revokedAt: new Date() }).where(eq(agentApiKeys.id, first.key.id));
    await vi.advanceTimersByTimeAsync(30_000);
    await expect.poll(() => connection.client.readyState).toBe(WebSocket.CLOSED);
    expect(connection.received).toEqual([]);
  });

  it.each(["revoked", "expired"])("withholds events for a %s session even if the session resolver returns cached data", async (change) => {
    const input = await fixture();
    const connection = await connect(input);
    if (change === "revoked") await db.delete(authSessions).where(eq(authSessions.id, input.session.id));
    else await db.update(authSessions).set({ expiresAt: new Date(0) }).where(eq(authSessions.id, input.session.id));
    publish(input.company.id);
    await expect.poll(() => connection.client.readyState).toBe(WebSocket.CLOSED);
    expect(connection.received).toEqual([]);
  });

  it("closes an instance administrator after demotion when they have no company membership", async () => {
    const input = await fixture();
    await db.delete(companyMemberships).where(eq(companyMemberships.id, input.membership.id));
    const [role] = await db.insert(instanceUserRoles).values({ userId: input.user.id, role: "instance_admin" }).returning();
    const connection = await connect(input);
    await db.delete(instanceUserRoles).where(eq(instanceUserRoles.id, role!.id));
    publish(input.company.id);
    await expect.poll(() => connection.client.readyState).toBe(WebSocket.CLOSED);
    expect(connection.received).toEqual([]);
  });

  it("withholds events after the agent principal is terminated", async () => {
    const input = await fixture();
    const first = await agentKey(input.company.id);
    const connection = await connect(input, first.token);
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, first.agent.id));
    publish(input.company.id);
    await expect.poll(() => connection.client.readyState).toBe(WebSocket.CLOSED);
    expect(connection.received).toEqual([]);
  });

  it("delivers events in order for a valid session", async () => {
    const input = await fixture();
    const connection = await connect(input);
    publish(input.company.id, 1);
    publish(input.company.id, 2);
    publish(input.company.id, 3);
    await expect.poll(() => connection.received).toEqual([1, 2, 3]);
    expect(connection.client.readyState).toBe(WebSocket.OPEN);
  });

  it("does not write key lastUsedAt again during delivery or heartbeat refresh", async () => {
    const input = await fixture();
    const first = await agentKey(input.company.id);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const connection = await connect(input, first.token);
    const [before] = await db.select().from(agentApiKeys).where(eq(agentApiKeys.id, first.key.id));
    publish(input.company.id, 1);
    await expect.poll(() => connection.received).toEqual([1]);
    await vi.advanceTimersByTimeAsync(30_000);
    await flushPromises();
    const [after] = await db.select().from(agentApiKeys).where(eq(agentApiKeys.id, first.key.id));
    expect(after!.lastUsedAt).toEqual(before!.lastUsedAt);
  });

  it("fails closed on an authorization database error and unsubscribes", async () => {
    const input = await fixture();
    const connection = await connect(input);
    const select = vi.spyOn(db, "select").mockImplementation(() => { throw new Error("Synthetic database unavailable"); });
    publish(input.company.id);
    await expect.poll(() => connection.client.readyState).toBe(WebSocket.CLOSED);
    expect(connection.received).toEqual([]);
    select.mockClear();
    publish(input.company.id, 2);
    await flushPromises();
    expect(select).not.toHaveBeenCalled();
  });

  function delaySessionChecks(gate: Promise<void>) {
    let checks = 0;
    const originalSelect = db.select.bind(db);
    vi.spyOn(db, "select").mockImplementation((...args) => {
      const select = originalSelect(...args);
      const originalFrom = select.from.bind(select);
      select.from = ((table: Parameters<typeof originalFrom>[0]) => {
        const query = originalFrom(table);
        if (table === authSessions) {
          checks += 1;
          const originalThen = query.then.bind(query);
          query.then = ((...callbacks: Parameters<typeof originalThen>) => gate.then(() => originalThen(...callbacks))) as typeof query.then;
        }
        return query;
      }) as typeof select.from;
      return select;
    });
    return () => checks;
  }

  function holdFirstSessionSnapshot(gate: Promise<void>, captured: () => void) {
    let checks = 0;
    const originalSelect = db.select.bind(db);
    vi.spyOn(db, "select").mockImplementation((...args) => {
      const select = originalSelect(...args);
      const originalFrom = select.from.bind(select);
      select.from = ((table: Parameters<typeof originalFrom>[0]) => {
        const query = originalFrom(table);
        if (table === authSessions) {
          const originalThen = query.then.bind(query);
          query.then = ((...callbacks: Parameters<typeof originalThen>) => {
            checks += 1;
            if (checks !== 1) return originalThen(...callbacks);
            return originalThen(async (rows) => {
              captured();
              await gate;
              return rows;
            }).then(...callbacks);
          }) as typeof query.then;
        }
        return query;
      }) as typeof select.from;
      return select;
    });
    return () => checks;
  }

  it("does not grant a post-revocation event from an older successful heartbeat snapshot", async () => {
    const input = await fixture();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const connection = await connect(input);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let captured = () => {};
    const snapshot = new Promise<void>((resolve) => { captured = resolve; });
    const checks = holdFirstSessionSnapshot(gate, captured);
    await vi.advanceTimersByTimeAsync(19_000);
    await snapshot;
    await db.delete(authSessions).where(eq(authSessions.id, input.session.id));
    publish(input.company.id);
    release();
    await expect.poll(() => checks()).toBe(2);
    await expect.poll(() => connection.client.readyState).toBe(WebSocket.CLOSED);
    expect(await connection.closed).toBe(1008);
    expect(connection.received).toEqual([]);
  });

  it("starts a fresh heartbeat read after a pending event's pre-revocation snapshot", async () => {
    const input = await fixture();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const connection = await connect(input);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let captured = () => {};
    const snapshot = new Promise<void>((resolve) => { captured = resolve; });
    const checks = holdFirstSessionSnapshot(gate, captured);
    await vi.advanceTimersByTimeAsync(15_000);
    publish(input.company.id);
    await snapshot;
    await db.delete(authSessions).where(eq(authSessions.id, input.session.id));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(checks()).toBe(1);
    release();
    vi.useRealTimers();
    await expect.poll(() => checks()).toBe(2);
    await expect.poll(() => connection.client.readyState).toBe(WebSocket.CLOSED);
    expect(await connection.closed).toBe(1008);
  });

  it("stops a quiet subscription with stalled authorization within 30 seconds", async () => {
    const input = await fixture();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const connection = await connect(input);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    delaySessionChecks(gate);
    await db.delete(authSessions).where(eq(authSessions.id, input.session.id));
    const socket = [...connection.wss.clients][0]!;
    const close = vi.spyOn(socket, "close");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(close).toHaveBeenCalledWith(1008, "authorization changed");
    vi.useRealTimers();
    await expect.poll(() => connection.client.readyState).toBe(WebSocket.CLOSED);
    release();
    publish(input.company.id);
    await flushPromises();
    expect(connection.received).toEqual([]);
  });

  it("terminates a peer that does not finish its revocation close handshake within 30 seconds", async () => {
    const input = await fixture();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const connection = await connect(input);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    delaySessionChecks(gate);
    await db.delete(authSessions).where(eq(authSessions.id, input.session.id));
    const socket = [...connection.wss.clients][0]!;
    vi.spyOn(socket, "close").mockImplementation(() => {});
    const terminate = vi.spyOn(socket, "terminate");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(terminate).toHaveBeenCalledOnce();
    vi.useRealTimers();
    await expect.poll(() => connection.client.readyState).toBe(WebSocket.CLOSED);
    release();
    publish(input.company.id);
    await flushPromises();
    expect(connection.received).toEqual([]);
  });

  it("avoids overlapping authorization checks with heartbeat and preserves queued event order", async () => {
    const input = await fixture();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const connection = await connect(input);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const checks = delaySessionChecks(gate);
    publish(input.company.id, 1);
    publish(input.company.id, 2);
    publish(input.company.id, 3);
    await vi.advanceTimersByTimeAsync(30_000);
    await flushPromises();
    expect(connection.received).toEqual([]);
    expect(checks()).toBe(1);
    release();
    await expect.poll(() => connection.received).toEqual([1, 2, 3]);
  });

  it("times out stalled authorization and never delivers queued events after a late success", async () => {
    const input = await fixture();
    const connection = await connect(input);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    delaySessionChecks(gate);
    publish(input.company.id, 1);
    publish(input.company.id, 2);
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    await expect.poll(() => connection.client.readyState).toBe(WebSocket.CLOSED);
    release();
    await flushPromises();
    expect(connection.received).toEqual([]);
  });

  it("closes an overloaded delivery queue without sending its retained events", async () => {
    const input = await fixture();
    const connection = await connect(input);
    for (let sequence = 0; sequence < 500; sequence += 1) publish(input.company.id, sequence);
    await expect.poll(() => connection.client.readyState).toBe(WebSocket.CLOSED);
    expect(await connection.closed).toBe(1013);
    expect(connection.received).toEqual([]);
  });
});
