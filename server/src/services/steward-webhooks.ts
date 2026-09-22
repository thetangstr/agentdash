import { and, eq, isNull, max } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, stewardInboxEvents, stewardWebhooks } from "@paperclipai/db";
import { badRequest, conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./index.js";
import { stewardInboxService } from "./steward-inbox.js";

/**
 * AgentDash-MK: push the steward inbox to a webhook, bot-free.
 *
 * Two stewards independently built pollers because nothing pushed; the second
 * iteration of one of them then asked for Board access so an agent could
 * record decisions parsed out of Teams channel text. This service is the
 * sanctioned shape of the first need and the standing refusal of the second:
 *
 *  - It POSTs the same ask-and-pointer digest the inbox renders. Never a
 *    payload, never a decision handle — a channel's audience is wider than
 *    the steward, and the digest is the only content already written for
 *    that exposure.
 *  - It decides nothing and enables no deciding. The message deep-links to
 *    the approvals page, and the page is where deciding stays until a
 *    transport exists that can prove who is talking (the dormant bot-based
 *    card path, when a customer provisions it).
 *  - It is the steward's own: registered by them for themselves, visible on
 *    their page, revocable per destination. Same consent shape as a bridge
 *    endpoint.
 *
 * Delivery reuses the inbox's gap-free `seq` as a cursor per webhook: the
 * sweep posts when the log has advanced and moves the cursor only on a 2xx,
 * so a failed delivery retries with the same window and no update is lost.
 * The content is the CURRENT digest, not an event replay — "what needs you
 * now", the same deliberate choice the inbox itself makes.
 */

const CHALLENGE_TIMEOUT_MS = 15_000;
const DELIVER_TIMEOUT_MS = 15_000;
const MAX_URL_LENGTH = 2000;

export interface StewardWebhookDigest {
  agentsAnsweredFor: number;
  approvals: { total: number; shown: number; items: Array<{ type: string; agentName: string | null; revision: number; risk: { level: string; reason: string }; waitingSince: string }> };
  blockers: { total: number; shown: number; items: Array<{ identifier: string | null; title: string; agentName: string | null }> };
  completions: { total: number; shown: number; items: Array<{ identifier: string | null; title: string; agentName: string | null }> };
}

/** "and 4 more" — never silently. A shown list that hides its total lies. */
function remainder(section: { total: number; shown: number }): string {
  const hidden = section.total - section.shown;
  return hidden > 0 ? `  … and ${hidden} more (${section.total} in total)` : "";
}

function issueLine(item: { identifier: string | null; title: string; agentName: string | null }) {
  const ref = item.identifier ? `${item.identifier} ` : "";
  const who = item.agentName ? ` (${item.agentName})` : "";
  return `  - ${ref}${item.title}${who}`;
}

/**
 * The webhook message. Mirrors the inbox render's contract — owner named in
 * the heading, decisions then blockers then completions, remainder lines —
 * and differs in exactly two deliberate ways: no handles can appear because
 * the digest never carries them, and the closing line is a link because the
 * reader is in a chat client, not a session with tools.
 */
export function renderStewardWebhookMessage(input: {
  ownerName: string | null;
  digest: StewardWebhookDigest;
  approvalsUrl: string | null;
}): string {
  const heading = input.ownerName ? `AgentDash inbox — ${input.ownerName}` : "AgentDash inbox";
  const { digest } = input;
  const lines: string[] = [heading, ""];

  if (digest.approvals.total > 0) {
    lines.push(`Waiting on your decision (${digest.approvals.total}):`);
    for (const item of digest.approvals.items) {
      const who = item.agentName ? `${item.agentName} — ` : "";
      lines.push(`  - ${who}${item.type} [${item.risk.level}: ${item.risk.reason}], rev ${item.revision}`);
    }
    const more = remainder(digest.approvals);
    if (more) lines.push(more);
    lines.push("");
  }
  if (digest.blockers.total > 0) {
    lines.push(`Stopped and needs you (${digest.blockers.total}):`);
    for (const item of digest.blockers.items) lines.push(issueLine(item));
    const more = remainder(digest.blockers);
    if (more) lines.push(more);
    lines.push("");
  }
  if (digest.completions.total > 0) {
    lines.push(`Finished (${digest.completions.total}):`);
    for (const item of digest.completions.items) lines.push(issueLine(item));
    const more = remainder(digest.completions);
    if (more) lines.push(more);
    lines.push("");
  }

  lines.push(
    input.approvalsUrl
      ? `Decide on your AgentDash page: ${input.approvalsUrl}`
      : "Decide on your AgentDash page.",
  );
  lines.push("This carries the ask and a pointer — never the evidence.");
  return lines.join("\n").trimEnd();
}

function validateWebhookUrl(raw: string): string {
  const url = raw.trim();
  if (!url || url.length > MAX_URL_LENGTH) throw badRequest("A webhook URL is required (max 2000 characters).");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequest("That is not a valid URL.");
  }
  // https only: the URL is a channel-posting secret and the digest names
  // agents and issue titles; neither should transit in the clear.
  if (parsed.protocol !== "https:") throw badRequest("Webhook URLs must be https.");
  return url;
}

