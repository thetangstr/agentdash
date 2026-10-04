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

const mockServedRelease = vi.hoisted(() => vi.fn());
const mockBoxClaimedCached = vi.hoisted(() => vi.fn());
const mockInstanceHasUsers = vi.hoisted(() => vi.fn());

vi.mock("../lib/claim-code.js", () => ({
  boxClaimedCached: mockBoxClaimedCached,
  instanceHasUsers: mockInstanceHasUsers,
}));

vi.mock("../lib/served-release.js", () => ({
  servedRelease: mockServedRelease,
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
    mockServedRelease.mockReturnValue(null);
    mockBoxClaimedCached.mockResolvedValue(true);
    mockInstanceHasUsers.mockResolvedValue(false);
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
  // AgentDash (#547): the canonical origin is reported; the rest of the
  // declared set (LAN and tailnet doors) is not.
  describe("canonicalOrigin", () => {
    const KEYS = ["PAPERCLIP_CANONICAL_ORIGIN", "PAPERCLIP_ORIGINS", "PAPERCLIP_PUBLIC_URL", "PAPERCLIP_AUTH_PUBLIC_BASE_URL"];
    const saved = new Map<string, string | undefined>();
    beforeEach(() => {
      for (const key of KEYS) {
        saved.set(key, process.env[key]);
        delete process.env[key];
      }
    });
    afterEach(() => {
      for (const key of KEYS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const stubDb = () => ({
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    }) as unknown as Db;

    it("is absent when nothing is configured", async () => {
      const res = await request(createApp(stubDb())).get("/health");
      expect(res.body).not.toHaveProperty("canonicalOrigin");
      expect(res.body).not.toHaveProperty("publicBaseUrl");
    });

    it("reports the declared canonical to an anonymous caller, without the other declared doors", async () => {
      process.env.PAPERCLIP_CANONICAL_ORIGIN = "https://agents.example.test";
      process.env.PAPERCLIP_ORIGINS = "https://agents.example.test,http://10.0.0.20:3102";
      process.env.PAPERCLIP_PUBLIC_URL = "http://10.0.0.20:3102";
      const app = express();
      app.use((req, _res, next) => {
        (req as any).actor = { type: "none", source: "none" };
        next();
      });
      app.use("/health", healthRoutes(stubDb(), {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        authReady: true,
        companyDeletionEnabled: false,
      }));

      const res = await request(app).get("/health");

      expect(res.body.canonicalOrigin).toBe("https://agents.example.test");
      expect(res.body.publicBaseUrl).toBe("https://agents.example.test");
      expect(JSON.stringify(res.body)).not.toContain("10.0.0.20");
    });

    it("reports the old public URL's origin when no origin is declared", async () => {
      process.env.PAPERCLIP_PUBLIC_URL = "http://office.example.test:3102/";
      const res = await request(createApp(stubDb())).get("/health");
      expect(res.body.canonicalOrigin).toBe("http://office.example.test:3102");
      expect(res.body.originsMode).toBe("legacy");
    });
  });

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

  // AgentDash (scan 3 lane L): `claimed` used to be on the public shape only,
  // so a signed-in caller of a hosted box could not see it at all.
  describe("claimed", () => {
    const ORIGINAL_KIND = process.env.AGENTDASH_DEPLOYMENT_KIND;
    afterEach(() => {
      if (ORIGINAL_KIND === undefined) delete process.env.AGENTDASH_DEPLOYMENT_KIND;
      else process.env.AGENTDASH_DEPLOYMENT_KIND = ORIGINAL_KIND;
    });

    const stubDb = () => ({
      execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ count: 1 }]),
        })),
      })),
    }) as unknown as Db;

    function hostedApp(actorType: "none" | "board") {
      const app = express();
      app.use((req, _res, next) => {
        (req as any).actor = { type: actorType, source: actorType === "board" ? "session" : "none" };
        next();
      });
      app.use(
        "/health",
        healthRoutes(stubDb(), {
          deploymentMode: "authenticated",
          deploymentExposure: "public",
          authReady: true,
          companyDeletionEnabled: false,
        }),
      );
      return app;
    }

    it("reports claimed to an anonymous caller of a hosted box", async () => {
      process.env.AGENTDASH_DEPLOYMENT_KIND = "hosted";
      const res = await request(hostedApp("none")).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("db");
      expect(res.body.claimed).toBe(true);
    });

    it("reports claimed to a signed-in caller of a hosted box too", async () => {
      process.env.AGENTDASH_DEPLOYMENT_KIND = "hosted";
      mockBoxClaimedCached.mockResolvedValue(false);
      const res = await request(hostedApp("board")).get("/health");
      expect(res.status).toBe(200);
      // The full-detail shape, so this is the authenticated branch.
      expect(res.body).toHaveProperty("db");
      expect(res.body.claimed).toBe(false);
    });

    it("omits claimed on an install that is not a hosted box", async () => {
      delete process.env.AGENTDASH_DEPLOYMENT_KIND;
      const res = await request(hostedApp("board")).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("claimed");
      expect(mockBoxClaimedCached).not.toHaveBeenCalled();
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

  // AgentDash: ota-apply.mjs waits for the served release's commit to match
  // the release it switched to (the served-release check), so it must be on
  // every response shape, including the redacted one.
  describe("releaseCommit", () => {
    const COMMIT = "4637abd727dfe98b4865bec30a39cd772c484749";

    it("is absent outside a release layout", async () => {
      const res = await request(createApp()).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("releaseCommit");
    });

    it("reports the served release's commit on the public (redacted) response", async () => {
      mockServedRelease.mockReturnValue({ tag: "v2026.930.0", commit: COMMIT });
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
      expect(res.body).toMatchObject({ status: "ok", version: serverVersion, releaseCommit: COMMIT });
    });

    it("reports the served release's commit on the full-details response with a db", async () => {
      mockServedRelease.mockReturnValue({ tag: "v2026.930.0", commit: COMMIT });
      const db = {
        execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
        select: vi.fn(() => ({
          from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([{ count: 0 }]) })),
        })),
      } as unknown as Db;
      const res = await request(createApp(db)).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ version: serverVersion, releaseCommit: COMMIT });
    });
  });
});
