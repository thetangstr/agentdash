// AgentDash (SC-7, GH #768): the front door's email (spec §3.7): verify,
// ready (the claim link), find, waitlisted and approved. Sent through Resend
// from the verified agentdash.cloud domain. Links in these emails are
// credentials, so a message body is never logged; the "log" transport (local
// development only) is the one exception and says so.
import type { Logger } from "../logger.js";
import type { Secret } from "../secret.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** A short non-secret label for logs and tests ("verify", "ready", …). */
  kind: MailKind;
}

export type MailKind =
  | "verify"
  | "already_have_box"
  | "ready"
  | "find"
  | "find_none"
  | "waitlisted"
  | "approved"
  // AgentDash (SC-10, GH #771): the Free idle policy (spec §5.2).
  | "idle_suspend_warning"
  | "idle_delete_warning";

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  /** False when no transport is configured: the front door refuses up front instead of failing mid-request. */
  readonly configured?: boolean;
}

export class MailNotConfigured extends Error {}

export function resendMailer(opts: { apiKey: Secret; from: string; fetch?: typeof fetch }): Mailer {
  const f = opts.fetch ?? fetch;
  return {
    async send(m) {
      const res = await f("https://api.resend.com/emails", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey.reveal()}` },
        body: JSON.stringify({ from: opts.from, to: [m.to], subject: m.subject, text: m.text, html: m.html, tags: [{ name: "kind", value: m.kind }] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Resend answered HTTP ${res.status}`);
    },
  };
}

/** Local development only (CLOUD_MAIL_TRANSPORT=log): writes the message, links included, to the log. */
export function logMailer(log: Logger): Mailer {
  return {
    async send(m) {
      // GH #836 review: even here the credentials in links are redacted.
      const body = m.text.replace(/([#&?](?:token|code)=)[^\s&#]+/g, "$1[redacted]");
      log.warn("DEV MAIL (CLOUD_MAIL_TRANSPORT=log; localhost only)", { mailKind: m.kind, to: m.to, subject: m.subject, body });
    },
  };
}

/** Refuses every send: the front door answers 503 rather than accept a signup it cannot email. */
export function unconfiguredMailer(): Mailer {
  return {
    configured: false,
    async send() {
      throw new MailNotConfigured("email is not configured (CLOUD_RESEND_API_KEY)");
    },
  };
}

// ---- Templates -----------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function render(kind: MailKind, to: string, subject: string, paragraphs: string[], button?: { label: string; url: string }, after: string[] = []): MailMessage {
  const text = [...paragraphs, ...(button ? [`${button.label}: ${button.url}`] : []), ...after, "", "AgentDash · agentdash.cloud"].join("\n\n");
  const p = (t: string) => `<p style="margin:0 0 16px;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2933">${escapeHtml(t)}</p>`;
  const html = [
    `<div style="max-width:520px;margin:0 auto;padding:24px">`,
    ...paragraphs.map(p),
    button
      ? `<p style="margin:24px 0"><a href="${escapeHtml(button.url)}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font:600 15px -apple-system,Segoe UI,Helvetica,Arial,sans-serif">${escapeHtml(button.label)}</a></p>`
        + p(`Or paste this link into your browser: ${button.url}`)
      : "",
    ...after.map(p),
    `<p style="margin:24px 0 0;font:13px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#6b7280">AgentDash · agentdash.cloud</p>`,
    `</div>`,
  ].join("");
  return { kind, to, subject, text, html };
}

export const emails = {
  verify(to: string, input: { link: string; slug: string }): MailMessage {
    return render("verify", to, "Confirm your email to create your AgentDash workspace", [
      `Confirm this address to create your workspace, ${input.slug}.`,
      "The link works once and expires in 30 minutes.",
    ], { label: "Confirm my email", url: input.link }, ["If you did not ask for this, ignore this email; nothing is created."]);
  },
  alreadyHaveBox(to: string, input: { link: string }): MailMessage {
    return render("already_have_box", to, "You already have an AgentDash workspace", [
      "Someone (probably you) tried to create another workspace with this address. Each email gets one free workspace.",
      "Use the link below to see yours. It works once and expires in 30 minutes.",
    ], { label: "Show my workspace", url: input.link });
  },
  ready(to: string, input: { claimUrl: string; slug: string; publicUrl: string }): MailMessage {
    return render("ready", to, "Your AgentDash workspace is ready", [
      `Your workspace ${input.slug} is ready at ${input.publicUrl}.`,
      "Open it with the button below to create your account. The link is for you only: it works once, for this email address, and expires in 7 days.",
    ], { label: "Open my workspace", url: input.claimUrl });
  },
  find(to: string, input: { signInLink: string; boxes: Array<{ slug: string; url: string; note: string }> }): MailMessage {
    return render("find", to, "Your AgentDash workspaces", [
      "Here are the workspaces for this address:",
      ...input.boxes.map((b) => `${b.slug}: ${b.url} (${b.note})`),
      "To see progress or re-send a claim link, use the button below. It works once and expires in 30 minutes.",
    ], { label: "Show my workspaces", url: input.signInLink });
  },
  findNone(to: string, input: { startUrl: string }): MailMessage {
    return render("find_none", to, "No AgentDash workspace for this address", [
      "Someone (probably you) asked for the workspaces linked to this address. There are none yet.",
    ], { label: "Create a workspace", url: input.startUrl });
  },
  waitlisted(to: string, input: { slug: string; progressLink: string }): MailMessage {
    return render("waitlisted", to, "You're on the AgentDash list", [
      `Thanks for confirming your email. Your workspace name, ${input.slug}, is saved for you.`,
      "We are letting people in a few at a time. We will email you as soon as your workspace is being created.",
    ], { label: "Check my place", url: input.progressLink });
  },
  approved(to: string, input: { slug: string; signInLink: string; provisioning: boolean }): MailMessage {
    return render("approved", to, "You're in: your AgentDash workspace is on its way", [
      input.provisioning
        ? `You're approved, and we are creating your workspace ${input.slug} now. It takes about 3 minutes; we will email the link to open it when it is ready.`
        : `You're approved. Your workspace ${input.slug} will be created when capacity is available; we will email the link to open it when it is ready.`,
    ], { label: "Watch progress", url: input.signInLink });
  },
  // AgentDash (SC-10, GH #771): Free idle policy, spec §5.2 (day 14 and day 45).
  idleSuspendWarning(to: string, input: { slug: string; url: string; pauseOn: Date }): MailMessage {
    return render("idle_suspend_warning", to, "Your AgentDash workspace will pause soon", [
      `Nobody has used your free workspace ${input.slug} for two weeks. To save resources we pause idle free workspaces; yours will pause on or after ${longDate(input.pauseOn)}.`,
      "Sign in before then to keep it running. If it does pause, nothing is lost: your data stays, and opening the workspace wakes it in about a minute.",
    ], { label: "Open my workspace", url: input.url });
  },
  idleDeleteWarning(to: string, input: { slug: string; url: string; deleteOn: Date }): MailMessage {
    return render("idle_delete_warning", to, "Your paused AgentDash workspace will be deleted in 15 days", [
      `Your free workspace ${input.slug} has been paused for a while and nobody has opened it. It will be deleted on or after ${longDate(input.deleteOn)}.`,
      "To keep it, open it before then: it wakes in about a minute and the countdown stops. To keep a copy instead, open it and export your company from its settings.",
    ], { label: "Open my workspace", url: input.url });
  },
};

function longDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}
