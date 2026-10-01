import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentApiKeys, agents, companies, companyMemberships, createDb, instanceUserRoles } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import {
  liveEventAccessListenerCount,
  publishLiveEventAccessChange,
  subscribeLiveEventAccessChanges,
  type LiveEventAccessChange,
} from "../realtime/live-events-access.js";
import { publishLiveEvent } from "../services/live-events.js";
import { accessService } from "../services/access.js";
import { agentService } from "../services/agents.js";
import { companyService } from "../services/companies.js";
import { claimBoardOwnership, getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "../board-claim.js";
import { logger } from "../middleware/logger.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as new (url: string, opts?: { headers?: Record<string, string> }) => {
  readyState: number;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  close(): void;
};
const WS_OPEN = 1;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * AgentDash (GH #708): a live-events socket is authorized at the upgrade and
 * must not outlive that authorization. Losing access (membership archived or
 * suspended, key revoked, agent terminated) closes the socket with 1008 —
 * immediately when the change goes through a service, and within one
 * heartbeat when it does not (a direct database write, another process).
 * Falsification: drop the heartbeat re-authorization in live-events-ws.ts and
 * the "within one heartbeat" tests fail; drop the access-change subscription
 * and the "immediately" tests fail.
 */
describeEmbeddedPostgres("live events websocket closes when access is revoked", () => {
  const HEARTBEAT_MS = 30_000;
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let server: Server | null = null;
  let baseUrl = "";
  let faultyServer: Server | null = null;
  let faultyUrl = "";
  let dbMode: "ok" | "error" | "hang" = "ok";
  let faultySelects = 0;
  const COMPANY = randomUUID();
  const OTHER_COMPANY = randomUUID();

  type Client = {
    events: LiveEvent[];
    isOpen: () => boolean;
    closed: Promise<number>;
    close: () => void;
  };
  const clients: Client[] = [];

  /** The test database, except `select` errors or never settles while dbMode says so. */
  function faultyDb() {
    const hanging: unknown = new Proxy(function () {}, {
      get: (_t, prop) => (prop === "then" ? () => undefined : () => hanging),
      apply: () => hanging,
    });
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") faultySelects += 1;
        if (prop === "select" && dbMode !== "ok") {
          return () => {
            if (dbMode === "error") throw new Error("simulated database failure");
            return hanging;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  const hash = (token: string) => createHash("sha256").update(token).digest("hex");

  async function connect(headers: Record<string, string>, base = baseUrl): Promise<Client> {
    const ws = new WebSocket(`${base}/api/companies/${COMPANY}/events/ws`, { headers });
    let resolveClosed: (code: number) => void = () => undefined;
    const client: Client = {
      events: [],
      isOpen: () => ws.readyState === WS_OPEN,
      closed: new Promise<number>((resolve) => {
        resolveClosed = resolve;
      }),
      close: () => ws.close(),
    };
    ws.on("message", (data) => client.events.push(JSON.parse(data.toString()) as LiveEvent));
    ws.on("close", (code) => resolveClosed(code));
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    clients.push(client);
    return client;
  }

  async function addUser(role: "admin" | "member" = "member") {
    const userId = `user-${randomUUID()}`;
    const [membership] = await db
      .insert(companyMemberships)
      .values({ companyId: COMPANY, principalType: "user", principalId: userId, status: "active", membershipRole: role })
      .returning();
    return { userId, membershipId: membership!.id, client: await connect({ "x-test-user": userId }) };
  }

  async function addAgent() {
    const agentId = randomUUID();
    const token = `pcp_${randomUUID()}`;
    await db.insert(agents).values({ id: agentId, companyId: COMPANY, name: `Agent ${agentId.slice(0, 6)}`, role: "general" });
    const [key] = await db
      .insert(agentApiKeys)
      .values({ agentId, companyId: COMPANY, name: "live", keyHash: hash(token) })
      .returning();
    return { agentId, keyId: key!.id, client: await connect({ authorization: `Bearer ${token}` }) };
  }

  /** Publish a marker and wait until every watched client has it: everything before it is decided. */
  async function settle(watch: Client[]) {
    const marker = randomUUID();
    publishLiveEvent({ companyId: COMPANY, type: "agent.status", payload: { agentId: marker } });
    const deadline = Date.now() + 5000;
    while (!watch.every((c) => c.events.some((e) => e.payload.agentId === marker))) {
      if (Date.now() > deadline) throw new Error("marker not delivered");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return marker;
  }

  /** Resolve with the close code, or null if the socket is still open after `ms` of real time. */
  async function closeCodeWithin(client: Client, ms: number) {
    return Promise.race([client.closed, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
  }

  const sawMarker = (c: Client, marker: string) => c.events.some((e) => e.payload.agentId === marker);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-live-events-revocation-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values([
      { id: COMPANY, name: "Live Revocation Co", issuePrefix: "LRV" },
      { id: OTHER_COMPANY, name: "Other Co", issuePrefix: "OTH" },
    ]);

    // Only the heartbeat interval is faked; I/O timers stay real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    server = createServer();
    setupLiveEventsWebSocketServer(server, db, {
      deploymentMode: "authenticated",
      heartbeatIntervalMs: HEARTBEAT_MS,
      resolveSessionFromHeaders: async (headers) => {
        const userId = headers.get("x-test-user");
        if (!userId) return null;
        // No session id: these tests revoke membership, not the session row.
        return { session: null, user: { id: userId, email: `${userId}@example.com`, name: userId } } as never;
      },
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    baseUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // A second server whose database can be made to fail or hang on demand,
    // to prove a change-triggered re-check fails closed.
    faultyServer = createServer();
    setupLiveEventsWebSocketServer(faultyServer, faultyDb(), {
      deploymentMode: "authenticated",
      heartbeatIntervalMs: HEARTBEAT_MS,
      recheckTimeoutMs: 300,
      resolveSessionFromHeaders: async (headers) => {
        const userId = headers.get("x-test-user");
        if (!userId) return null;
        return { session: null, user: { id: userId, email: `${userId}@example.com`, name: userId } } as never;
      },
    });
    await new Promise<void>((resolve) => faultyServer!.listen(0, "127.0.0.1", resolve));
    faultyUrl = `ws://127.0.0.1:${(faultyServer.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    for (const client of clients) client.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (faultyServer) await new Promise<void>((resolve) => faultyServer!.close(() => resolve()));
    await tempDb?.cleanup();
  });

  it("closes a removed member's socket within one heartbeat and delivers nothing more; others stay open", async () => {
    const removed = await addUser();
    const kept = await addUser();

    // Removed out of band (no service call, so no access-change signal).
    await db
      .update(companyMemberships)
      .set({ status: "archived" })
      .where(eq(companyMemberships.id, removed.membershipId));

    // Without a heartbeat the socket is still open: the upgrade check alone is not enough.
    expect(await closeCodeWithin(removed.client, 200)).toBeNull();

    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(await closeCodeWithin(removed.client, 5000)).toBe(1008);

    const marker = await settle([kept.client]);
    expect(sawMarker(removed.client, marker)).toBe(false);
    expect(kept.client.isOpen()).toBe(true);
  });

  it("closes a socket opened with a revoked agent key within one heartbeat; another agent stays open", async () => {
    const revoked = await addAgent();
    const kept = await addAgent();

    await db
      .update(agentApiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(agentApiKeys.id, revoked.keyId), eq(agentApiKeys.agentId, revoked.agentId)));

    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(await closeCodeWithin(revoked.client, 5000)).toBe(1008);

    const marker = await settle([kept.client]);
    expect(sawMarker(revoked.client, marker)).toBe(false);
    expect(kept.client.isOpen()).toBe(true);
  });

  it("closes immediately, without a heartbeat, when the membership is suspended through the access service", async () => {
    const removed = await addUser();
    const kept = await addUser();

    await accessService(db).updateMember(COMPANY, removed.membershipId, { status: "suspended" });
    // Published in the window between the commit and the close: must not reach the removed member.
    const racing = randomUUID();
    publishLiveEvent({ companyId: COMPANY, type: "agent.status", payload: { agentId: racing } });
    expect(await closeCodeWithin(removed.client, 5000)).toBe(1008);

    const marker = await settle([kept.client]);
    expect(sawMarker(removed.client, racing)).toBe(false);
    expect(sawMarker(removed.client, marker)).toBe(false);
    expect(sawMarker(kept.client, racing)).toBe(true);
    expect(kept.client.isOpen()).toBe(true);
  });

  it("closes immediately when the member is removed (archived) through the access service", async () => {
    const removed = await addUser();
    const kept = await addUser();

    await accessService(db).archiveMember(COMPANY, removed.membershipId);
    expect(await closeCodeWithin(removed.client, 5000)).toBe(1008);

    const marker = await settle([kept.client]);
    expect(sawMarker(removed.client, marker)).toBe(false);
    expect(kept.client.isOpen()).toBe(true);
  });

  it("leaves a socket open when the same user loses access to a different company", async () => {
    const user = await addUser();
    const [otherMembership] = await db
      .insert(companyMemberships)
      .values({ companyId: OTHER_COMPANY, principalType: "user", principalId: user.userId, status: "active", membershipRole: "member" })
      .returning();

    await accessService(db).updateMember(OTHER_COMPANY, otherMembership!.id, { status: "suspended" });
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await settle([user.client]);
    expect(await closeCodeWithin(user.client, 200)).toBeNull();
    expect(user.client.isOpen()).toBe(true);
  });

  it("closes immediately when the agent's key is revoked or the agent is terminated through the agent service", async () => {
    const keyRevoked = await addAgent();
    const terminated = await addAgent();
    const kept = await addAgent();
    const agentsSvc = agentService(db);

    await agentsSvc.revokeKey(keyRevoked.agentId, keyRevoked.keyId);
    expect(await closeCodeWithin(keyRevoked.client, 5000)).toBe(1008);

    await agentsSvc.terminate(terminated.agentId);
    expect(await closeCodeWithin(terminated.client, 5000)).toBe(1008);

    const marker = await settle([kept.client]);
    expect(sawMarker(keyRevoked.client, marker)).toBe(false);
    expect(sawMarker(terminated.client, marker)).toBe(false);
    expect(kept.client.isOpen()).toBe(true);
  });

  it("keeps a demoted admin connected: still a member, so still authorized", async () => {
    const demoted = await addUser("admin");
    await addUser("admin"); // the company keeps an admin, so the demotion is allowed

    await accessService(db).updateMember(COMPANY, demoted.membershipId, { membershipRole: "member" });
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await settle([demoted.client]);
    expect(await closeCodeWithin(demoted.client, 200)).toBeNull();
    expect(demoted.client.isOpen()).toBe(true);
  });

  it("stops its heartbeat and access-change subscription when the server closes (no timer leak)", async () => {
    const intervalsBefore = vi.getTimerCount();
    const listenersBefore = liveEventAccessListenerCount();
    const wss = setupLiveEventsWebSocketServer(createServer(), db, { deploymentMode: "authenticated" });
    expect(vi.getTimerCount()).toBe(intervalsBefore + 1);
    expect(liveEventAccessListenerCount()).toBe(listenersBefore + 1);

    await new Promise<void>((resolve) => wss.close(() => resolve()));
    expect(vi.getTimerCount()).toBe(intervalsBefore);
    expect(liveEventAccessListenerCount()).toBe(listenersBefore);
  });

  it("closes immediately when the agent is deleted through the agent service", async () => {
    const deleted = await addAgent();
    const kept = await addAgent();

    await agentService(db).remove(deleted.agentId);
    expect(await closeCodeWithin(deleted.client, 5000)).toBe(1008);

    const marker = await settle([kept.client]);
    expect(sawMarker(deleted.client, marker)).toBe(false);
    expect(kept.client.isOpen()).toBe(true);
  });

  it("closes an instance admin's socket when the admin role is demoted", async () => {
    const userId = `user-${randomUUID()}`;
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    const admin = { userId, client: await connect({ "x-test-user": userId }) };
    const kept = await addUser();

    await accessService(db).demoteInstanceAdmin(admin.userId);
    expect(await closeCodeWithin(admin.client, 5000)).toBe(1008);
    expect(kept.client.isOpen()).toBe(true);
  });

  it("publishes a company access change on archive; REST keeps an archived company readable, so sockets stay open", async () => {
    const archivedCompany = randomUUID();
    await db.insert(companies).values({ id: archivedCompany, name: "Archive Co", issuePrefix: "ARC" });
    const seen: LiveEventAccessChange[] = [];
    const unsubscribe = subscribeLiveEventAccessChanges((change) => seen.push(change));
    const user = await addUser();
    try {
      await companyService(db).archive(archivedCompany);
      expect(seen).toContainEqual({ kind: "company", companyId: archivedCompany, reason: "company archived" });
      // Parity: auth/authz do not consult companies.status, so archive alone revokes nothing.
      await companyService(db).archive(COMPANY);
      await settle([user.client]);
      expect(user.client.isOpen()).toBe(true);
    } finally {
      unsubscribe();
      await db.update(companies).set({ status: "active" }).where(eq(companies.id, COMPANY));
    }
  });

  it("fails closed: a database error during a change-triggered check closes the socket", async () => {
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId: COMPANY, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    const client = await connect({ "x-test-user": userId }, faultyUrl);

    dbMode = "error";
    try {
      publishLiveEventAccessChange({ kind: "user", userId, companyId: COMPANY, reason: "test change" });
      expect(await closeCodeWithin(client, 5000)).toBe(1008);
    } finally {
      dbMode = "ok";
    }
  });

  it("fails closed: a hung change-triggered check times out and closes the socket", async () => {
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId: COMPANY, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    const client = await connect({ "x-test-user": userId }, faultyUrl);

    dbMode = "hang";
    try {
      publishLiveEventAccessChange({ kind: "user", userId, companyId: COMPANY, reason: "test change" });
      expect(await closeCodeWithin(client, 5000)).toBe(1008);
    } finally {
      dbMode = "ok";
    }
  });

  it("heartbeat re-checks fail open for a transient error but close after 3 consecutive errors", async () => {
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId: COMPANY, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    const client = await connect({ "x-test-user": userId }, faultyUrl);

    dbMode = "error";
    try {
      for (let beat = 0; beat < 2; beat++) {
        vi.advanceTimersByTime(HEARTBEAT_MS);
        expect(await closeCodeWithin(client, 300)).toBeNull();
        // answer the ping so the liveness check does not terminate the socket first
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      vi.advanceTimersByTime(HEARTBEAT_MS);
      expect(await closeCodeWithin(client, 5000)).toBe(1008);
    } finally {
      dbMode = "ok";
    }
  });

  it("two back-to-back access changes on one socket revoke it once and leak nothing", async () => {
    const removed = await addUser();
    const kept = await addUser();
    const listenersBefore = liveEventAccessListenerCount();
    const revokeLogs = vi.spyOn(logger, "info");

    try {
      await db.update(companyMemberships).set({ status: "archived" }).where(eq(companyMemberships.id, removed.membershipId));
      publishLiveEventAccessChange({ kind: "user", userId: removed.userId, companyId: COMPANY, reason: "first change" });
      publishLiveEventAccessChange({ kind: "user", userId: removed.userId, companyId: COMPANY, reason: "second change" });
      expect(await closeCodeWithin(removed.client, 5000)).toBe(1008);
      // A third change after the close is a no-op.
      publishLiveEventAccessChange({ kind: "user", userId: removed.userId, companyId: COMPANY, reason: "late change" });
      await settle([kept.client]);

      const revokes = revokeLogs.mock.calls.filter(
        ([fields, message]) =>
          message === "live websocket access revoked; closing" &&
          (fields as { actorId?: string }).actorId === removed.userId,
      );
      expect(revokes).toHaveLength(1);
      expect(kept.client.isOpen()).toBe(true);
      expect(liveEventAccessListenerCount()).toBe(listenersBefore);
    } finally {
      revokeLogs.mockRestore();
    }
  });

  it("coalesces changes that arrive while a check is still queued into one re-check", async () => {
    const mkUser = async () => {
      const userId = `user-${randomUUID()}`;
      await db.insert(companyMemberships).values({ companyId: COMPANY, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
      return { userId, client: await connect({ "x-test-user": userId }, faultyUrl) };
    };
    const one = await mkUser();
    const many = await mkUser();
    const change = (userId: string) =>
      publishLiveEventAccessChange({ kind: "user", userId, companyId: COMPANY, reason: "burst" });
    const settleChecks = () => new Promise((resolve) => setTimeout(resolve, 300));

    faultySelects = 0;
    change(one.userId);
    await settleChecks();
    const singleCost = faultySelects;
    expect(singleCost).toBeGreaterThan(0);

    faultySelects = 0;
    change(many.userId);
    change(many.userId);
    change(many.userId);
    await settleChecks();
    expect(faultySelects).toBe(singleCost);
    expect(many.client.isOpen()).toBe(true);
  });

  it("publishes access changes when the board is claimed", async () => {
    const claimant = `user-${randomUUID()}`;
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const url = new URL(getBoardClaimWarningUrl("localhost", 3100)!);
    const token = url.pathname.split("/").pop()!;
    const seen: LiveEventAccessChange[] = [];
    const unsubscribe = subscribeLiveEventAccessChanges((change) => seen.push(change));
    try {
      const result = await claimBoardOwnership(db, { token, code: url.searchParams.get("code") ?? undefined, userId: claimant });
      expect(result.status).toBe("claimed");
      expect(seen).toContainEqual({ kind: "user", userId: "local-board", reason: "board ownership claimed" });
      expect(seen).toContainEqual({ kind: "user", userId: claimant, reason: "board ownership claimed" });
    } finally {
      unsubscribe();
    }
  });

  it("refuses a new socket for a terminated agent's key", async () => {
    const agentId = randomUUID();
    const token = `pcp_${randomUUID()}`;
    await db.insert(agents).values({ id: agentId, companyId: COMPANY, name: "Gone", role: "general", status: "terminated" });
    await db.insert(agentApiKeys).values({ agentId, companyId: COMPANY, name: "live", keyHash: hash(token) });
    await expect(connect({ authorization: `Bearer ${token}` })).rejects.toThrow(/403/);
  });
});
