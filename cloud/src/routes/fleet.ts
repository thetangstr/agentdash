// AgentDash: the operator surface for fleet upgrades and box purpose
// (SC-12 GH #773, GH #861). Mounted inside /internal, so it sits behind the
// same IP allow-list and admin bearer as every other operator route.
import { Router, type Request, type Response, type Router as ExpressRouter } from "express";
import type { CloudDb } from "../db/client.js";
import { BOX_PURPOSES, type BoxPurpose } from "../db/schema.js";
import type { Logger } from "../logger.js";
import {
  cancelRollout,
  pauseRollout,
  type ReleaseResolverDeps,
  resumeRollout,
  RolloutError,
  rolloutStatus,
  setHold,
  setPurpose,
  startRollout,
  tickRollout,
  upgradeOneBox,
} from "../jobs/rollout.js";

const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const RELEASE_RE = /^v\d{4}\.\d{3,4}\.\d+$/;
const ACTOR = "admin-cli";

export function isBoxPurpose(v: unknown): v is BoxPurpose {
  return typeof v === "string" && (BOX_PURPOSES as readonly string[]).includes(v);
}

export function fleetRoutes(db: CloudDb, log: Logger, deps: ReleaseResolverDeps): ExpressRouter {
  const router = Router();
  const handle = (label: string, fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      const result = await fn(req);
      log.info(`fleet ${label}`, { result: result as Record<string, unknown> });
      res.json(result);
    } catch (err) {
      if (err instanceof RolloutError) return void res.status(err.status).json({ error: err.message });
      throw err;
    }
  };
  const slugOf = (req: Request) => {
    const slug = String(req.params.slug);
    if (!SLUG_RE.test(slug)) throw new RolloutError("not a box slug", 400);
    return slug;
  };

  router.get("/rollout", handle("status", () => rolloutStatus(db)));
  router.post(
    "/rollout/start",
    handle("rollout start", (req) => startRollout(db, deps, { actor: ACTOR, now: (req.body ?? {}).now === true })),
  );
  router.post(
    "/rollout/pause",
    handle("rollout pause", (req) => {
      const reason = typeof (req.body ?? {}).reason === "string" ? String(req.body.reason).slice(0, 300) : undefined;
      return pauseRollout(db, ACTOR, reason);
    }),
  );
  router.post("/rollout/resume", handle("rollout resume", () => resumeRollout(db, ACTOR)));
  router.post("/rollout/cancel", handle("rollout cancel", () => cancelRollout(db, ACTOR)));
  // Run one orchestrator pass now instead of waiting for the minute timer.
  router.post("/rollout/tick", handle("rollout tick", () => tickRollout(db, { log })));

  router.post(
    "/boxes/:slug/upgrade",
    handle("box upgrade", (req) => {
      const { releaseTag, now } = (req.body ?? {}) as { releaseTag?: unknown; now?: unknown };
      if (releaseTag !== undefined && releaseTag !== null && (typeof releaseTag !== "string" || !RELEASE_RE.test(releaseTag))) {
        throw new RolloutError("releaseTag must look like v2026.925.0", 400);
      }
      return upgradeOneBox(db, deps, { slug: slugOf(req), releaseTag: (releaseTag as string | undefined) ?? null, now: now === true }, ACTOR);
    }),
  );
  router.post("/boxes/:slug/hold", handle("box hold", (req) => setHold(db, slugOf(req), true, ACTOR)));
  router.post("/boxes/:slug/unhold", handle("box unhold", (req) => setHold(db, slugOf(req), false, ACTOR)));
  router.post(
    "/boxes/:slug/purpose",
    handle("box purpose", (req) => {
      const purpose = (req.body ?? {}).purpose;
      if (!isBoxPurpose(purpose)) throw new RolloutError(`purpose must be one of ${BOX_PURPOSES.join(", ")}`, 400);
      return setPurpose(db, slugOf(req), purpose, ACTOR);
    }),
  );
  return router;
}
