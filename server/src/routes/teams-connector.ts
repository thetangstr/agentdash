import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { humanChannelService } from "../services/human-channels.js";
import {
  parseTeamsPairingToken,
  teamsConnectorService,
  type TeamsVerifiedActor,
} from "../services/teams-connector.js";

export interface TeamsRouteOptions {
  /**
   * Validates the inbound Bot Framework bearer token and returns the Entra
   * identity, or null to reject.
   *
   * Injected rather than global so the test harness supplies its own validator
   * explicitly — there is no `skipAuth` flag that could be left enabled in a
   * real deployment.
   */
  verifyActivity?: (req: Request) => Promise<TeamsVerifiedActor | null>;
}

/**
 * Default validator — DELIBERATELY REJECTS EVERYTHING.
 *
 * CORRECTION (2026-07-31): an earlier version of this comment claimed the SDK
 * "exports no standalone validator". That is wrong. `ServiceTokenValidator`
 * exists at `@microsoft/teams.apps/dist/middleware/`, is standalone, pins the
 * issuer, and binds `serviceUrl`. It is simply not re-exported from the package
 * root, so reaching it means a deep import into `dist/` — unsupported, and
 * working only because the package ships no `exports` map.
 *
 * So the validator was never the blocker. The blocker is upstream: Microsoft
 * deprecated multi-tenant bot creation after 2025-07-31, this project has no
 * grandfathered registration, and the single-tenant path appears to require
 * AppSource/Teams Store publication to reach other tenants. That is a
 * go-to-market decision, not an engineering one, and it is unresolved.
 *
 * Until that wiring lands this endpoint accepts nothing in production. That is
 * the correct failure direction — an unauthenticated bot endpoint that decided
 * approvals would be far worse than one that is switched off — but it does mean
 * the Teams inbound path is incomplete, not merely unconfigured.
 */
function defaultVerifyActivity(): (req: Request) => Promise<TeamsVerifiedActor | null> {
  return async () => {
    logger.warn(
      "teams inbound activity rejected: SDK App/ExpressAdapter validation is not wired yet",
    );
    return null;
  };
}

/**
 * Microsoft Teams bot endpoint.
 *
 * Like Telegram, the caller is the provider rather than a board user, so
 * authenticity comes from the validated activity token and every decision is
 * re-resolved against current state.
 */
export function teamsConnectorRoutes(db: Db, options: TeamsRouteOptions = {}) {
  const router = Router();
  const teams = teamsConnectorService(db);
  const channels = humanChannelService(db);
  const verifyActivity = options.verifyActivity ?? defaultVerifyActivity();

  router.post("/connectors/teams/messages", async (req, res) => {
    const actor = await verifyActivity(req);
    if (!actor) {
      res.status(401).json({ error: "Invalid Teams activity" });
      return;
    }

    const activity = (req.body ?? {}) as Record<string, unknown>;
    const activityId = typeof activity.id === "string" ? activity.id : null;
    if (!activityId) {
      res.status(200).json({ status: 200 });
      return;
    }

    const serviceUrl = typeof activity.serviceUrl === "string" ? activity.serviceUrl : null;
    const conversation = activity.conversation as { id?: unknown } | undefined;
    const conversationId = typeof conversation?.id === "string" ? conversation.id : null;

    // A pairing message arrives BEFORE any binding exists, so it cannot resolve
    // its company the way every other activity does. The token carries that:
    // peek to learn the company, claim the activity for deduplication, and only
    // then spend the token. Consuming before claiming would let a Teams
    // redelivery find the token already spent and report a failed pairing for a
    // pairing that in fact succeeded — the same ordering Telegram needs.
    const pairingToken = parseTeamsPairingToken(activity.text);
    if (pairingToken && actor.aadObjectId) {
      const challenge = await channels.peekPairingChallenge("teams", pairingToken);
      if (!challenge) {
        // Hand it over anyway so the person who followed a dead link is told,
        // rather than met with silence.
        await teams.completePairing({
          token: pairingToken,
          aadObjectId: actor.aadObjectId,
          tenantId: actor.tenantId,
          conversationId,
          serviceUrl,
        });
        res.status(200).json({ status: 200 });
        return;
      }

      const pairClaim = await channels.claimEvent(
        "teams",
        challenge.companyId,
        activityId,
        teams.digest(activity),
        { eventType: "pairing" },
      );
      if (!pairClaim.claimed) {
        res.status(200).json({ status: 200 });
        return;
      }

      try {
        await teams.completePairing({
          token: pairingToken,
          aadObjectId: actor.aadObjectId,
          tenantId: actor.tenantId,
          conversationId,
          serviceUrl,
        });
        if (pairClaim.eventId) await channels.markEventProcessed(pairClaim.eventId, "processed");
      } catch (error) {
        logger.warn({ err: error, activityId }, "teams pairing failed");
        if (pairClaim.eventId) await channels.markEventProcessed(pairClaim.eventId, "failed");
      }
      res.status(200).json({ status: 200 });
      return;
    }

    const binding = actor.aadObjectId
      ? await channels.resolveActiveBinding("teams", actor.aadObjectId)
      : null;
    if (!binding) {
      // Unpaired, revoked, or uninstalled: acknowledge and drop.
      res.status(200).json({ status: 200 });
      return;
    }

    const claim = await channels.claimEvent(
      "teams",
      binding.companyId,
      activityId,
      teams.digest(activity),
      { eventType: String(activity.type ?? "unknown"), bindingId: binding.id },
    );
    if (!claim.claimed) {
      // Redelivery: acknowledge without repeating side effects.
      res.status(200).json({ status: 200 });
      return;
    }

    try {
      const value = activity.value as { action?: { data?: { token?: unknown } } } | undefined;
      const token = value?.action?.data?.token;
      if (activity.type === "invoke" && typeof token === "string") {
        const outcome = await teams.decideFromCardAction({ actor, token });
        if (claim.eventId) await channels.markEventProcessed(claim.eventId, "processed");
        // Adaptive Card invoke response: a refusal is reported in the card, not
        // as an HTTP error, so Teams does not retry a denied action.
        res.status(200).json({
          statusCode: 200,
          type: "application/vnd.microsoft.activity.message",
          value: outcome.message,
        });
        return;
      }

      if (claim.eventId) await channels.markEventProcessed(claim.eventId, "processed");
      res.status(200).json({ status: 200 });
    } catch (error) {
      logger.warn({ err: error, activityId }, "teams activity handling failed");
      if (claim.eventId) await channels.markEventProcessed(claim.eventId, "failed");
      res.status(200).json({ status: 200 });
    }
  });

  return router;
}
