import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assistantDigestService } from "../services/assistant-digest.js";
import { assistantOAuthService } from "../services/assistant-oauth.js";
import { waitingOnYouService } from "../services/waiting-on-you.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * AgentDash assistant MCP (M1, GH #676): the HTTP surface the assistant
 * toolset wraps. Board actors only — the assistant acts for a person, and an
 * agent key reaching these routes would read another human's digest.
 *
 * Both routes are read-only projections; every write an assistant can ever
 * take goes through the existing approval-decision routes with the person's
 * authority re-resolved there (M3/M4).
 */

/**
 * `since` must be an ISO 8601 date or datetime. `new Date` alone is not a
 * validator — it accepts bare numerals like "1" and locale strings, so the
 * shape is pinned before parsing.
 */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;

function parseSince(raw: string | undefined): { since: Date } | { error: string } {
  if (raw === undefined) return { since: new Date(Date.now() - 24 * 60 * 60 * 1000) };
  if (!ISO_8601.test(raw.trim())) {
    return { error: "since must be an ISO 8601 timestamp" };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { error: "since must be an ISO 8601 timestamp" };
  }
  return { since: parsed };
}

export function assistantRoutes(db: Db) {
  const router = Router();
  const digest = assistantDigestService(db);
  const waitingOnYou = waitingOnYouService(db);

  router.get("/companies/:companyId/assistant/digest", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const parsed = parseSince(req.query.since as string | undefined);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const projectId = (req.query.projectId as string | undefined) ?? null;
    res.json(
      await digest.digest({
        companyId,
        userId: req.actor.userId ?? null,
        since: parsed.since,
        projectId,
      }),
    );
  });

  /**
   * What is waiting on this person: approvals with `canDecide`, plus open
   * issues assigned to them. AgentDash: UX-3 (#784) — the definition lives in
   * services/waiting-on-you.ts so the web Home and the assistant's
   * list_pending_decisions read the same thing from this same route.
   */
  router.get("/companies/:companyId/assistant/pending-decisions", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await waitingOnYou.list(companyId, req.actor as never));
  });

  /**
   * GH #677 — My Agent → Connections: the OAuth grants this person has given
   * assistant clients in this company. Same `me/` shape as bridge endpoints:
   * a person lists and revokes their own connections, never someone else's.
   */
  const oauth = assistantOAuthService(db);

  router.get("/companies/:companyId/me/assistant-grants", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const grants = await oauth.listGrantsForUser(companyId, req.actor.userId!);
    res.json({
      grants: grants.map((grant) => ({
        id: grant.id,
        clientId: grant.clientId,
        clientName: grant.clientName,
        redirectHost: grant.redirectHost,
        scopes: grant.scopes,
        createdAt: grant.createdAt?.toISOString?.() ?? null,
        lastUsedAt: grant.lastUsedAt?.toISOString?.() ?? null,
      })),
    });
  });

  router.post("/companies/:companyId/me/assistant-grants/:grantId/revoke", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const revoked = await oauth.revokeGrant(
      req.params.grantId as string,
      req.actor.userId!,
      companyId,
    );
    if (!revoked) {
      res.status(404).json({ error: "Assistant connection not found" });
      return;
    }
    res.json({ revoked: true, grantId: revoked.id });
  });

  return router;
}
