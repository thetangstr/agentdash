// AgentDash: MCP-native signup — POST /api/onboarding/mcp-signup.
//
// The route is UNAUTHENTICATED but hard-gated: authenticated deployment mode,
// AGENTDASH_SELF_SERVE_BOOTSTRAP=true, and a strictly-fresh instance (zero
// instance_admin roles AND zero auth users). On success it creates the
// founding user via the injected Better Auth signUpEmail wrapper, mints a
// board API key (the same hash the Bearer auth middleware looks up), promotes
// the user to instance_admin, and returns the plaintext key exactly once.
// The generated password must never appear in the response.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authUsers, instanceUserRoles } from "@paperclipai/db";

import {
  MCP_SIGNUP_PASSWORD_SETUP_HINT,
  onboardingMcpSignupRoutes,
  type McpSignupCreateUser,
} from "../routes/onboarding-mcp-signup.js";
import { hashBearerToken } from "../services/board-auth.js";
import { errorHandler } from "../middleware/error-handler.js";

// ---------------------------------------------------------------------------
// mocks
// ---------------------------------------------------------------------------

let promoteMock: ReturnType<typeof vi.fn>;
vi.mock("../services/index.js", () => ({
  accessService: () => ({
    promoteFirstInstanceAdmin: (...args: unknown[]) => promoteMock(...args),
  }),
}));

// Marker middleware so we can assert the auth-tier rate limiter is wired in
// front of the handler (in real deployments createAuthRateLimiter enforces
// 10 req / 15 min; under NODE_ENV=test it would no-op, so we mock the factory).
const rateLimiterMiddleware = vi.fn(
  (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
);
vi.mock("../middleware/rate-limit.js", () => ({
  createAuthRateLimiter: vi.fn(() => rateLimiterMiddleware),
}));

import { createAuthRateLimiter } from "../middleware/rate-limit.js";

// ---------------------------------------------------------------------------
// fake db
// ---------------------------------------------------------------------------

interface FakeDbState {
  adminCount: number;
  userCount: number;
  usersByEmail: Array<{ id: string }>;
}

function makeFakeDb(state: FakeDbState) {
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => {
        const countRows =
          table === instanceUserRoles
            ? [{ count: state.adminCount }]
            : table === authUsers
              ? [{ count: state.userCount }]
              : [];
        const whereRows = table === authUsers ? state.usersByEmail : countRows;
        return {
          where: () => Promise.resolve(whereRows),
          // Bare `.from(authUsers)` (no where) is awaited directly for the
          // total-user count — make the chain thenable.
          then: (
            resolve: (rows: unknown[]) => unknown,
            reject?: (err: unknown) => unknown,
          ) => Promise.resolve(countRows).then(resolve, reject),
        };
      },
    })),
    insert: vi.fn(() => ({ values: insertValues })),
  };
  return { db, insertValues };
}

// ---------------------------------------------------------------------------
// app harness
// ---------------------------------------------------------------------------

function buildApp(opts: {
  deploymentMode?: "authenticated" | "local_trusted";
  createUser?: McpSignupCreateUser;
  dbState?: Partial<FakeDbState>;
}) {
  const state: FakeDbState = {
    adminCount: 0,
    userCount: 0,
    usersByEmail: [],
    ...opts.dbState,
  };
  const { db, insertValues } = makeFakeDb(state);
  const app = express();
  app.use(express.json());
  app.use(
    "/api/onboarding",
    onboardingMcpSignupRoutes(db as never, {
      deploymentMode: opts.deploymentMode ?? "authenticated",
      createUser: opts.createUser,
    }),
  );
  app.use(errorHandler);
  return { app, insertValues };
}

const VALID_BODY = { email: "founder@example.com", name: "Founder" };

