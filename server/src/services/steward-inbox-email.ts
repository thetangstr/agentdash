import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  stewardEmailNotices,
  userNotificationPreferences,
} from "@paperclipai/db";
import { sendEmail as defaultSendEmail, type SendEmailInput, type SendEmailResult } from "../auth/email.js";
import { logger } from "../middleware/logger.js";
import { agentAccountabilityService } from "./agent-accountability.js";
import { stewardInboxService } from "./steward-inbox.js";

/**
 * AgentDash-MK: email the person when something new waits on them in their
 * inbox -- an agent's question addressed to them, or an approval opened for
 * an agent they answer for.
 *
 * Three rules, each load-bearing:
 *
 * 1. **A pointer, never the ask.** The email names the agent (set by a person
 *    at hire) and the issue identifier, and links to it. It carries no issue
 *    title -- agents write those -- and none of the question's prompt or
 *    options or an approval's payload. Email is the widest channel this
 *    feature has; it carries the least.
 * 2. **Addressed exactly as the inbox is.** Who is emailed about what is read
 *    from `waitingItemsFor`, the uncapped form of the digest, so an email can
 *    never point someone at an item their inbox would not show them.
 * 3. **Batched durably, sent at most once.** At most one email per person per
 *    window, folding in everything that became pending since. Rows are
 *    claimed (`sending`) under a per-person advisory lock before the send, so
 *    neither an overlapping sweep nor a second process mails them again; an
 *    outcome that cannot be known is recorded `uncertain`, never resent.
 */

/** One email per person per this long, at most. */
export const INBOX_EMAIL_WINDOW_MS = 15 * 60 * 1000;

/**
 * Items already waiting this long when first seen are recorded without an
 * email. An email is a nudge about something new; the first sweep after this
 * ships (or after email is configured) must not mail every person their whole
 * standing backlog, which their inbox already shows.
 */
const BASELINE_AGE_MS = 24 * 60 * 60 * 1000;

/** Most pointers listed in one email; the rest are counted. */
const MAX_LINES = 20;

export function isInboxEmailConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RESEND_API_KEY?.trim());
}

/** A person's inbox-email choice. No row means the default: on. */
export async function readInboxEmailPreference(db: Db, userId: string): Promise<boolean> {
  const row = await db
    .select({ inboxEmail: userNotificationPreferences.inboxEmail })
    .from(userNotificationPreferences)
    .where(eq(userNotificationPreferences.userId, userId))
    .then((rows) => rows[0] ?? null);
  return row?.inboxEmail ?? true;
}

export async function writeInboxEmailPreference(db: Db, userId: string, inboxEmail: boolean): Promise<boolean> {
  await db
    .insert(userNotificationPreferences)
    .values({ userId, inboxEmail })
    .onConflictDoUpdate({
      target: userNotificationPreferences.userId,
      set: { inboxEmail, updatedAt: new Date() },
    });
  return inboxEmail;
}

/** A claimed row older than this was mid-send when its process died. */
const SENDING_LEASE_MS = 10 * 60 * 1000;
/** Definite failures before a notice is given up as `failed`. */
export const MAX_SEND_ATTEMPTS = 5;
/** Backoff after the nth definite failure: base * 2^(n-1). */
const RETRY_BASE_MS = 2 * 60 * 1000;

/** What one email line points at. Every field is a pointer; none is agent text. */
export interface InboxEmailPointer {
  kind: "question" | "approval";
  /** Set by a person at hire. Flattened and escaped. */
  agentName: string | null;
  identifier: string | null;
  /** System vocabulary (e.g. `connector_send`), never payload. Approvals only. */
  approvalType?: string;
  link: string | null;
}

