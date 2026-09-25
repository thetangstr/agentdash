// AgentDash: Slack Connector (AGE-108)
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { slackConnectorService, verifySlackSignature } from "../services/slack-connector.js";
import type { SlackEventPayload, SlackInteractionPayload } from "../services/slack-connector.js";
import { logger } from "../middleware/logger.js";
import { connectorService } from "../services/connectors.js";
import { authorizeNamedConnection } from "./connector-acting-as.js";

export function slackConnectorRoutes(db: Db) {
  const router = Router();
  const svc = slackConnectorService(db);
  const connSvc = connectorService(db);

  // -------------------------------------------------------------------------
  // OAuth: initiate
  // -------------------------------------------------------------------------

  /**
   * POST /api/connectors/slack/oauth/initiate
   * Starts the Slack OAuth flow — returns the authorize URL for the user
   * to open in their browser.
   */
  router.post("/slack/oauth/initiate", async (req, res) => {
    assertBoard(req);
    const { companyId } = req.body;
    if (!companyId || typeof companyId !== "string") {
      res.status(400).json({ error: "companyId is required" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);

    const result = await svc.initiateOAuth(companyId, actor.actorId, actor.actorType);
    res.json(result);
  });

  // -------------------------------------------------------------------------
  // OAuth: callback (Slack redirects here after user authorization)
  // -------------------------------------------------------------------------

  /**
   * GET /api/connectors/slack/oauth/callback
   * Slack redirects here after the user authorizes the app.
   * Exchanges the code for tokens and creates the connection.
   */
  router.get("/slack/oauth/callback", async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      // User denied or Slack returned an error
      logger.warn({ error }, "Slack OAuth denied or errored");
      res.status(400).json({
        error: "Slack authorization failed",
        detail: typeof error === "string" ? error : "unknown",
      });
      return;
    }

    if (typeof code !== "string" || typeof state !== "string") {
      res.status(400).json({ error: "Missing code or state parameter" });
      return;
    }

    try {
      const result = await svc.handleOAuthCallback(code, state);
      // Redirect to the connections page with success indicator
      res.redirect(`/settings/connections?slack=connected&team=${encodeURIComponent(result.teamName)}`);
    } catch (err) {
      logger.error({ err }, "Slack OAuth callback failed");
      res.redirect("/settings/connections?slack=error");
    }
  });

  // -------------------------------------------------------------------------
  // Slack Events API endpoint
  // -------------------------------------------------------------------------

  /**
   * POST /api/connectors/slack/events
   * Receives events from Slack's Events API.
   * Handles URL verification challenge and event dispatching.
   */
  router.post("/slack/events", async (req, res) => {
    const config = svc.getConfig();

    // AgentDash: security — FAIL CLOSED. If no signing secret is configured we
    // cannot verify that requests genuinely originate from Slack, so we must
    // reject everything rather than process forged payloads. Mirrors the Stripe
    // webhook guard in billing.ts.
    if (!config.signingSecret) {
      res.status(503).json({ error: "Slack connector not configured" });
      return;
    }

    const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
    const signature = req.headers["x-slack-signature"] as string | undefined;
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;

    if (!timestamp || !signature || !rawBody) {
      res.status(401).json({ error: "Missing Slack signature headers" });
      return;
    }

    const isValid = verifySlackSignature(
      config.signingSecret,
      timestamp,
      rawBody.toString("utf8"),
      signature,
    );

    if (!isValid) {
      res.status(401).json({ error: "Invalid Slack signature" });
      return;
    }

    const payload = req.body as SlackEventPayload;

    // URL verification challenge — Slack sends this when configuring the endpoint
    if (payload.type === "url_verification") {
      res.json({ challenge: payload.challenge });
      return;
    }

    // Acknowledge the event immediately (Slack expects a 200 within 3 seconds)
    res.status(200).json({ ok: true });

    // Process the event asynchronously
    try {
      const result = await svc.handleEvent(payload);
      if (result && "type" in result && result.type === "inbound_message") {
        logger.info(
          {
            teamId: result.teamId,
            channel: result.channelId,
            user: result.userId,
          },
          "Slack inbound message received",
        );
        // Inbound message routing will be wired to conversation-dispatch
        // in a follow-up when the Slack team_id → workspace mapping is built.
        // For now, log the event for observability.
      }
    } catch (err) {
      logger.error({ err }, "Error processing Slack event");
    }
  });

  // -------------------------------------------------------------------------
  // Slack interactive message callbacks
  // -------------------------------------------------------------------------

  /**
   * POST /api/connectors/slack/interactions
   * Handles interactive message callbacks (e.g. approval buttons).
   * Slack sends these as application/x-www-form-urlencoded with a `payload`
   * JSON field.
   */
  router.post("/slack/interactions", async (req, res) => {
    const config = svc.getConfig();

    // AgentDash: security — FAIL CLOSED. See /slack/events above.
    if (!config.signingSecret) {
      res.status(503).json({ error: "Slack connector not configured" });
      return;
    }

    const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
    const signature = req.headers["x-slack-signature"] as string | undefined;
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;

    if (!timestamp || !signature || !rawBody) {
      res.status(401).json({ error: "Missing Slack signature headers" });
      return;
    }

    const isValid = verifySlackSignature(
      config.signingSecret,
      timestamp,
      rawBody.toString("utf8"),
      signature,
    );

    if (!isValid) {
      res.status(401).json({ error: "Invalid Slack signature" });
      return;
    }

    // Slack sends interactions as form-encoded with a `payload` JSON field
    let payload: SlackInteractionPayload;
    try {
      const rawPayload = req.body?.payload ?? req.body;
      payload = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
    } catch {
      res.status(400).json({ error: "Invalid interaction payload" });
      return;
    }

    // Acknowledge immediately
    res.status(200).json({ ok: true });

    // Process interaction asynchronously
    try {
      if (payload.type === "block_actions" && payload.actions) {
        for (const action of payload.actions) {
          if (action.action_id === "approve_send") {
            logger.info(
              {
                user: payload.user?.id,
                channel: payload.channel?.id,
                action: action.action_id,
              },
              "Slack approve_send interaction received",
            );
            // Approval handling will be wired to the connector approval flow.
            // The action.value contains the approval payload reference.
          } else if (action.action_id === "reject_send") {
            logger.info(
              {
                user: payload.user?.id,
                channel: payload.channel?.id,
                action: action.action_id,
              },
              "Slack reject_send interaction received",
            );
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "Error processing Slack interaction");
    }
  });

  // -------------------------------------------------------------------------
  // Post a message to Slack (agent-facing)
  // -------------------------------------------------------------------------

  /**
   * POST /api/connectors/slack/send
   * Agent posts a message to a Slack channel/thread.
   * Respects autonomy controls.
   */
  router.post("/slack/send", async (req, res) => {
    assertBoard(req);
    const { companyId, connectionId, channel, text, threadTs, agentId } = req.body;

    if (!companyId || !connectionId || !channel || !text || !agentId) {
      res.status(400).json({
        error: "Required fields: companyId, connectionId, channel, text, agentId",
      });
      return;
    }

    assertCompanyAccess(req, companyId);

    // AgentDash (security): same rule as Gmail — a human naming an agent may
    // not reach another human's private connection (e.g. via the steward
    // fallback in agentdash_mk companies). Checked before any token is used.
    const authorized = await authorizeNamedConnection(connSvc, req, {
      companyId,
      connectionId,
      provider: "slack",
      actionClass: "send",
      requestedAgentId: agentId,
    });
    if (!authorized.ok) {
      res.status(403).json({ error: authorized.message, code: authorized.code });
      return;
    }

    const result = await svc.postMessage(authorized.resolution.connectionId, {
      channel,
      text,
      threadTs,
      companyId,
      agentId: authorized.actingId,
    });

    res.json(result);
  });

  return router;
}
