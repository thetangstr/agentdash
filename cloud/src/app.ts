// AgentDash: the cloud-control HTTP app. Public surface in SC-1 is only
// GET /health; the operator surface is /internal/* (see auth.ts).
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import type { CloudConfig } from "./config.js";
import type { CloudDb } from "./db/client.js";
import { requireAdmin } from "./auth.js";
import type { Logger } from "./logger.js";
import { internalRoutes } from "./routes/internal.js";

export function createApp(opts: { db: CloudDb; config: CloudConfig; log: Logger }): Express {
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

  app.use("/internal", requireAdmin(config, log), internalRoutes(db, log));

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
