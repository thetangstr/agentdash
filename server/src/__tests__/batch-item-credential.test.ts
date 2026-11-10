import express, { type Request } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { currentBatchActivityContext } from "../lib/batch-activity-context.js";
import {
  batchItemBodyDigest,
  batchItemCredentialCount,
  canonicalJson,
  consumeBatchItemCredential,
  mintBatchItemCredential,
  resetBatchItemCredentials,
  type BatchItemIdentity,
} from "../services/batch/item-credential.js";

/**
 * AgentDash admin powers, part 2: the `pcbx_` batch item credential and its
 * two narrow exemptions (CSRF guard, default API rate limiter), each tested
 * both ways: exempt for `verifiedCredential.kind === "batch_item"`, not exempt
 * for any other kind.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const USER = "user-batch-1";

/** A db that fails the test if anything reads a credential table. */
const untouchableDb = new Proxy({}, {
  get(_target, prop) {
    if (prop === "then") return undefined;
    throw new Error(`credential tables must not be read (db.${String(prop)})`);
  },
}) as unknown as Db;

function identity(overrides: Partial<BatchItemIdentity> = {}): BatchItemIdentity {
  return {
    batchId: "batch-1",
    itemId: "item-1",
    companyId: COMPANY,
    origin: "ui",
    credential: { kind: "session", sessionId: "session-1", userId: USER },
    actor: {
      type: "board",
      userId: USER,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [COMPANY],
      memberships: [{ companyId: COMPANY, membershipRole: "member", status: "active" }],
    },
    binding: { method: "PATCH", path: "/api/issues/abc", bodyDigest: batchItemBodyDigest({ status: "done" }) },
    ...overrides,
  };
}

function appWithAuth() {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(untouchableDb, { deploymentMode: "authenticated", resolveSession: async () => null }));
  app.all("/api/{*rest}", (req, res) => {
    res.json({
      actor: req.actor,
      credential: req.verifiedCredential ?? null,
      batchContext: currentBatchActivityContext(),
    });
  });
  return app;
}

afterEach(() => {
  resetBatchItemCredentials();
  vi.useRealTimers();
});

describe("batch item credential registry", () => {
  it("is single use, expires after 30 seconds, and a forged token resolves to nothing", () => {
    const token = mintBatchItemCredential(identity());
    expect(token.startsWith("pcbx_")).toBe(true);
    expect(consumeBatchItemCredential(token)?.itemId).toBe("item-1");
    expect(consumeBatchItemCredential(token)).toBeNull();
    expect(consumeBatchItemCredential(`pcbx_${"A".repeat(43)}`)).toBeNull();

    vi.useFakeTimers();
    const late = mintBatchItemCredential(identity());
    vi.advanceTimersByTime(30_001);
    expect(consumeBatchItemCredential(late)).toBeNull();
    expect(batchItemCredentialCount()).toBe(0);
  });

  it("hands back a frozen copy of the actor", () => {
    const original = identity();
    const token = mintBatchItemCredential(original);
    original.actor.memberships![0]!.membershipRole = "owner";
    const resolved = consumeBatchItemCredential(token)!;
    expect(resolved.actor.memberships![0]!.membershipRole).toBe("member");
    expect(Object.isFrozen(resolved.actor)).toBe(true);
  });

  it("digests bodies canonically (key order does not matter, values do)", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: null } })).toBe('{"a":{"c":null,"d":[1,2]},"b":1}');
    expect(batchItemBodyDigest({ a: 1, b: 2 })).toBe(batchItemBodyDigest({ b: 2, a: 1 }));
    expect(batchItemBodyDigest({ a: 1 })).not.toBe(batchItemBodyDigest({ a: 2 }));
  });
});