beforeEach(() => {
  vi.clearAllMocks();
  promoteMock = vi.fn().mockResolvedValue(true);
  process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP = "true";
  // Invite gate off for the pre-existing suites; the invite-gate describe
  // block below flips it on per-test and mocks global fetch.
  process.env.AGENTDASH_INVITE_VALIDATION = "off";
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("POST /api/onboarding/mcp-signup", () => {
  it("happy path: creates the user, mints a working board key, promotes, and never leaks the password", async () => {
    let capturedPassword = "";
    const createUser = vi.fn(async (input: { password: string }) => {
      capturedPassword = input.password;
      return { userId: "user-1" };
    });
    const { app, insertValues } = buildApp({ createUser });

    const res = await request(app).post("/api/onboarding/mcp-signup").send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.userId).toBe("user-1");
    expect(res.body.email).toBe(VALID_BODY.email);
    expect(res.body.name).toBe(VALID_BODY.name);
    expect(res.body.passwordSetup).toBe(MCP_SIGNUP_PASSWORD_SETUP_HINT);
    expect(res.body.passwordSetup).toContain("Forgot password");

    // The signup password is crypto-random (32 bytes hex) and single-use.
    expect(createUser).toHaveBeenCalledWith({
      name: VALID_BODY.name,
      email: VALID_BODY.email,
      password: capturedPassword,
    });
    expect(capturedPassword).toMatch(/^[0-9a-f]{64}$/);
    // Never in the response — not as a field, not embedded in any string.
    expect(JSON.stringify(res.body)).not.toContain(capturedPassword);

    // The returned key is a board bearer token whose sha256 hash is exactly
    // what was persisted — i.e. the same predicate the auth middleware's
    // findBoardApiKeyByToken lookup uses, so it resolves a board actor.
    expect(res.body.apiKey).toMatch(/^pcp_board_[0-9a-f]{48}$/);
    expect(insertValues).toHaveBeenCalledTimes(1);
    const inserted = insertValues.mock.calls[0]![0] as {
      userId: string;
      name: string;
      keyHash: string;
      expiresAt: Date;
    };
    expect(inserted.userId).toBe("user-1");
    expect(inserted.keyHash).toBe(hashBearerToken(res.body.apiKey));
    expect(inserted.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(new Date(res.body.apiKeyExpiresAt).getTime()).toBe(inserted.expiresAt.getTime());

    // Founding user ends up instance admin (the /onboarding/bootstrap path
    // never promotes — see the route header comment).
    expect(promoteMock).toHaveBeenCalledWith("user-1");
  });

  it("founding-only gate: 409 once any auth user exists", async () => {
    const createUser = vi.fn();
    const { app, insertValues } = buildApp({
      createUser: createUser as never,
      dbState: { userCount: 1 },
    });

    const res = await request(app).post("/api/onboarding/mcp-signup").send(VALID_BODY);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("instance_already_claimed");
    expect(createUser).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("founding-only gate: 409 once an instance_admin exists (even with users somehow zero)", async () => {
    const createUser = vi.fn();
    const { app } = buildApp({
      createUser: createUser as never,
      dbState: { adminCount: 1 },
    });

    const res = await request(app).post("/api/onboarding/mcp-signup").send(VALID_BODY);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("instance_already_claimed");
    expect(createUser).not.toHaveBeenCalled();
  });

  it("authenticated-mode gate: 403 in local_trusted deployments", async () => {
    const { app } = buildApp({
      deploymentMode: "local_trusted",
      createUser: vi.fn() as never,
    });

    const res = await request(app).post("/api/onboarding/mcp-signup").send(VALID_BODY);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("mcp_signup_requires_authenticated_mode");
  });

  it("self-serve-bootstrap gate: 403 when AGENTDASH_SELF_SERVE_BOOTSTRAP is not true", async () => {
    delete process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP;
    const { app } = buildApp({ createUser: vi.fn() as never });

    const res = await request(app).post("/api/onboarding/mcp-signup").send(VALID_BODY);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("self_serve_bootstrap_disabled");
  });

  it("503 auth_not_ready when no createUser dependency is wired (buildApp backward-compat)", async () => {
    const { app } = buildApp({});

    const res = await request(app).post("/api/onboarding/mcp-signup").send(VALID_BODY);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("auth_not_ready");
  });

  it("validates the body: 400 invalid_body for a bad email or missing name", async () => {
    const { app } = buildApp({ createUser: vi.fn() as never });

    const badEmail = await request(app)
      .post("/api/onboarding/mcp-signup")
      .send({ email: "not-an-email", name: "Founder" });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.code).toBe("invalid_body");

    const missingName = await request(app)
      .post("/api/onboarding/mcp-signup")
      .send({ email: "founder@example.com", name: "" });
    expect(missingName.status).toBe(400);
    expect(missingName.body.code).toBe("invalid_body");
  });

  it("400 signup_failed (no key minted) when the auth layer rejects the sign-up", async () => {
    const createUser = vi.fn().mockRejectedValue(new Error("email already registered"));
    const { app, insertValues } = buildApp({ createUser });

    const res = await request(app).post("/api/onboarding/mcp-signup").send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("signup_failed");
    expect(insertValues).not.toHaveBeenCalled();
    expect(promoteMock).not.toHaveBeenCalled();
  });

  it("wires the auth-tier rate limiter in front of the handler", async () => {
    const { app } = buildApp({ createUser: vi.fn(async () => ({ userId: "user-1" })) });

    expect(createAuthRateLimiter).toHaveBeenCalledWith({ deploymentMode: "authenticated" });

    rateLimiterMiddleware.mockClear();
    await request(app).post("/api/onboarding/mcp-signup").send(VALID_BODY);
    expect(rateLimiterMiddleware).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// invite-code funnel gate
// ---------------------------------------------------------------------------

describe("POST /api/onboarding/mcp-signup — invite-code gate", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    delete process.env.AGENTDASH_INVITE_VALIDATION; // gate ON (default)
    process.env.AGENTDASH_INVITE_VALIDATION_URL = "https://validator.test/api/invites/validate";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENTDASH_INVITE_VALIDATION_URL;
  });

  function appWithCreate() {
    const createUser = vi.fn(async () => ({ userId: "user-1" }));
    return { ...buildApp({ createUser }), createUser };
  }

  it("403 invite_code_required when the gate is on and no code is sent", async () => {
    const { app, createUser } = appWithCreate();
    const res = await request(app).post("/api/onboarding/mcp-signup").send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("invite_code_required");
    expect(createUser).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403 invalid_invite_code when the validator says valid:false", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ valid: false }), { status: 200 }));
    const { app, createUser } = appWithCreate();
    const res = await request(app)
      .post("/api/onboarding/mcp-signup")
      .send({ ...VALID_BODY, inviteCode: "WRONG-CODE" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("invalid_invite_code");
    expect(createUser).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://validator.test/api/invites/validate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("proceeds to signup when the validator says valid:true", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ valid: true }), { status: 200 }));
    const { app } = appWithCreate();
    const res = await request(app)
      .post("/api/onboarding/mcp-signup")
      .send({ ...VALID_BODY, inviteCode: "GOOD-CODE" });
    expect(res.status).toBe(201);
    expect(res.body.apiKey).toMatch(/^pcp_board_/);
    const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(sentBody).toEqual({ code: "GOOD-CODE" });
  });

  it("503 invite_validation_unavailable (fail-closed) when the validator is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const { app, createUser } = appWithCreate();
    const res = await request(app)
      .post("/api/onboarding/mcp-signup")
      .send({ ...VALID_BODY, inviteCode: "GOOD-CODE" });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("invite_validation_unavailable");
    expect(createUser).not.toHaveBeenCalled();
  });

  it("AGENTDASH_INVITE_VALIDATION=off bypasses the gate entirely", async () => {
    process.env.AGENTDASH_INVITE_VALIDATION = "off";
    const { app } = appWithCreate();
    const res = await request(app).post("/api/onboarding/mcp-signup").send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
