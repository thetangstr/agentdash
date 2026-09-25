import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";
import * as devServerStatus from "../dev-server-status.js";
import { serverVersion } from "../version.js";

const mockReadPersistedDevServerStatus = vi.hoisted(() => vi.fn());

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: mockReadPersistedDevServerStatus,
  toDevServerHealthStatus: vi.fn(),
}));

function createApp(db?: Db) {
  const app = express();
  app.use("/health", healthRoutes(db));
  return app;
}

describe("GET /health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadPersistedDevServerStatus.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("returns 200 with status ok", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  }, 15_000);

  it("returns 200 when the database probe succeeds", async () => {
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      // O4: computeHealthChecks counts stuck runs via select().from().where()
      select: vi.fn(() => ({ from: () => ({ where: () => Promise.resolve([{ count: 0 }]) }) })),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ status: "ok", version: serverVersion });
  });

  it("returns 503 when the database probe fails", async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    } as unknown as Db;
    const app = createApp(db);

    const res = await request(app).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: "unhealthy",
      version: serverVersion,
      error: "database_unreachable"
    });
  });

  it("redacts detailed metadata for anonymous requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      // O4 note: this stub answers EVERY count query with 1, so the health
      // checks see one stuck run and report degraded — which is the correct
      // O4 behavior, and the expectations below say so.
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "degraded",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
      selfServeBootstrap: false,
      instanceHasCompany: true,
      adapterReady: false,
      // "minimax" now: adapter-presets defaults to the same adapter
      // dispatchLLM actually routes to. The two disagreed, so /health
      // named a provider the server would never call.
      adapterPreset: "minimax",
    });
  });

  it("redacts detailed metadata when authenticated mode is reached without auth middleware", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      // O4 note: this stub answers EVERY count query with 1, so the health
      // checks see one stuck run and report degraded — which is the correct
      // O4 behavior, and the expectations below say so.
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "degraded",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
      selfServeBootstrap: false,
      instanceHasCompany: true,
      adapterReady: false,
      // "minimax" now: adapter-presets defaults to the same adapter
      // dispatchLLM actually routes to. The two disagreed, so /health
      // named a provider the server would never call.
      adapterPreset: "minimax",
    });
  });

  it("keeps detailed metadata for authenticated requests in authenticated mode", async () => {
    const devServerStatus = await import("../dev-server-status.js");
    vi.spyOn(devServerStatus, "readPersistedDevServerStatus").mockReturnValue(undefined);
    const { healthRoutes } = await import("../routes/health.js");
    const db = {
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      // O4 note: this stub answers EVERY count query with 1, so the health
      // checks see one stuck run and report degraded — which is the correct
      // O4 behavior, and the expectations below say so.
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    } as unknown as Db;
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "user-1", source: "session" };
      next();
    });
    app.use(
      "/health",
      healthRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authReady: true,
        companyDeletionEnabled: false,
      }),
    );

    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "degraded",
      version: serverVersion,
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      authReady: true,
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
      features: {
        companyDeletionEnabled: false,
      },
    });
  });

  // AgentDash (#726): the runbook and launch run assert the hosted flag
  // without signing in, so it appears on the public response too.
  describe("hostedBox", () => {
    const ORIGINAL_KIND = process.env.AGENTDASH_DEPLOYMENT_KIND;
    afterEach(() => {
      if (ORIGINAL_KIND === undefined) delete process.env.AGENTDASH_DEPLOYMENT_KIND;
      else process.env.AGENTDASH_DEPLOYMENT_KIND = ORIGINAL_KIND;
    });

    it("reports false when the hosted flag is unset", async () => {
      delete process.env.AGENTDASH_DEPLOYMENT_KIND;
      const res = await request(createApp()).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.hostedBox).toBe(false);
    });

    it("reports true on a hosted box, to an unauthenticated caller", async () => {
      process.env.AGENTDASH_DEPLOYMENT_KIND = "hosted";
      const app = express();
      app.use(
        "/health",
        healthRoutes(undefined, {
          deploymentMode: "authenticated",
          deploymentExposure: "public",
          authReady: true,
          companyDeletionEnabled: false,
        }),
      );
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "ok", deploymentMode: "authenticated", hostedBox: true });
    });
  });

  // AgentDash: operators need to tell which build is live on a hosted box
  // without signing in (doc/runbooks/hosted-box.md section 10/12); the
  // release tag comes from the AGENTDASH_RELEASE_TAG Railway variable
  // scripts/hosted/provision-box.sh sets, and is public/non-sensitive.
  describe("releaseTag", () => {
    const ORIGINAL_TAG = process.env.AGENTDASH_RELEASE_TAG;
    afterEach(() => {
      if (ORIGINAL_TAG === undefined) delete process.env.AGENTDASH_RELEASE_TAG;
      else process.env.AGENTDASH_RELEASE_TAG = ORIGINAL_TAG;
    });

    it("is absent when AGENTDASH_RELEASE_TAG is unset, but version is still reported", async () => {
      delete process.env.AGENTDASH_RELEASE_TAG;
      const res = await request(createApp()).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("releaseTag");
      expect(res.body.version).toBe(serverVersion);
    });

    it("reports the release tag on the public (no-db, redacted) response of a hosted box", async () => {
      process.env.AGENTDASH_RELEASE_TAG = "v2026.925.0";
      const app = express();
      app.use(
        "/health",
        healthRoutes(undefined, {
          deploymentMode: "authenticated",
          deploymentExposure: "public",
          authReady: true,
          companyDeletionEnabled: false,
        }),
      );
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "ok", version: serverVersion, releaseTag: "v2026.925.0" });
    });

    it("reports the release tag for anonymous requests with a db (redacted path)", async () => {
      process.env.AGENTDASH_RELEASE_TAG = "v2026.925.0";
      const db = {
        execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ count: 0 }]) })),
        })),
      } as unknown as Db;
      const app = express();
      app.use(
        "/health",
        healthRoutes(db, {
          deploymentMode: "authenticated",
          deploymentExposure: "public",
          authReady: true,
          companyDeletionEnabled: false,
        }),
      );
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ version: serverVersion, releaseTag: "v2026.925.0" });
    });

    it("reports the release tag for authenticated (full-details) requests", async () => {
      process.env.AGENTDASH_RELEASE_TAG = "v2026.925.0";
      const db = {
        execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ count: 0 }]) })),
        })),
      } as unknown as Db;
      const app = express();
      app.use((req, _res, next) => {
        (req as any).actor = { type: "board", userId: "user-1", source: "session" };
        next();
      });
      app.use(
        "/health",
        healthRoutes(db, {
          deploymentMode: "authenticated",
          deploymentExposure: "public",
          authReady: true,
          companyDeletionEnabled: false,
        }),
      );
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ version: serverVersion, releaseTag: "v2026.925.0" });
    });
  });
});
