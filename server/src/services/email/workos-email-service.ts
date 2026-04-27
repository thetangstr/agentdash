// AgentDash (AGE-59): Cloud Pro email backend.
// - sendInvite: TODO(AGE-58) — delegate to WorkOS Invitations API once
//   WorkOSProvider lands. Until then, falls back to Resend directly.
// - sendJoinRequestNotification + sendWelcome: Resend directly using
//   AgentDash's own RESEND_API_KEY.

import { Resend } from "resend";
import type { Db } from "@agentdash/db";
import { logActivity } from "../activity-log.js";
import {
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

export interface WorkOSEmailConfig {
  resendApiKey: string;
  // TODO(AGE-58): workosApiKey for WorkOS Invitations API once WorkOSProvider lands.
}

// ---------------------------------------------------------------------------
// WorkOSEmailService
// ---------------------------------------------------------------------------

export class WorkOSEmailService implements EmailService {
  private readonly resend: Resend;
  private readonly db: Db;
  private readonly companyId: string;

  constructor(config: WorkOSEmailConfig, db: Db, companyId: string) {
    this.resend = new Resend(config.resendApiKey);
    this.db = db;
    this.companyId = companyId;
  }

  async sendInvite(payload: SendInvitePayload): Promise<void> {
    // TODO(AGE-58): When WorkOSProvider is implemented, delegate to
    // WorkOS Invitations API here (WorkOS sends the email natively).
    // For now, fall back to Resend directly.
    const template = inviteTemplate(payload);
    await this._sendViaResend(payload.to, template.subject, template.html, template.text);
    await this._logSuccess("invite", payload.to);
  }

  async sendJoinRequestNotification(
    payload: SendJoinRequestNotificationPayload,
  ): Promise<void> {
    const template = joinRequestTemplate(payload);
    await this._sendViaResend(payload.to, template.subject, template.html, template.text);
    await this._logSuccess("join_request_notification", payload.to);
  }

  async sendWelcome(payload: SendWelcomePayload): Promise<void> {
    const template = welcomeTemplate(payload);
    await this._sendViaResend(payload.to, template.subject, template.html, template.text);
    await this._logSuccess("welcome", payload.to);
  }

  private async _sendViaResend(
    to: string,
    subject: string,
    html: string,
    text: string,
  ): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: FROM_ADDRESS,
      to,
      subject,
      html,
      text,
    });

    if (error) {
      await this._logFailure(to, error);
      throw new Error(`Resend error: ${error.message}`);
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
      details: { emailType, backend: "workos" },
    });
  }

  private async _logFailure(to: string, error: unknown): Promise<void> {
    await logActivity(this.db, {
      companyId: this.companyId,
      actorType: "system",
      actorId: "email-service",
      action: "email_relay_failed",
      entityType: "email",
      entityId: to,
      details: {
        backend: "workos",
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