describe("auth middleware pcbx_ branch", () => {
  it("resolves to the confirming person for exactly the bound request, with the batch activity context", async () => {
    const token = mintBatchItemCredential(identity());
    const res = await request(appWithAuth()).patch("/api/issues/abc").set("authorization", `Bearer ${token}`).send({ status: "done" });
    expect(res.status).toBe(200);
    expect(res.body.actor).toMatchObject({ type: "board", userId: USER, source: "session", companyIds: [COMPANY] });
    expect(res.body.credential).toEqual({
      kind: "batch_item", batchId: "batch-1", itemId: "item-1", companyId: COMPANY,
      origin: { kind: "session", sessionId: "session-1", userId: USER },
    });
    expect(res.body.batchContext).toEqual({ batchId: "batch-1", itemId: "item-1", companyId: COMPANY, origin: "ui" });

    const again = await request(appWithAuth()).patch("/api/issues/abc").set("authorization", `Bearer ${token}`).send({ status: "done" });
    expect(again.status).toBe(200);
    expect(again.body.actor).toEqual({ type: "none", source: "none" });
    expect(again.body.credential).toBeNull();
  });

  it.each([
    ["another path", "patch", "/api/issues/other", { status: "done" }],
    ["another method", "post", "/api/issues/abc", { status: "done" }],
    ["another body", "patch", "/api/issues/abc", { status: "cancelled" }],
    ["an extra field", "patch", "/api/issues/abc", { status: "done", assigneeAgentId: "x" }],
    ["a query string", "patch", "/api/issues/abc?force=1", { status: "done" }],
  ] as const)("refuses %s with 403 and spends the token", async (_label, method, path, body) => {
    const token = mintBatchItemCredential(identity());
    const res = await request(appWithAuth())[method](path).set("authorization", `Bearer ${token}`).send(body);
    expect(res.status).toBe(403);
    expect(consumeBatchItemCredential(token)).toBeNull();
  });

  it("a forged pcbx_ token leaves the request unauthenticated without reading any credential table", async () => {
    const res = await request(appWithAuth()).patch("/api/issues/abc").set("authorization", `Bearer pcbx_${"Z".repeat(43)}`).send({ status: "done" });
    expect(res.status).toBe(200);
    expect(res.body.actor).toEqual({ type: "none", source: "none" });
  });
});

describe("CSRF guard exemption", () => {
  function guarded(credential: Request["verifiedCredential"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: USER, source: "session", companyIds: [COMPANY] };
      req.verifiedCredential = credential;
      next();
    });
    app.use(boardMutationGuard());
    app.patch("/api/thing", (_req, res) => { res.json({ ok: true }); });
    return app;
  }

  it("lets a batch item (no Origin, loopback) through", async () => {
    const res = await request(guarded({ kind: "batch_item", batchId: "b", itemId: "i", companyId: COMPANY, origin: { kind: "session", sessionId: "s", userId: USER } }))
      .patch("/api/thing").send({});
    expect(res.status).toBe(200);
  });

  it.each([
    ["no credential", undefined],
    ["a session", { kind: "session", sessionId: "s", userId: USER }],
    ["an agent JWT", { kind: "agent_jwt", expiresAt: 0, agentId: "a", companyId: COMPANY, signedRunId: "r" }],
    ["an assistant credential", { kind: "assistant", origin: { kind: "internal" } }],
  ] as const)("still refuses a session actor without a trusted Origin carrying %s", async (_label, credential) => {
    const res = await request(guarded(credential as Request["verifiedCredential"])).patch("/api/thing").send({});
    expect(res.status).toBe(403);
  });
});

describe("default API rate limiter exemption", () => {
  async function limitedApp(credentialKind: string | null) {
    const saved = { NODE_ENV: process.env.NODE_ENV, MAX: process.env.AGENTDASH_RATE_LIMIT_API_MAX, OFF: process.env.AGENTDASH_RATE_LIMIT_DISABLED };
    process.env.NODE_ENV = "production";
    process.env.AGENTDASH_RATE_LIMIT_API_MAX = "2";
    delete process.env.AGENTDASH_RATE_LIMIT_DISABLED;
    vi.resetModules();
    const { createDefaultApiRateLimiter } = await import("../middleware/rate-limit.js");
    const limiter = createDefaultApiRateLimiter({ deploymentMode: "authenticated" });
    for (const [key, value] of [["NODE_ENV", saved.NODE_ENV], ["AGENTDASH_RATE_LIMIT_API_MAX", saved.MAX], ["AGENTDASH_RATE_LIMIT_DISABLED", saved.OFF]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: USER, source: "session" };
      req.verifiedCredential = credentialKind === "batch_item"
        ? { kind: "batch_item", batchId: "b", itemId: "i", companyId: COMPANY, origin: { kind: "local_implicit" } }
        : credentialKind === "session" ? { kind: "session", sessionId: "s", userId: USER } : undefined;
      next();
    });
    app.use(limiter);
    app.post("/api/thing", (_req, res) => { res.json({ ok: true }); });
    return app;
  }

  it("does not count batch items against the person's mutation window", async () => {
    const app = await limitedApp("batch_item");
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await request(app).post("/api/thing")).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
  });

  it.each(["session", null])("still limits mutations carrying %s", async (kind) => {
    const app = await limitedApp(kind);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await request(app).post("/api/thing")).status);
    expect(statuses).toEqual([200, 200, 429, 429]);
  });
});
