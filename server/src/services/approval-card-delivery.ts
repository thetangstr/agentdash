import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, humanChannelBindings } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { agentStewardshipService } from "./agent-stewardships.js";
import { telegramConnectorService } from "./telegram-connector.js";

/**
 * AgentDash-MK: push an approval card to the deciding steward's channels.
 *
 * The decision path was built first and completely — a card, once delivered,
 * resolves through the shared authority service with revision and replay
 * checks. Nothing delivered one. `buildApprovalKeyboard` had no caller outside
 * its own tests, so a steward who had paired Telegram would still only ever see
 * approvals in the web app. This is the missing half.
 *
 * Design rules, in order of how much they matter:
 *
 * 1. **Verified bindings only.** An unverified binding names a provider
 *    identity nobody has proven control of; delivering to it hands the approval
 *    to whoever holds that account.
 * 2. **The steward, not the company.** Only the human who can actually decide
 *    gets a card. Sending to anyone else produces a button the server refuses.
 * 3. **Never throws.** Delivery is a side effect of creating an approval. A
 *    provider outage must not fail the request that created it, or an
 *    unreachable Telegram takes the whole governed-action flow down with it.
 */

/** Statuses where a decision is still possible, so a card is still useful. */
const DELIVERABLE_STATUSES = new Set(["pending", "revision_requested"]);

export function approvalCardDeliveryService(db: Db) {
  const stewardships = agentStewardshipService(db);
  const telegram = telegramConnectorService(db);

  function summarize(approval: typeof approvals.$inferSelect, agentName: string | null) {
    const payload = (approval.payload ?? {}) as Record<string, unknown>;
    const summary =
      typeof payload.summary === "string" && payload.summary.trim().length > 0
        ? payload.summary.trim()
        : approval.type.replace(/_/g, " ");
    const who = agentName ? `${agentName} requests` : "A request needs your decision";
    // Deliberately terse and payload-light. Approval payloads carry
    // adapterConfig and similar material; a channel message is the least
    // controlled surface in the system, so it names the ask and nothing else.
    return `${who}: ${summary}\n\nRevision ${approval.revision}. Decide here or in AgentDash.`;
  }

  /**
   * Deliver a card for one approval to every eligible channel.
   *
   * Idempotency is deliberately NOT enforced here. Calling twice mints a second
   * pair of tokens and sends a second card, which is the correct behavior for a
   * resubmit (a new revision needs a new card, and the old one is already dead
   * because its revision no longer matches). Guarding against duplicate sends
   * for the SAME revision belongs at the call site, which knows whether this is
   * a create or a retry.
   */
  async function deliverForApproval(approvalId: string): Promise<void> {
    try {
      const approval = await db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .then((rows) => rows[0] ?? null);
      if (!approval) return;
      if (!DELIVERABLE_STATUSES.has(approval.status)) return;

      const company = await db
        .select({ productProfile: companies.productProfile })
        .from(companies)
        .where(eq(companies.id, approval.companyId))
        .then((rows) => rows[0] ?? null);
      if (company?.productProfile !== "agentdash_mk") return;

      // No requesting agent means no steward to route to; those approvals are
      // administrator business and live on the Override screen.
      if (!approval.requestedByAgentId) return;

      const active = await stewardships.activeByAgent(
        approval.companyId,
        approval.requestedByAgentId,
      );
      if (!active) return;

      const bindings = await db
        .select()
        .from(humanChannelBindings)
        .where(
          and(
            eq(humanChannelBindings.companyId, approval.companyId),
            eq(humanChannelBindings.userId, active.userId),
            isNotNull(humanChannelBindings.verifiedAt),
            isNull(humanChannelBindings.revokedAt),
          ),
        );
      if (bindings.length === 0) return;

      const agent = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, approval.requestedByAgentId))
        .then((rows) => rows[0] ?? null);
      const text = summarize(approval, agent?.name ?? null);

      for (const binding of bindings) {
        // One failing channel must not stop the others: a steward with Telegram
        // and WhatsApp paired should still hear about it on the one that works.
        try {
          await deliverToBinding(binding, approval, text);
        } catch (error) {
          logger.warn(
            { err: error, approvalId, provider: binding.provider, bindingId: binding.id },
            "approval card delivery failed for one binding",
          );
        }
      }
    } catch (error) {
      logger.warn({ err: error, approvalId }, "approval card delivery failed");
    }
  }

  async function deliverToBinding(
    binding: typeof humanChannelBindings.$inferSelect,
    approval: typeof approvals.$inferSelect,
    text: string,
  ) {
    if (binding.provider === "telegram") {
      const chatId = binding.externalConversationId ?? binding.externalUserId;
      const keyboard = await telegram.buildApprovalKeyboard({
        companyId: approval.companyId,
        approvalId: approval.id,
        revision: approval.revision,
        bindingId: binding.id,
      });
      await telegram.sendApprovalCard(chatId, text, keyboard);
      return;
    }

    // Providers without a delivery implementation are skipped rather than
    // silently treated as delivered. The log line is the record that a paired
    // steward did NOT receive this card.
    logger.info(
      { provider: binding.provider, approvalId: approval.id },
      "no approval card delivery implemented for this provider",
    );
  }

  return { deliverForApproval };
}
