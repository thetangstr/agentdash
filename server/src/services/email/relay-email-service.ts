// AgentDash (AGE-59): Self-hosted Free email backend.
// POSTs to the AgentDash-hosted Resend relay with a signed payload.
// On any 4xx/5xx/timeout/network error, throws EmailRelayUnavailableError
// so the caller can fall back to copy-link UX.

import { createHmac } from "node:crypto";
import type { Db } from "@agentdash/db";
import { logActivity } from "../activity-log.js";
import {
  EmailRelayUnavailableError,
  type EmailService,
  type SendInvitePayload,
  type SendJoinRequestNotificationPayload,
  type SendWelcomePayload,
} from "./email-service.js";
import {
  inviteTemplate,
  joinRequestTemplate,
  welcomeTemplate,
} from "./templates.js";

const FROM_ADDRESS = "noreply@agentdash.com";
const DEFAULT_RELAY_URL = "https://relay.agentdash.com/transactional";
const RELAY_TIMEOUT_MS = 10_000;

export interface AgentDashRelayConfig {
  relayUrl?: string;
  instanceId: string;
  signingKey: string;
}

// ---------------------------------------------------------------------------
// Relay payload types
// ---------------------------------------------------------------------------

interface RelayEmailPayload {
  instanceId: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  timestamp: number;
  signature: string;
}

function buildSignature(
  instanceId: string,
  to: string,
  subject: string,
  timestamp: number,
  signingKey: string,
): string {
  const message = `${instanceId}:${to}:${subject}:${timestamp}`;
  return createHmac("sha256", signingKey).update(message).digest("hex");
}

async function postToRelay(
  relayUrl: string,
  payload: RelayEmailPayload,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    throw new EmailRelayUnavailableError(
      `Email relay unreachable: ${String(err)}`,
      err,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new EmailRelayUnavailableError(
      `Email relay returned ${response.status}`,
      { status: response.status },
    );
  }
}

// ---------------------------------------------------------------------------
// AgentDashRelayEmailService
// ---------------------------------------------------------------------------

export class AgentDashRelayEmailService implements EmailService {
  private readonly relayUrl: string;
  private readonly instanceId: string;
  private readonly signingKey: string;
  private readonly db: Db;
  private readonly companyId: string;

  constructor(config: AgentDashRelayConfig, db: Db, companyId: string) {
    this.relayUrl = config.relayUrl ?? DEFAULT_RELAY_URL;
    this.instanceId = config.instanceId;
    this.signingKey = config.signingKey;
    this.db = db;
    this.companyId = companyId;
  }

  async sendInvite(payload: SendInvitePayload): Promise<void> {
    const template = inviteTemplate(payload);
    await this._send(payload.to, template.subject, template.html, template.text);
    await this._logSuccess("invite", payload.to);
  }

  async sendJoinRequestNotification(
    payload: SendJoinRequestNotificationPayload,
  ): Promise<void> {
    const template = joinRequestTemplate(payload);
    await this._send(payload.to, template.subject, template.html, template.text);
    await this._logSuccess("join_request_notification", payload.to);
  }

  async sendWelcome(payload: SendWelcomePayload): Promise<void> {
    const template = welcomeTemplate(payload);
    await this._send(payload.to, template.subject, template.html, template.text);
    await this._logSuccess("welcome", payload.to);
  }

  private async _send(
    to: string,
    subject: string,
    html: string,
    text: string,
  ): Promise<void> {
    const timestamp = Date.now();
    const signature = buildSignature(
      this.instanceId,
      to,
      subject,
      timestamp,
      this.signingKey,
    );

    const relayPayload: RelayEmailPayload = {
      instanceId: this.instanceId,
      from: FROM_ADDRESS,
      to,
      subject,
      html,
      text,
      timestamp,
      signature,
    };

    try {
      await postToRelay(this.relayUrl, relayPayload);
    } catch (err) {
      await this._logRelayFailure(to, err);
      throw err;
    }
  }

  private async _logSuccess(emailType: string, to: string): Promise<void> {
    await logActivity(this.db, {
      companyId: this.companyId,
      actorType: "system",
      actorId: "email-service",
      action: "email_sent",
      entityType: "email",
      entityId: to,
      details: { emailType, backend: "relay" },
    });
  }

  private async _logRelayFailure(to: string, err: unknown): Promise<void> {
    await logActivity(this.db, {
      companyId: this.companyId,
      actorType: "system",
      actorId: "email-service",
      action: "email_relay_failed",
      entityType: "email",
      entityId: to,
      details: {
        backend: "relay",
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
