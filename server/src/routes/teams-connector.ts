import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { humanChannelService } from "../services/human-channels.js";
import {
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
 * `@microsoft/teams.apps` keeps Bot Framework token validation inside its `App`
 * / `HttpPlugin` pipeline; it exports no standalone validator. Wiring that
 * pipeline (so the SDK owns the endpoint and validates activities) is NOT done
 * yet, and hand-rolling JWKS validation here would mean reimplementing the
 * security-critical part the SDK exists to provide.
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