/**
 * Teams "Workflows" webhooks (Power Automate) return 202 for ANY body and then
 * silently drop everything that is not a `type: "message"` envelope carrying
 * an Adaptive Card — plain `{text}` is accepted on the wire and never posts.
 * Diagnosed live 2026-09-22: the challenge and every digest 202'd into the
 * void. Detection is by host: Power Automate trigger URLs live on
 * *.powerplatform.com (current) and *.logic.azure.com (older flows); every
 * other receiver (Slack-style incoming webhooks) keeps plain `{text}`.
 *
 * Inside the card each line becomes its own TextBlock (TextBlock swallows
 * bare newlines), and raw URLs become markdown links so the deep link stays
 * tappable.
 */
export function webhookBodyFor(url: string, text: string): string {
  const host = new URL(url).hostname;
  const isPowerAutomate = host.endsWith(".powerplatform.com") || host.endsWith(".logic.azure.com");
  if (!isPowerAutomate) return JSON.stringify({ text });
  const deepLink = text.match(/https?:\/\/\S+/)?.[0] ?? null;
  return JSON.stringify({
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard",
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          version: "1.4",
          body: text.split("\n").map((line, index) => ({
            type: "TextBlock",
            text: line === "" ? "\u00A0" : line.replace(/(https?:\/\/\S+)/g, "[$1]($1)"),
            wrap: true,
            spacing: index === 0 ? "Default" : line === "" ? "Small" : "None",
          })),
          // A pointer, never a decision: OpenUrl is the ONLY action kind this
          // card may carry. A Submit/Execute action would come back through
          // the flow with no verified sender — the exact thing this transport
          // is forbidden to do. In-card Approve waits for the bot path.
          actions: deepLink ? [{ type: "Action.OpenUrl", title: "Decide on AgentDash", url: deepLink }] : [],
        },
      },
    ],
  });
}

