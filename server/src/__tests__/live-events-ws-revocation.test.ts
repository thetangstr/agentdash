import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentApiKeys, agents, authSessions, companies, companyMemberships, createDb, instanceUserRoles, projects } from "@paperclipai/db";
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
import {
  createBetterAuthHandler,
  createBetterAuthInstance,
  resolveBetterAuthSessionFromHeaders,
} from "../auth/better-auth.js";

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

  /**
   * The test database, except `select` errors or never settles while dbMode
   * says so. `faultySelects` counts only ACTOR reads — selects whose `from`
   * is instance_user_roles or company_memberships — so an event path that
   * legitimately recomputes the agent-visibility scope (agents, stewardships,
   * the company row) does not trip the "no actor re-read" assertions, while
   * a lazy actor reload still registers.
   */
  const ACTOR_TABLES = new Set<unknown>([instanceUserRoles, companyMemberships]);
  function faultyDb() {
    const hanging: unknown = new Proxy(function () {}, {
      get: (_t, prop) => (prop === "then" ? () => undefined : () => hanging),
      apply: () => hanging,
    });
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "select") return Reflect.get(target, prop, receiver);
        if (dbMode !== "ok") {
          return () => {
            if (dbMode === "error") throw new Error("simulated database failure");
            return hanging;
          };
        }
        return (...args: Parameters<typeof db.select>) => {
          const builder = Reflect.apply(db.select, db, args) as object;
          return new Proxy(builder, {
            get(b, bprop, breceiver) {
              if (bprop !== "from") return Reflect.get(b, bprop, breceiver);
              const from = Reflect.get(b, bprop, breceiver) as (table: unknown) => unknown;
              return (table: unknown) => {
                if (ACTOR_TABLES.has(table)) faultySelects += 1;
                return from.call(b, table);
              };
            },
          });
        };
      },
    });
  }

  const hash = (token: string) => createHash("sha256").update(token).digest("hex");

  async function connect(headers: Record<string, string>, base = baseUrl, companyId = COMPANY): Promise<Client> {
    const ws = new WebSocket(`${base}/api/companies/${companyId}/events/ws`, { headers });
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
  async function settle(watch: Client[], companyId = COMPANY) {
    const marker = randomUUID();
    publishLiveEvent({ companyId, type: "agent.status", payload: { agentId: marker } });
    // performance.now: Date.now can be frozen by the nowSpy in TTL tests.
    const deadline = performance.now() + 5000;
    while (!watch.every((c) => c.events.some((e) => e.payload.agentId === marker))) {
      if (performance.now() > deadline) throw new Error("marker not delivered");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return marker;
  }

  /** Wait until the counting proxy stops seeing selects — i.e. every heartbeat re-check from the just-fired interval has settled. */
  async function heartbeatSettled() {
    let last = -1;
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (faultySelects === last) return;
      last = faultySelects;
    }
    throw new Error("heartbeat re-checks did not settle");
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
    // Embedded Postgres startup is slow on a saturated machine; the default
    // hook timeout is not enough headroom there.
  }, 180_000);

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

  // AgentDash (GH #937): a passing heartbeat re-check used to invalidate the
  // cached actor unconditionally, so every socket re-read it from the
  // database on the next event. The re-check now carries a fingerprint of
  // the authorization state it observed; the actor is re-read only when that
  // fingerprint moved. A dedicated company keeps the count deterministic —
  // only this test's client sees these markers (ACTOR_TTL_MS expiry on the
  // other tests' lingering sockets cannot leak selects into the window).
  it("does not re-read the actor after an unchanged heartbeat, but does after a role change", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Fingerprint Co",
      issuePrefix: `FP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const userId = `user-${randomUUID()}`;
    const [membership] = await db
      .insert(companyMemberships)
      .values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" })
      .returning();
    const client = await connect({ "x-test-user": userId }, faultyUrl, companyId);

    // First event loads the actor and the agent-visibility scope; both are
    // cached for the rest of this test (real time stays well under the TTLs).
    await settle([client], companyId);

    // An unchanged heartbeat: the re-check still hits the database (it is
    // what detects out-of-band change), but the next event must reuse the
    // cached actor — zero selects on delivery.
    faultySelects = 0;
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await heartbeatSettled();
    expect(faultySelects).toBeGreaterThan(0);
    faultySelects = 0;
    await settle([client], companyId);
    expect(faultySelects).toBe(0);
    expect(client.isOpen()).toBe(true);

    // A heartbeat that observes a real authorization change (member → admin,
    // written out of band so no access-change signal) bumps the actor epoch —
    // and still costs the event path nothing, because the re-check hands the
    // actor it just loaded to the filter. Proven end to end: a restricted
    // project event the member could not see is delivered once promoted.
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Restricted",
      visibility: "restricted",
      createdByUserId: `user-${randomUUID()}`,
    });
    const restrictedEvent = () =>
      publishLiveEvent({
        companyId,
        type: "activity.logged",
        payload: { action: "project.updated", entityType: "project", entityId: projectId },
      });
    const sawProject = () => client.events.some((e) => e.payload.entityId === projectId);

    restrictedEvent(); // dropped: member is not on the project's access list
    await settle([client], companyId);
    expect(sawProject()).toBe(false);

    await db
      .update(companyMemberships)
      .set({ membershipRole: "admin" })
      .where(eq(companyMemberships.id, membership!.id));
    faultySelects = 0;
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await heartbeatSettled();
    faultySelects = 0;
    restrictedEvent();
    await settle([client], companyId);
    expect(sawProject()).toBe(true);
    expect(faultySelects).toBe(0);
    expect(client.isOpen()).toBe(true);
  });

  // AgentDash (GH #937): the actor cache TTL and the heartbeat interval are
  // both 30s in production, so without a refresh the TTL still expires a beat
  // later and the next event re-reads the actor — the fingerprint alone saved
  // nothing. Date.now is mocked so the REAL TTL elapses between beats while
  // the faked heartbeat interval advances; a passing re-check must renew the
  // cache with the actor it already loaded.
  it("re-reads nothing on the event path across heartbeats even after the actor TTL elapses", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Warm Cache Co",
      issuePrefix: `WM${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const userId = `user-${randomUUID()}`;
    await db.insert(companyMemberships)
      .values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    const client = await connect({ "x-test-user": userId }, faultyUrl, companyId);
    // First event loads the actor and the agent-visibility scope.
    await settle([client], companyId);

    let fakeNow = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      // Three beats, each a full heartbeat interval of fake wall time — so the
      // actor TTL elapses repeatedly. Without the refresh the cache expires
      // and the settle below costs a re-read every beat.
      for (let beat = 0; beat < 3; beat++) {
        faultySelects = 0;
        fakeNow += HEARTBEAT_MS;
        vi.advanceTimersByTime(HEARTBEAT_MS);
        await heartbeatSettled();
        expect(faultySelects).toBeGreaterThan(0); // the re-check still queries
        faultySelects = 0;
        await settle([client], companyId);
        expect(faultySelects).toBe(0); // but delivering the marker re-reads nothing
        expect(client.isOpen()).toBe(true);
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  // AgentDash (GH #937 review): the heartbeat's refreshed actor must NOT carry
  // the agent-visibility scope forward — the scope is cached on the request
  // object, and its inputs (an owner-only agent created for someone else, an
  // ended stewardship, a flipped visibility flag) are not in the fingerprint
  // and send no access-change signal. The re-check hands the filter a fresh
  // request each beat, so the scope outlives at most one heartbeat — while
  // the actor itself is still never re-read.
  it("re-resolves the agent-visibility scope across heartbeats when an owner-only agent appears out of band", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Scope Refresh Co",
      issuePrefix: `SR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    const memberId = `user-${randomUUID()}`;
    const otherUserId = `user-${randomUUID()}`;
    await db.insert(companyMemberships)
      .values({ companyId, principalType: "user", principalId: memberId, status: "active", membershipRole: "member" });
    const client = await connect({ "x-test-user": memberId }, faultyUrl, companyId);

    const openAgentId = randomUUID();
    await db.insert(agents).values({ id: openAgentId, companyId, name: "Open", role: "general" });
    const statusOf = (agentId: string) =>
      publishLiveEvent({ companyId, type: "agent.status", payload: { agentId } });
    const sawAgent = (agentId: string) => client.events.some((e) => e.payload.agentId === agentId);
    // Once the scope is owner-only, a random-agent marker would itself be
    // filtered out — the barrier is an activity event with no agent, issue,
    // run or project reference, which every subscriber gets. Delivery is
    // serialized per socket, so its arrival decides everything before it.
    const barrier = async () => {
      const marker = randomUUID();
      publishLiveEvent({
        companyId,
        type: "activity.logged",
        payload: { action: "note.added", entityType: "company", entityId: marker },
      });
      const deadline = performance.now() + 5000;
      while (!client.events.some((e) => e.payload.entityId === marker)) {
        if (performance.now() > deadline) throw new Error("barrier not delivered");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    // Populate and cache the scope: no owner-only agents yet, so mode "all".
    statusOf(openAgentId);
    await barrier();
    expect(sawAgent(openAgentId)).toBe(true);

    // Out of band: an owner-only agent for another user. No service call, no
    // access-change signal, no activity event — only a heartbeat can fix the
    // scope.
    const hiddenAgentId = randomUUID();
    await db.insert(agents).values({
      id: hiddenAgentId,
      companyId,
      name: "Other's agent",
      role: "general",
      visibility: "owner",
      accountableUserId: otherUserId,
      createdByUserId: otherUserId,
    });

    let fakeNow = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
    try {
      // Four beats past the actor TTL: the old keep-the-same-request refresh
      // would extend the cached scope forever.
      for (let beat = 0; beat < 4; beat++) {
        fakeNow += HEARTBEAT_MS;
        vi.advanceTimersByTime(HEARTBEAT_MS);
        await heartbeatSettled();
      }

      faultySelects = 0;
      statusOf(hiddenAgentId); // decided, then dropped for the member
      await barrier();
      expect(sawAgent(hiddenAgentId)).toBe(false);
      expect(faultySelects).toBe(0); // scope recompute never re-read the actor
      expect(client.isOpen()).toBe(true);

      // The reverse: the agent becomes company-visible, again out of band —
      // the next heartbeat's fresh scope must start delivering it.
      await db.update(agents).set({ visibility: "company" }).where(eq(agents.id, hiddenAgentId));
      fakeNow += HEARTBEAT_MS;
      vi.advanceTimersByTime(HEARTBEAT_MS);
      await heartbeatSettled();

      faultySelects = 0;
      statusOf(hiddenAgentId);
      await barrier();
      expect(sawAgent(hiddenAgentId)).toBe(true);
      expect(faultySelects).toBe(0);
      expect(client.isOpen()).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // AgentDash (GH #938): revocation only bites if better-auth's session and
  // user deletion actually publish the access change. These tests drive a
  // REAL better-auth instance and a socket resolved from the real session
  // cookie, then revoke through better-auth and assert the socket closes —
  // the heartbeat interval is faked and never advanced, so any close must
  // have come from the hook, not the periodic re-check.
  describe("better-auth session and user deletion revoke the socket", () => {
    const ORIGIN = "http://127.0.0.1:3100";
    let auth!: ReturnType<typeof createBetterAuthInstance>;
    let authApp!: express.Express;
    let authServer: Server | null = null;
    let authUrl = "";
    let savedSecret: string | undefined;

    function sessionCookie(res: request.Response): string {
      const setCookies = res.headers["set-cookie"] as unknown as string[] | string | undefined;
      return [setCookies ?? []].flat()
        .map((cookie) => cookie.split(";")[0] ?? "")
        .filter((pair) => pair.includes("session_token"))
        .join("; ");
    }

    async function signUp(email: string, password = "a-long-enough-password-1") {
      const res = await request(authApp)
        .post("/api/auth/sign-up/email")
        .set("Origin", ORIGIN)
        .send({ email, name: email, password });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const userId = (res.body as { user?: { id?: string } }).user?.id;
      expect(userId).toBeTruthy();
      return { userId: userId!, cookie: sessionCookie(res) };
    }

    async function signIn(email: string, password = "a-long-enough-password-1") {
      const res = await request(authApp)
        .post("/api/auth/sign-in/email")
        .set("Origin", ORIGIN)
        .send({ email, password });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return sessionCookie(res);
    }

    async function connectAuthed(userId: string, cookie: string) {
      await db
        .insert(companyMemberships)
        .values({ companyId: COMPANY, principalType: "user", principalId: userId, status: "active", membershipRole: "member" })
        .onConflictDoNothing();
      return connect({ cookie }, authUrl);
    }

    beforeAll(async () => {
      savedSecret = process.env.BETTER_AUTH_SECRET;
      process.env.BETTER_AUTH_SECRET = "live-events-revocation-test-secret-0123456789abcdef";
      auth = createBetterAuthInstance(
        db,
        {
          authBaseUrlMode: "explicit",
          authPublicBaseUrl: ORIGIN,
          deploymentMode: "authenticated",
        } as Parameters<typeof createBetterAuthInstance>[1],
        [ORIGIN],
      );
      authApp = express();
      authApp.use(express.json());
      authApp.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));

      authServer = createServer();
      setupLiveEventsWebSocketServer(authServer, db, {
        deploymentMode: "authenticated",
        heartbeatIntervalMs: HEARTBEAT_MS,
        resolveSessionFromHeaders: (headers) => resolveBetterAuthSessionFromHeaders(auth, headers),
      });
      await new Promise<void>((resolve) => authServer!.listen(0, "127.0.0.1", resolve));
      authUrl = `ws://127.0.0.1:${(authServer.address() as AddressInfo).port}`;
    }, 180_000);

    afterAll(async () => {
      if (savedSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = savedSecret;
      // Upgraded sockets keep the http server alive for close(); drop the
      // clients first, then force-close anything still tracked.
      for (const client of clients) client.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      (authServer as (Server & { closeAllConnections?: () => void }) | null)?.closeAllConnections?.();
      if (authServer) await new Promise<void>((resolve) => authServer!.close(() => resolve()));
    });

    it("sign-out deletes the session, whose delete hook closes the socket without a heartbeat", async () => {
      const user = await signUp(`signout-${randomUUID()}@example.com`);
      const client = await connectAuthed(user.userId, user.cookie);
      expect(client.isOpen()).toBe(true);

      const res = await request(authApp)
        .post("/api/auth/sign-out")
        .set("Origin", ORIGIN)
        .set("Cookie", user.cookie)
        .send();
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      // No heartbeat is advanced: the close must come from the session.delete
      // database hook publishing the access change.
      expect(await closeCodeWithin(client, 5000)).toBe(1008);
    });

    it("bulk session revocation (deleteMany path) closes every socket the user opened", async () => {
      const email = `revokeall-${randomUUID()}@example.com`;
      const user = await signUp(email);
      const secondCookie = await signIn(email);
      const first = await connectAuthed(user.userId, user.cookie);
      const second = await connectAuthed(user.userId, secondCookie);

      const res = await request(authApp)
        .post("/api/auth/revoke-sessions")
        .set("Origin", ORIGIN)
        .set("Cookie", secondCookie)
        .send();
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      expect(await closeCodeWithin(first, 5000)).toBe(1008);
      expect(await closeCodeWithin(second, 5000)).toBe(1008);
    });

    it("deleting the user through the internal adapter fires the user.delete hook and closes the socket", async () => {
      const user = await signUp(`deleted-${randomUUID()}@example.com`);
      const client = await connectAuthed(user.userId, user.cookie);
      expect(client.isOpen()).toBe(true);

      const seen: LiveEventAccessChange[] = [];
      const unsubscribe = subscribeLiveEventAccessChanges((change) => seen.push(change));
      try {
        // Delete the sessions straight through drizzle first — no hooks — so
        // the socket cannot be closed by a session.delete publish. Only the
        // user.delete hook can still close it.
        await db.delete(authSessions).where(eq(authSessions.userId, user.userId));
        const context = (await auth.$context) as unknown as {
          internalAdapter: { deleteUser: (id: string) => Promise<unknown> };
        };
        await context.internalAdapter.deleteUser(user.userId);

        expect(seen).toContainEqual({ kind: "user", userId: user.userId, reason: "user deleted" });
        expect(await closeCodeWithin(client, 5000)).toBe(1008);
      } finally {
        unsubscribe();
      }
    });
  });
});
