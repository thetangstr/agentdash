// AgentDash: the cloud-control HTTP app. Public surface in SC-1 is only
// GET /health; the operator surface is /internal/* (see auth.ts).
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import type { CloudConfig } from "./config.js";
import type { CloudDb } from "./db/client.js";
import { type Refusal, requireAdmin, type RequireAdminOptions } from "./auth.js";
import { operatorAudit } from "./db/schema.js";
import type { Logger } from "./logger.js";
import { internalRoutes } from "./routes/internal.js";

export function createApp(opts: {
  db: CloudDb;
  config: CloudConfig;
  log: Logger;
  /** Test hooks for the operator guard (limiter, audit cap, clock). */
  admin?: Omit<RequireAdminOptions, "onRefused">;
}): Express {
  const { db, config, log } = opts;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ status: "ok", service: "cloud-control", release: config.release, db: "ok" });
    } catch (err) {
      log.error("health: database unreachable", { err });
      res.status(503).json({ status: "degraded", service: "cloud-control", release: config.release, db: "down" });
    }
  });

  // Refused operator requests are audited (append-only table, GH #778). No
  // credential is ever part of a Refusal.
  const onRefused = async (r: Refusal) => {
    await db.insert(operatorAudit).values({
      kind: "admin_refused",
      actor: "unauthenticated",
      ip: r.ip,
      detail: { reason: r.reason, socketIp: r.socketIp, method: r.method, path: r.path, failures: r.failures ?? null },
    });
  };
  app.use("/internal", requireAdmin(config, log, { onRefused, ...opts.admin }), internalRoutes(db, log));

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // Errors never echo internals to the caller; the log line is redacted.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    log.error("request failed", { err, path: req.path, method: req.method });
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  });

  return app;
}
