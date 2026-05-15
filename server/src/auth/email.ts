// AgentDash: Resend-backed transactional email for Better Auth.
//
// Why a fetch-based wrapper instead of the `resend` SDK:
//   - Resend's REST API is one endpoint (`POST /emails`); the SDK adds
//     ~200 KB of dep tree we don't need.
//   - Lets us be defensive: when `RESEND_API_KEY` isn't set we log a
//     warning and silently no-op instead of crashing on a missing
//     constructor. That's important in local_trusted dev where users
//     never have a Resend account.
//
// Env vars:
//   RESEND_API_KEY              — required to actually send. No-op when unset.
//   AGENTDASH_EMAIL_FROM        — sender address (default: "AgentDash <onboarding@resend.dev>").
//                                 Use Resend's `onboarding@resend.dev` shared
//                                 sender for testing without a verified domain;
//                                 swap to your own domain for production.
//   AGENTDASH_EMAIL_REPLY_TO    — optional Reply-To address.
//
// Failure mode: any error inside sendEmail() is caught and logged. We
// never let an email failure abort the auth flow — sign-up/reset still
// succeed, the user just doesn't get the email. Better than 500s.

import { logger } from "../middleware/logger.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "AgentDash <onboarding@resend.dev>";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface SendEmailResult {
  status: "sent" | "skipped" | "failed";
  messageId?: string;
  error?: string;
}

/**
 * Send an email via Resend. Returns a structured result rather than
 * throwing, so callers can log + continue without an aborted auth flow.
 *
 * If RESEND_API_KEY is unset (the local_trusted / dev case), we log
 * once at info level and return { status: "skipped" }. The reset link
 * or welcome message can still be inspected in the server logs at the
 * call site (see better-auth.ts wiring).
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    logger.info(
      { to: input.to, subject: input.subject },
      "[email] RESEND_API_KEY not set — skipping outbound email. Set RESEND_API_KEY to enable.",
    );
    return { status: "skipped" };
  }

  const from = process.env.AGENTDASH_EMAIL_FROM?.trim() || DEFAULT_FROM;
  const replyTo = process.env.AGENTDASH_EMAIL_REPLY_TO?.trim();

  const body: Record<string, unknown> = {
    from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
  };
  if (input.text) body.text = input.text;
  if (replyTo) body.reply_to = replyTo;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      logger.warn(
        { to: input.to, subject: input.subject, status: res.status, detail: detail.slice(0, 240) },
        "[email] Resend returned non-2xx — email not sent",
      );
      return { status: "failed", error: `HTTP ${res.status}` };
    }

    const json = (await res.json().catch(() => ({}))) as { id?: string };
    logger.info({ to: input.to, subject: input.subject, messageId: json.id }, "[email] sent");
    return { status: "sent", messageId: json.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ to: input.to, subject: input.subject, error: message }, "[email] send threw — email not sent");
    return { status: "failed", error: message };
  }
}

// ---------- email templates ----------

/**
 * Welcome email sent right after a new user signs up. Plain HTML — no
 * external assets, no tracking pixels. Renders fine in dark-mode mail
 * clients (no hardcoded background colors on the body).
 */