export function stewardWebhooksService(db: Db, deps: { fetchImpl?: typeof fetch } = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const inbox = stewardInboxService(db);

  async function ownerName(userId: string): Promise<string | null> {
    const row = await db
      .select({ name: authUsers.name, email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .then((rows) => rows[0] ?? null);
    return row?.name ?? row?.email ?? null;
  }

  /**
   * Register and verify in one motion. The challenge POST is the verification:
   * a URL that cannot receive a message is a registration that would silently
   * eat every notification after it, so an unanswerable URL is refused here,
   * to the person's face, rather than discovered by their absence of news.
   */
  async function register(input: { companyId: string; userId: string; url: string; label: string }) {
    const url = validateWebhookUrl(input.url);
    const label = input.label.trim() || "Teams channel";

    const name = await ownerName(input.userId);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: webhookBodyFor(
          url,
          `AgentDash: inbox delivery for ${name ?? "this steward"} is being connected. If you did not expect this, whoever holds this webhook URL is registering it right now.`,
        ),
        signal: AbortSignal.timeout(CHALLENGE_TIMEOUT_MS),
      });
    } catch (error) {
      throw badRequest(
        `The webhook did not answer (${error instanceof Error ? error.message : String(error)}). Nothing was registered.`,
      );
    }
    if (!response.ok) {
      throw badRequest(`The webhook refused the test message (HTTP ${response.status}). Nothing was registered.`);
    }

    /**
     * Start the cursor at the current head: registering a webhook means "tell
     * me what happens from now on", not "replay everything my agents ever
     * did into this channel".
     */
    const head = await db
      .select({ head: max(stewardInboxEvents.seq) })
      .from(stewardInboxEvents)
      .where(
        and(
          eq(stewardInboxEvents.companyId, input.companyId),
          eq(stewardInboxEvents.stewardUserId, input.userId),
        ),
      )
      .then((rows) => rows[0]?.head ?? 0);

    let row;
    try {
      row = await db
        .insert(stewardWebhooks)
        .values({
          companyId: input.companyId,
          userId: input.userId,
          label,
          url,
          verifiedAt: new Date(),
          lastDeliveredSeq: head ?? 0,
        })
        .returning()
        .then((rows) => rows[0]!);
    } catch (error) {
      if ((error as { code?: string }).code === "23505" || /duplicate key/i.test(String((error as Error).message))) {
        throw conflict("That webhook is already registered. Revoke it before registering it again.");
      }
      throw error;
    }

    await logActivity(db, {
      companyId: input.companyId,
      actorType: "user",
      actorId: input.userId,
      action: "steward_webhook.registered",
      entityType: "steward_webhook",
      entityId: row.id,
      details: { label },
    });
    return { id: row.id, label: row.label, verifiedAt: row.verifiedAt };
  }

  async function listForUser(companyId: string, userId: string) {
    const rows = await db
      .select()
      .from(stewardWebhooks)
      .where(
        and(
          eq(stewardWebhooks.companyId, companyId),
          eq(stewardWebhooks.userId, userId),
          isNull(stewardWebhooks.revokedAt),
        ),
      );
    // The URL is a posting secret; the list never returns it whole.
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      urlHint: `${new URL(row.url).host}…`,
      verifiedAt: row.verifiedAt,
      lastDeliveredAt: row.lastDeliveredAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
    }));
  }

  async function revoke(companyId: string, userId: string, webhookId: string) {
    const now = new Date();
    const updated = await db
      .update(stewardWebhooks)
      .set({ revokedAt: now, revokedByUserId: userId, updatedAt: now })
      .where(
        and(
          eq(stewardWebhooks.id, webhookId),
          eq(stewardWebhooks.companyId, companyId),
          eq(stewardWebhooks.userId, userId),
          isNull(stewardWebhooks.revokedAt),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw notFound("Webhook not found");
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: "steward_webhook.revoked",
      entityType: "steward_webhook",
      entityId: webhookId,
      details: { label: updated.label },
    });
    return { ok: true as const };
  }

  /**
   * One pass over every live webhook. Cheap when nothing changed: one max(seq)
   * comparison per webhook, and only an advanced log builds a digest and
   * posts. Failures never throw out of the sweep — a broken webhook is that
   * steward's problem to see (lastError on their list), not an outage for
   * everyone else's deliveries.
   */
  async function sweep(options: { approvalsBaseUrl?: string | null } = {}) {
    const hooks = await db
      .select()
      .from(stewardWebhooks)
      .where(isNull(stewardWebhooks.revokedAt));

    let delivered = 0;
    for (const hook of hooks) {
      if (!hook.verifiedAt) continue;
      try {
        const head = await db
          .select({ head: max(stewardInboxEvents.seq) })
          .from(stewardInboxEvents)
          .where(
            and(
              eq(stewardInboxEvents.companyId, hook.companyId),
              eq(stewardInboxEvents.stewardUserId, hook.userId),
            ),
          )
          .then((rows) => rows[0]?.head ?? 0);
        if ((head ?? 0) <= hook.lastDeliveredSeq) continue;

        // The digest's shape is owned by steward-inbox; its empty branch types
        // items loosely. The renderer's tests pin the fields it actually reads.
        // id: null — the handle-less digest. A webhook must never cause
        // decision handles to be minted; see buildDigest's contract.
        const digest = (await inbox.buildDigest({
          id: null,
          companyId: hook.companyId,
          userId: hook.userId,
        })) as StewardWebhookDigest;
        const name = await ownerName(hook.userId);
        const prefix = await db
          .select({ issuePrefix: companies.issuePrefix })
          .from(companies)
          .where(eq(companies.id, hook.companyId))
          .then((rows) => rows[0]?.issuePrefix ?? null);
        const approvalsUrl =
          options.approvalsBaseUrl && prefix
            ? `${options.approvalsBaseUrl.replace(/\/+$/, "")}/${prefix}/approvals`
            : options.approvalsBaseUrl ?? null;

        const text = renderStewardWebhookMessage({ ownerName: name, digest, approvalsUrl });

        const now = new Date();
        const response = await fetchImpl(hook.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: webhookBodyFor(hook.url, text),
          signal: AbortSignal.timeout(DELIVER_TIMEOUT_MS),
        });
        if (response.ok) {
          delivered += 1;
          await db
            .update(stewardWebhooks)
            .set({ lastDeliveredSeq: head!, lastDeliveredAt: now, lastAttemptAt: now, lastError: null, updatedAt: now })
            .where(eq(stewardWebhooks.id, hook.id));
        } else {
          await db
            .update(stewardWebhooks)
            .set({ lastAttemptAt: now, lastError: `HTTP ${response.status}`, updatedAt: now })
            .where(eq(stewardWebhooks.id, hook.id));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ err: error, webhookId: hook.id }, "steward webhook delivery failed");
        await db
          .update(stewardWebhooks)
          .set({ lastAttemptAt: new Date(), lastError: message.slice(0, 300), updatedAt: new Date() })
          .where(eq(stewardWebhooks.id, hook.id))
          .catch(() => {});
      }
    }
    return { delivered };
  }

  return { register, listForUser, revoke, sweep };
}
