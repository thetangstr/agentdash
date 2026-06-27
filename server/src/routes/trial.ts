// AgentDash (Test Drive): PUBLIC, token-based anonymous trial routes (Slice 1).
//
// These routes are intentionally UNAUTHENTICATED — they do NOT read req.actor or
// assert board/company access. The trial token is the only credential, validated
// by trialService itself. Mounted under /api/trial in app.ts.
//
// The global default-tier API rate limiter (createDefaultApiRateLimiter) already
// covers everything under /api, including these routes, providing the per-IP
// abuse bound the spec calls for (§9). No per-route limiter is added here to keep
// the happy path fast; tighten later if abuse signals appear.
//
// Draft-only: nothing here performs a real-world side effect.
//
// See docs/superpowers/specs/2026-06-27-test-drive-no-signup-trial.md (§9, §10, §11).

import { createHash } from "node:crypto";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { trialService } from "../services/trial.js";
import { assertBoard } from "./authz.js";
import { badRequest } from "../errors.js";

/**
 * Hash the client IP for abuse metering. We never store the raw IP. A static
 * salt (AGENTDASH_TRIAL_IP_SALT) makes the hash non-reversible across installs.
 */
function hashClientIp(req: Request): string | undefined {
  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    "";
  if (!ip) return undefined;
  const salt = process.env.AGENTDASH_TRIAL_IP_SALT ?? "agentdash-trial";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

export function trialRoutes(db: Db) {
  const router = Router();
  const svc = trialService(db);

  // POST /api/trial/session — mint a fresh anonymous trial workspace + agent.
  router.post("/session", async (req, res) => {
    const ipHash = hashClientIp(req);
    const session = await svc.createSession({ ipHash });
    res.status(201).json({
      token: session.token,
      expiresAt: session.expiresAt,
      creditCents: session.creditCents,
    });
  });

  // GET /api/trial/:token — session snapshot + its artifacts.
  router.get("/:token", async (req, res) => {
    const result = await svc.getSession(req.params.token);
    if (!result) {
      res.status(404).json({ error: "Trial session not found", details: { code: "trial_not_found" } });
      return;
    }
    const { session, artifacts } = result;
    res.json({
      session: {
        creditCents: session.creditCents,
        spentCents: session.spentCents,
        creditRemainingCents: session.creditRemainingCents,
        expiresAt: session.expiresAt,
      },
      artifacts,
    });
  });

  // POST /api/trial/:token/run — run a curated hero task draft-only.
  // 402 credit exhausted · 410 expired · 404 bad token · 400 bad useCase/input.
  router.post("/:token/run", async (req, res) => {
    const body = (req.body ?? {}) as { useCase?: unknown; input?: unknown };
    const useCase = typeof body.useCase === "string" ? body.useCase : "";
    // trialService.runTask throws typed HttpErrors mapped by the error handler.
    const result = await svc.runTask(req.params.token, { useCase, input: body.input });
    res.status(201).json({
      artifact: result.artifact,
      creditRemainingCents: result.creditRemainingCents,
      spentCents: result.spentCents,
      creditCents: result.creditCents,
    });
  });

  // -------------------------------------------------------------------------
  // Slice 3 — Share loop (PUBLIC, token-based)
  // -------------------------------------------------------------------------

  // GET /api/trial/share/:shareToken — PUBLIC, read-only shared artifact.
  // No trial token, no auth. 404 when the share token is unknown. Registered
  // before /:token so the two-segment path can never be shadowed.
  router.get("/share/:shareToken", async (req, res) => {
    const shared = await svc.getSharedArtifact(req.params.shareToken);
    if (!shared) {
      res
        .status(404)
        .json({ error: "Shared artifact not found", details: { code: "share_not_found" } });
      return;
    }
    res.json(shared);
  });

  // POST /api/trial/:token/artifacts/:artifactId/share — mint/return the public
  // share token for one of the trial's artifacts. PUBLIC (trial token only).
  router.post("/:token/artifacts/:artifactId/share", async (req, res) => {
    const result = await svc.shareArtifact(req.params.token, req.params.artifactId);
    res.status(201).json({ shareUrl: result.shareUrl, shareToken: result.shareToken });
  });

  // -------------------------------------------------------------------------
  // Slice 4 — Claim on signup (AUTHENTICATED)
  // -------------------------------------------------------------------------

  // POST /api/trial/:token/claim — bind the trial workspace to the logged-in
  // user. Requires a board actor with a userId. Security: whoever holds the
  // trial token AND is signed in can claim, unless someone else already did
  // (then 409). Idempotent for the same user.
  router.post("/:token/claim", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.type === "board" ? req.actor.userId : undefined;
    if (!userId) {
      throw badRequest("A signed-in user is required to claim a trial", {
        code: "missing_user_id",
      });
    }
    const result = await svc.claimSession(req.params.token, userId);
    res.status(200).json({ companyId: result.companyId, companyPrefix: result.companyPrefix });
  });

  return router;
}