export function welcomeEmailTemplate(input: { name: string | null; appUrl: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const greet = input.name?.trim() ? `Hi ${input.name},` : "Hi,";
  const subject = "Welcome to AgentDash";
  const text = [
    greet,
    "",
    "AgentDash is set up and your account is ready.",
    "",
    `Sign in: ${input.appUrl}`,
    "",
    "What's next:",
    "  • Talk to your Chief of Staff — describe what you want to ship.",
    "  • Hire your first agent — pick a role, give it instructions.",
    "  • Invite teammates — they share the same workspace and CoS thread.",
    "",
    "— The AgentDash team",
  ].join("\n");

  const html = `
    <!doctype html>
    <html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 560px; margin: 24px auto; line-height: 1.6;">
      <h1 style="font-size: 22px; margin: 0 0 16px;">Welcome to AgentDash</h1>
      <p>${escapeHtml(greet)}</p>
      <p>AgentDash is set up and your account is ready.</p>
      <p><a href="${escapeHtml(input.appUrl)}" style="display: inline-block; padding: 10px 16px; background: #1f1e1d; color: #fff; text-decoration: none; border-radius: 6px;">Open AgentDash</a></p>
      <h3 style="font-size: 15px; margin: 24px 0 8px;">What's next</h3>
      <ul style="padding-left: 20px;">
        <li>Talk to your Chief of Staff — describe what you want to ship.</li>
        <li>Hire your first agent — pick a role, give it instructions.</li>
        <li>Invite teammates — they share the same workspace and CoS thread.</li>
      </ul>
      <p style="margin-top: 32px; color: #666; font-size: 13px;">— The AgentDash team</p>
    </body></html>
  `.trim();

  return { subject, html, text };
}

/**
 * Password-reset email. Resend's anti-phishing recommendation: include
 * the URL once in the link AND once as plain text so the user can copy
 * if their mail client mangles the link.
 */
export function resetPasswordEmailTemplate(input: { resetUrl: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = "Reset your AgentDash password";
  const text = [
    "Someone (hopefully you) asked to reset your AgentDash password.",
    "",
    `Reset link: ${input.resetUrl}`,
    "",
    "If you didn't ask for this, you can ignore this email — your password won't change.",
    "",
    "The link expires in 1 hour for security.",
  ].join("\n");

  const html = `
    <!doctype html>
    <html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 560px; margin: 24px auto; line-height: 1.6;">
      <h1 style="font-size: 22px; margin: 0 0 16px;">Reset your password</h1>
      <p>Someone (hopefully you) asked to reset your AgentDash password.</p>
      <p><a href="${escapeHtml(input.resetUrl)}" style="display: inline-block; padding: 10px 16px; background: #1f1e1d; color: #fff; text-decoration: none; border-radius: 6px;">Reset password</a></p>
      <p style="font-size: 13px; color: #666;">Or copy this URL: ${escapeHtml(input.resetUrl)}</p>
      <p style="font-size: 13px; color: #666;">If you didn't ask for this, you can ignore this email — your password won't change. The link expires in 1 hour.</p>
    </body></html>
  `.trim();

  return { subject, html, text };
}

/**
 * Sanitizer for user-controlled strings that flow into mail subject /
 * plaintext body. HTML escaping protects the HTML part, but the
 * plaintext part is rendered as-is and the subject lands in real mail
 * headers; both are vulnerable to social-engineering payloads like
 * `"Microsoft Security <security@example.com>"` set as the user's
 * display name. Strip control chars (CR/LF), quotes, angle brackets,
 * and `@` (which lets attackers impersonate "Big Co security team
 * <security@bigco.com>"), collapse whitespace, and cap at 60 chars.
 *
 * Returns null on input that's empty after sanitization, so the caller
 * can fall back to a neutral default ("your teammate" / "AgentDash").
 */
export function sanitizeDisplayName(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/[\r\n<>"'@]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Onboarding-wizard invite email. Plain HTML, no external assets, copy
 * of the URL in plain text for clients that mangle the link. The
 * inviter's display name is optional — when null we fall back to "your
 * teammate" so the body still reads naturally.
 *
 * Both `companyName` and `inviterName` flow through `sanitizeDisplayName`
 * before any rendering so an attacker-controlled `authUsers.name` can't
 * craft a phishing-friendly subject like "Microsoft Security
 * <security@microsoft.com> invited you to ...".
 */
export function inviteEmailTemplate(input: {
  inviteUrl: string;
  companyName: string | null;
  inviterName: string | null;
}): { subject: string; html: string; text: string } {
  const company = sanitizeDisplayName(input.companyName) ?? "AgentDash";
  const inviter = sanitizeDisplayName(input.inviterName) ?? "your teammate";
  const subject = `${inviter} invited you to ${company} on AgentDash`;
  const text = [
    `${inviter} invited you to join ${company} on AgentDash.`,
    "",
    `Accept the invite: ${input.inviteUrl}`,
    "",
    "AgentDash gives your team a Chief of Staff agent that coordinates AI",
    "agents alongside humans. Once you join you'll share the same workspace",
    "and CoS thread.",
    "",
    "If you weren't expecting this email, you can ignore it — the invite",
    "expires in 72 hours.",
  ].join("\n");

  const html = `
    <!doctype html>
    <html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 560px; margin: 24px auto; line-height: 1.6;">
      <h1 style="font-size: 22px; margin: 0 0 16px;">You're invited to ${escapeHtml(company)}</h1>
      <p>${escapeHtml(inviter)} invited you to join <strong>${escapeHtml(company)}</strong> on AgentDash.</p>
      <p><a href="${escapeHtml(input.inviteUrl)}" style="display: inline-block; padding: 10px 16px; background: #1f1e1d; color: #fff; text-decoration: none; border-radius: 6px;">Accept invite</a></p>
      <p style="font-size: 13px; color: #666;">Or copy this URL: ${escapeHtml(input.inviteUrl)}</p>
      <p>AgentDash gives your team a Chief of Staff agent that coordinates AI agents alongside humans. Once you join you'll share the same workspace and CoS thread.</p>
      <p style="font-size: 13px; color: #666;">If you weren't expecting this email, you can ignore it — the invite expires in 72 hours.</p>
    </body></html>
  `.trim();

  return { subject, html, text };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
