// AgentDash (AGE-59): In-process email templates (template literals, no external engine).
// All templates produce { subject, html, text } for a given payload.

import type {
  SendInvitePayload,
  SendJoinRequestNotificationPayload,
  SendWelcomePayload,
} from "./email-service.js";

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

export function inviteTemplate(payload: SendInvitePayload): EmailTemplate {
  const expiresFormatted = payload.expiresAt.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const subject = `You've been invited to join ${payload.orgName} on AgentDash`;

  const text = `
You've been invited to join ${payload.orgName} on AgentDash.

Accept your invitation here:
${payload.inviteUrl}

This invite expires on ${expiresFormatted}.

If you didn't expect this invitation, you can safely ignore this email.
  `.trim();

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px">
  <h2>You've been invited to join ${escapeHtml(payload.orgName)}</h2>
  <p>Click the button below to accept your invitation to AgentDash.</p>
  <a href="${escapeHtml(payload.inviteUrl)}"
     style="display:inline-block;background:#0d9488;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
    Accept Invitation
  </a>
  <p style="color:#6b7280;font-size:0.875rem;margin-top:24px">
    This invite expires on ${escapeHtml(expiresFormatted)}.<br>
    If you didn't expect this, you can safely ignore this email.
  </p>
</body>
</html>
  `.trim();

  return { subject, html, text };
}

export function joinRequestTemplate(
  payload: SendJoinRequestNotificationPayload,
): EmailTemplate {
  const subject = `New join request for ${payload.orgName} on AgentDash`;

  const text = `
${payload.requesterEmail} has requested to join ${payload.orgName} on AgentDash.

Review and approve the request here:
${payload.approveUrl}
  `.trim();

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px">
  <h2>New join request for ${escapeHtml(payload.orgName)}</h2>
  <p><strong>${escapeHtml(payload.requesterEmail)}</strong> has requested to join your organisation.</p>
  <a href="${escapeHtml(payload.approveUrl)}"
     style="display:inline-block;background:#0d9488;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">
    Review Request
  </a>
</body>
</html>
  `.trim();

  return { subject, html, text };
}

export function welcomeTemplate(payload: SendWelcomePayload): EmailTemplate {
  const subject = `Welcome to ${payload.orgName} on AgentDash`;

  const text = `
Hi ${payload.name},

Welcome to ${payload.orgName} on AgentDash! You now have access to the platform.

Get started by visiting your dashboard.
  `.trim();

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px">
  <h2>Welcome to ${escapeHtml(payload.orgName)}!</h2>
  <p>Hi ${escapeHtml(payload.name)},</p>
  <p>You've successfully joined <strong>${escapeHtml(payload.orgName)}</strong> on AgentDash.
     Head to your dashboard to get started.</p>
</body>
</html>
  `.trim();

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