function oneLine(value: string | null | undefined, max: number): string {
  const flat = (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pointerSentence(pointer: InboxEmailPointer): string {
  const who = pointer.agentName ? oneLine(pointer.agentName, 80) || "An agent" : "An agent";
  const what =
    pointer.kind === "question"
      ? "asked you a question"
      : `needs your decision${pointer.approvalType ? ` (${oneLine(pointer.approvalType, 60)})` : ""}`;
  const on = pointer.identifier ? ` on ${oneLine(pointer.identifier, 40)}` : "";
  return `${who} ${what}${on}`;
}

/**
 * The email. Exported for the tests, which pin that it carries pointers only.
 * `InboxEmailPointer` has no field for any agent-written text -- the type is
 * the first guard, the tests the second.
 */
export function renderInboxEmail(input: {
  name: string | null;
  pointers: InboxEmailPointer[];
  appUrl: string | null;
}): { subject: string; text: string; html: string } {
  const count = input.pointers.length;
  const subject =
    count === 1 ? "AgentDash: 1 item is waiting on you" : `AgentDash: ${count} items are waiting on you`;
  const greet = input.name?.trim() ? `Hi ${oneLine(input.name, 80)},` : "Hi,";
  const shown = input.pointers.slice(0, MAX_LINES);
  const hidden = count - shown.length;
  const answerLine =
    "Answer in Claude or Codex — say \"check my AgentDash inbox\" — or in AgentDash" +
    (input.appUrl ? `: ${input.appUrl}` : ".");
  const footer = [
    "This email names the agent and the issue only. The question and its details stay in AgentDash.",
    "To stop these emails, turn off \"Email me when my agents need me\" on your My Agent page in AgentDash.",
  ];

  const text = [
    greet,
    "",
    "Your agents are waiting on you:",
    ...shown.map((pointer) => `  - ${pointerSentence(pointer)}${pointer.link ? `: ${pointer.link}` : ""}`),
    ...(hidden > 0 ? [`  … and ${hidden} more`] : []),
    "",
    answerLine,
    "",
    ...footer,
  ].join("\n");

  const items = shown
    .map((pointer) => {
      const sentence = escapeHtml(pointerSentence(pointer));
      return pointer.link
        ? `<li>${sentence} — <a href="${escapeHtml(pointer.link)}">open</a></li>`
        : `<li>${sentence}</li>`;
    })
    .join("");
  const html = `
    <!doctype html>
    <html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; max-width: 560px; margin: 24px auto; line-height: 1.6;">
      <p>${escapeHtml(greet)}</p>
      <p>Your agents are waiting on you:</p>
      <ul style="padding-left: 20px;">${items}${hidden > 0 ? `<li>… and ${hidden} more</li>` : ""}</ul>
      <p>${escapeHtml(answerLine)}</p>
      <p style="margin-top: 24px; color: #666; font-size: 13px;">${footer.map(escapeHtml).join("<br>")}</p>
    </body></html>
  `.trim();

  return { subject, text, html };
}

type NoticeRow = typeof stewardEmailNotices.$inferSelect;

/**
 * One sweep at a time in this process. Overlap would be harmless -- rows are
 * claimed before sending -- but a slow sweep stacking up behind itself is
 * wasted work. Module-level so every service instance shares it.
 */
let sweepInFlight = false;

export function stewardInboxEmailService(
  db: Db,
  options: {
    send?: (input: SendEmailInput) => Promise<SendEmailResult>;
    isConfigured?: () => boolean;
    /** The instance's public URL, for links. Null means the email has no links. */
    publicBaseUrl?: string | null;
    now?: () => Date;
  } = {},
) {
  const inbox = stewardInboxService(db);
  const accountability = agentAccountabilityService(db);
  const send = options.send ?? defaultSendEmail;
  const isConfigured = options.isConfigured ?? (() => isInboxEmailConfigured());
  const now = options.now ?? (() => new Date());
  const base = options.publicBaseUrl?.replace(/\/+$/, "") || null;
  let loggedUnconfigured = false;

  /** Everyone who answers for at least one agent in a profile company. */
  async function people() {
    const mk = await db
      .select({ id: companies.id, issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.productProfile, "agentdash_mk"));
    const out: Array<{ companyId: string; issuePrefix: string | null; userId: string }> = [];
    for (const company of mk) {
      try {
        const ids = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, company.id));
        if (ids.length === 0) continue;
        const resolved = await accountability.resolveForAgents(company.id, ids.map((row) => row.id));
        const users = new Set<string>();
        for (const value of resolved.values()) if (value?.userId) users.add(value.userId);
        for (const userId of users) out.push({ companyId: company.id, issuePrefix: company.issuePrefix, userId });
      } catch (err) {
        logger.warn({ err, companyId: company.id }, "[inbox-email] could not list a company's stewards");
      }
    }
    return out;
  }

  /** What is waiting on this person now, keyed, with each item's pointer. */
  async function waitingFor(person: { companyId: string; issuePrefix: string | null; userId: string }) {
    const waiting = await inbox.waitingItemsFor({ companyId: person.companyId, userId: person.userId });
    const issueLink = (identifier: string | null) =>
      base && identifier && person.issuePrefix
        ? `${base}/${person.issuePrefix}/issues/${encodeURIComponent(identifier)}`
        : null;
    const items = new Map<string, { kind: "question" | "approval"; refId: string; since: Date; pointer: InboxEmailPointer }>();
    for (const q of waiting.questions) {
      items.set(`question:${q.interactionId}`, {
        kind: "question",
        refId: q.interactionId,
        since: q.waitingSince,
        pointer: { kind: "question", agentName: q.agentName, identifier: q.identifier, link: issueLink(q.identifier) },
      });
    }
    for (const a of waiting.approvals) {
      items.set(`approval:${a.approvalId}:rev${a.revision}`, {
        kind: "approval",
        refId: a.approvalId,
        since: a.waitingSince,
        pointer: {
          kind: "approval",
          agentName: a.agentName,
          identifier: a.identifier,
          approvalType: a.type,
          link: a.identifier
            ? issueLink(a.identifier)
            : base
              ? `${base}/approvals/${encodeURIComponent(a.approvalId)}`
              : null,
        },
      });
    }
    return items;
  }

  /** Record everything newly waiting. Idempotent; one person's failure skips only them. */
  async function detect() {
    const at = now();
    for (const person of await people()) {
      try {
        const items = await waitingFor(person);
        if (items.size === 0) continue;
        await db
          .insert(stewardEmailNotices)
          .values(
            [...items.entries()].map(([refKey, item]) => {
              const baseline = at.getTime() - item.since.getTime() > BASELINE_AGE_MS;
              return {
                companyId: person.companyId,
                userId: person.userId,
                refKey,
                kind: item.kind,
                refId: item.refId,
                status: baseline ? "baseline" : "pending",
                settledAt: baseline ? at : null,
              };
            }),
          )
          .onConflictDoNothing();
      } catch (err) {
        logger.warn({ err, companyId: person.companyId, userId: person.userId }, "[inbox-email] detection failed for one person");
      }
    }
  }

  /** Settle rows still in `from`. Conditional, so a row another sweep moved is left alone. */
  async function settle(ids: string[], from: string, status: string, at: Date) {
    if (ids.length === 0) return;
    await db
      .update(stewardEmailNotices)
      .set({ status, settledAt: at })
      .where(and(inArray(stewardEmailNotices.id, ids), eq(stewardEmailNotices.status, from)));
  }

  /**
   * Claim this person's due rows, or nothing if their window is still open.
   *
   * Under a transaction-scoped advisory lock on the person, so the window
   * check and the claim are one step for every sweep in every process: a
   * second claimant waits, then sees the first one's `sending` rows and
   * claims nothing. The send itself happens outside the transaction.
   */
  async function claim(userId: string, at: Date): Promise<NoticeRow[]> {
    return db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`steward-inbox-email:${userId}`}))`);
      const windowStart = new Date(at.getTime() - INBOX_EMAIL_WINDOW_MS);
      const busy = await tx
        .select({ id: stewardEmailNotices.id })
        .from(stewardEmailNotices)
        .where(
          and(
            eq(stewardEmailNotices.userId, userId),
            or(
              eq(stewardEmailNotices.status, "sending"),
              and(
                inArray(stewardEmailNotices.status, ["sent", "uncertain"]),
                gt(stewardEmailNotices.settledAt, windowStart),
              ),
            ),
          ),
        )
        .limit(1);
      if (busy.length > 0) return [];
      return tx
        .update(stewardEmailNotices)
        .set({ status: "sending", claimedAt: at })
        .where(
          and(
            eq(stewardEmailNotices.userId, userId),
            eq(stewardEmailNotices.status, "pending"),
            or(isNull(stewardEmailNotices.nextAttemptAt), lte(stewardEmailNotices.nextAttemptAt, at)),
          ),
        )
        .returning();
    });
  }

  async function deliverTo(userId: string, at: Date): Promise<boolean> {
    const due = and(
      eq(stewardEmailNotices.userId, userId),
      eq(stewardEmailNotices.status, "pending"),
    );
    if (!(await readInboxEmailPreference(db, userId))) {
      await db.update(stewardEmailNotices).set({ status: "opted_out", settledAt: at }).where(due);
      return false;
    }
    const user = await db
      .select({ name: authUsers.name, email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .then((result) => result[0] ?? null);
    if (!user?.email?.trim()) {
      await db.update(stewardEmailNotices).set({ status: "undeliverable", settledAt: at }).where(due);
      return false;
    }

    const claimed = await claim(userId, at);
    if (claimed.length === 0) return false;

    // Re-read what is waiting now. A notice whose item was answered, decided,
    // or is no longer this person's since it was recorded is not mailed.
    const pointers: InboxEmailPointer[] = [];
    const mailed: string[] = [];
    const stale: string[] = [];
    const byCompany = new Map<string, NoticeRow[]>();
    for (const row of claimed) byCompany.set(row.companyId, [...(byCompany.get(row.companyId) ?? []), row]);
    for (const [companyId, rows] of byCompany) {
      const membership = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .then((result) => result[0] ?? null);
      if (!membership) {
        stale.push(...rows.map((row) => row.id));
        continue;
      }
      const company = await db
        .select({ issuePrefix: companies.issuePrefix })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((result) => result[0] ?? null);
      const current = await waitingFor({ companyId, issuePrefix: company?.issuePrefix ?? null, userId });
      for (const row of rows) {
        const item = current.get(row.refKey);
        if (!item) {
          stale.push(row.id);
          continue;
        }
        pointers.push(item.pointer);
        mailed.push(row.id);
      }
    }
    await settle(stale, "sending", "stale", at);
    if (pointers.length === 0) return false;

    const email = renderInboxEmail({ name: user.name, pointers, appUrl: base });
    let result: SendEmailResult;
    try {
      result = await send({ to: user.email, subject: email.subject, html: email.html, text: email.text });
    } catch (err) {
      // `sendEmail` never throws; an injected sender might. Unknown outcome.
      result = { status: "failed", error: err instanceof Error ? err.message : String(err), ambiguous: true };
    }

    if (result.status === "sent") {
      await settle(mailed, "sending", "sent", at);
      return true;
    }
    if (result.status === "failed" && result.ambiguous) {
      // It may have gone out. At most once: record it as possibly sent, which
      // also starts the window, and never resend it.
      await settle(mailed, "sending", "uncertain", at);
      logger.warn({ userId, notices: mailed.length }, "[inbox-email] send outcome unknown; not retrying");
      return false;
    }
    if (result.status === "skipped") {
      // Email was switched off between the check and the send. Release.
      await db
        .update(stewardEmailNotices)
        .set({ status: "pending", claimedAt: null })
        .where(and(inArray(stewardEmailNotices.id, mailed), eq(stewardEmailNotices.status, "sending")));
      return false;
    }
    // A definite refusal: back off, and give up after the cap.
    for (const row of claimed.filter((value) => mailed.includes(value.id))) {
      const attempts = row.attempts + 1;
      await db
        .update(stewardEmailNotices)
        .set(
          attempts >= MAX_SEND_ATTEMPTS
            ? { status: "failed", attempts, settledAt: at }
            : {
                status: "pending",
                attempts,
                claimedAt: null,
                nextAttemptAt: new Date(at.getTime() + RETRY_BASE_MS * 2 ** (attempts - 1)),
              },
        )
        .where(and(eq(stewardEmailNotices.id, row.id), eq(stewardEmailNotices.status, "sending")));
    }
    logger.warn({ userId, error: result.error }, "[inbox-email] send refused; will retry with backoff");
    return false;
  }

  /** Fold each person's due notices into one email, when their window allows. */
  async function deliver() {
    const at = now();
    // A claim older than its lease belongs to a sweep that died mid-send.
    // The email may have gone; never resend it.
    await db
      .update(stewardEmailNotices)
      .set({ status: "uncertain", settledAt: at })
      .where(
        and(
          eq(stewardEmailNotices.status, "sending"),
          lte(stewardEmailNotices.claimedAt, new Date(at.getTime() - SENDING_LEASE_MS)),
        ),
      );

    const users = await db
      .selectDistinct({ userId: stewardEmailNotices.userId })
      .from(stewardEmailNotices)
      .where(
        and(
          eq(stewardEmailNotices.status, "pending"),
          or(isNull(stewardEmailNotices.nextAttemptAt), lte(stewardEmailNotices.nextAttemptAt, at)),
        ),
      );
    let sent = 0;
    for (const { userId } of users) {
      try {
        if (await deliverTo(userId, at)) sent += 1;
      } catch (err) {
        logger.warn({ err, userId }, "[inbox-email] delivery failed for one person");
      }
    }
    return { sent };
  }

  /**
   * One pass: detect, then deliver -- deliver even when detection failed, so
   * what is already recorded still goes out. Does nothing at all while email
   * is not configured, not even detection, so turning email on later does not
   * mail a backlog (anything older than a day is then recorded as baseline).
   */
  async function sweep(): Promise<{ sent: number; configured: boolean; busy?: boolean }> {
    if (!isConfigured()) {
      if (!loggedUnconfigured) {
        loggedUnconfigured = true;
        logger.info("[inbox-email] RESEND_API_KEY not set — inbox emails are off");
      }
      return { sent: 0, configured: false };
    }
    if (sweepInFlight) return { sent: 0, configured: true, busy: true };
    sweepInFlight = true;
    try {
      try {
        await detect();
      } catch (err) {
        logger.warn({ err }, "[inbox-email] detection failed");
      }
      const { sent } = await deliver();
      return { sent, configured: true };
    } finally {
      sweepInFlight = false;
    }
  }

  return { sweep, detect, deliver };
}
