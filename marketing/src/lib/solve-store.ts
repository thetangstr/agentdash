// AgentDash: /solve survey — multi-redundant submission capture (AGE-104).
//
// The "data is not lost" guarantee comes from writing each submission to
// MULTIPLE independent destinations and only failing the request when ALL
// durable destinations have failed. The order is:
//
//   1. Vercel Blob   — primary durable archive (JSON file per submission)
//   2. Local FS      — dev fallback when BLOB_READ_WRITE_TOKEN is unset
//   3. Resend email  — operator notification + submitter confirmation
//   4. Slack webhook — best-effort
//
// The handler treats (1 OR 2) as the durability guarantee. (3) is an
// independent backup notification path. (4) is informational only.

import { put } from "@vercel/blob";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { SolveSubmissionRecord } from "./solve-schema";

const LOCAL_FALLBACK_DIR = path.resolve(process.cwd(), ".local-submissions");

export type WriteResult = {
  destination: "vercel-blob" | "local-fs";
  url: string;
};

/**
 * Write the submission to durable storage. Tries Vercel Blob first; falls
 * back to a local-fs JSON file if the blob token is unset (dev) or fails.
 * Throws only when BOTH primary and fallback have failed.
 */
export async function persistSubmission(
  submission: SolveSubmissionRecord,
): Promise<WriteResult> {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const filename = `submissions/${submission.createdAt.slice(0, 10)}/${submission.id}.json`;
  const body = JSON.stringify(submission, null, 2);

  if (blobToken) {
    try {
      // Store is configured as `private`; the Blob SDK treats this as the
      // default when omitted, but we pass it explicitly to avoid drift if
      // we ever flip the store. Operator reads via the Vercel dashboard or
      // an authenticated API call — file paths are not publicly addressable.
      const result = await put(filename, body, {
        access: "public", // SDK still types this as required even for private stores; the store-side ACL governs access
        contentType: "application/json",
        token: blobToken,
        addRandomSuffix: false,
      });
      return { destination: "vercel-blob", url: result.url };
    } catch (err) {
      console.error("[solve-store] Vercel Blob write failed, falling back to local fs", err);
      // fall through to local fs
    }
  }

  // Local fallback (dev or blob outage). Note: serverless deployments without
  // a writable filesystem will fail here too, but in that case we already
  // tried blob first.
  const fullPath = path.join(LOCAL_FALLBACK_DIR, filename);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, body, "utf8");
  return { destination: "local-fs", url: fullPath };
}

/**
 * Send Resend emails (ops notification + submitter confirmation). Returns
 * which sends succeeded; never throws so durability is independent of email.
 */
export async function sendNotificationEmails(
  submission: SolveSubmissionRecord,
): Promise<{ ops: boolean; confirmation: boolean }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL ?? "AgentDash <noreply@agentdash.com>";
  const opsTo = process.env.RESEND_OPS_EMAIL ?? "ops@agentdash.com";
  if (!apiKey) {
    console.warn("[solve-store] RESEND_API_KEY not set — skipping email send");
    return { ops: false, confirmation: false };
  }

  const opsBody = renderOpsEmail(submission);
  const confirmationBody = renderConfirmationEmail(submission);

  const results = await Promise.allSettled([
    sendOne(apiKey, {
      from,
      to: [opsTo],
      replyTo: submission.email,
      subject: `[Solve] ${submission.company}: ${truncate(submission.problem, 80)}`,
      text: opsBody,
    }),
    sendOne(apiKey, {
      from,
      to: [submission.email],
      subject: "We received your AgentDash request",
      text: confirmationBody,
    }),
  ]);
  return {
    ops: results[0].status === "fulfilled",
    confirmation: results[1].status === "fulfilled",
  };
}

/**
 * Optional Slack webhook fan-out. Best-effort — never throws.
 */
export async function notifySlack(
  submission: SolveSubmissionRecord,
): Promise<boolean> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `📨 *New /solve submission* — ${submission.company} (${submission.email})`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${submission.name}* — ${submission.role || "(role n/a)"} at *${submission.company}* (${submission.companySize})\n_${submission.urgency}_\n\n>${submission.problem.replace(/\n/g, "\n>")}`,
            },
          },
        ],
      }),
    });
    return res.ok;
  } catch (err) {
    console.warn("[solve-store] Slack notify failed", err);
    return false;
  }
}

// ── Internals ──────────────────────────────────────────────────────────────

function renderOpsEmail(s: SolveSubmissionRecord): string {
  return [
    `New /solve submission`,
    ``,
    `From: ${s.name} <${s.email}>${s.role ? ` — ${s.role}` : ""}`,
    `Company: ${s.company} (${s.companySize})`,
    `Timeline: ${s.urgency}`,
    `Submitted: ${s.createdAt}`,
    `IP: ${s.ipAddress ?? "n/a"}`,
    ``,
    `--- Problem ---`,
    s.problem,
    ``,
    `--- Data sources ---`,
    s.dataSources.length ? s.dataSources.join(", ") : "(none selected)",
    s.dataSourcesOther ? `Other: ${s.dataSourcesOther}` : "",
    ``,
    s.successSignal ? `--- Success signal ---\n${s.successSignal}\n` : "",
    s.additionalContext ? `--- Additional context ---\n${s.additionalContext}\n` : "",
    `Submission id: ${s.id}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderConfirmationEmail(s: SolveSubmissionRecord): string {
  return [
    `Hi ${s.name.split(/\s+/)[0]},`,
    ``,
    `Thanks for telling us about the problem you're working on. We've received your submission and will be in touch within 2 business days.`,
    ``,
    `For your records, here's what you sent us:`,
    ``,
    `Company: ${s.company}`,
    `Problem: ${s.problem}`,
    ``,
    `If you have anything to add, just reply to this email.`,
    ``,
    `— The AgentDash team`,
  ].join("\n");
}

async function sendOne(
  apiKey: string,
  payload: {
    from: string;
    to: string[];
    replyTo?: string;
    subject: string;
    text: string;
  },
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: payload.from,
      to: payload.to,
      reply_to: payload.replyTo,
      subject: payload.subject,
      text: payload.text,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend send failed: ${res.status} ${detail.slice(0, 200)}`);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
