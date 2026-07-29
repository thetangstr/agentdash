import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { externalChannelEvents, humanChannelBindings } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { isUniqueViolation } from "../lib/pg-error.js";
import { agentStewardshipService } from "./agent-stewardships.js";
import { logActivity } from "./activity-log.js";

type HumanChannelBindingRow = typeof humanChannelBindings.$inferSelect;

export interface VerifyBindingInput {
  provider: string;
  /** Durable principal id, never a request-supplied display name. */
  userId: string;
  externalTenantId?: string | null;
  externalUserId: string;
  externalConversationId?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function humanChannelService(db: Db) {
  const stewardships = agentStewardshipService(db);

  /**
   * Complete a verified pairing ceremony.
   *
   * The binding is anchored to the agent the human currently stewards: a
   * channel exists so a person can act for THEIR agent, so pairing a human who
   * stewards nothing has no meaning and is refused rather than left dangling.
   */
  async function verifyBinding(
    companyId: string,
    input: VerifyBindingInput,
  ): Promise<HumanChannelBindingRow> {
    const active = await stewardships.activeByUser(companyId, input.userId);
    if (!active) {
      throw conflict("Channel binding requires an active stewarded agent");
    }

    const now = new Date();
    try {
      return await db
        .insert(humanChannelBindings)
        .values({
          companyId,
          userId: input.userId,
          agentId: active.agentId,
          provider: input.provider,
          externalTenantId: input.externalTenantId ?? null,
          externalUserId: input.externalUserId,
          externalConversationId: input.externalConversationId ?? null,
          metadata: input.metadata ?? null,
          verifiedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Either this provider identity is already bound to someone here, or
        // this human already holds an active binding. Both require an explicit
        // revocation first — a silent takeover would let one person inherit
        // another's channel.
        throw conflict(
          "An active binding already exists for this provider identity or user; revoke it first",
        );
      }
      throw error;
    }
  }

  /** Inbound dispatch and outbound send both go through this. */
  async function resolveActiveBinding(provider: string, externalUserId: string) {
    return db
      .select()
      .from(humanChannelBindings)
      .where(
        and(
          eq(humanChannelBindings.provider, provider),
          eq(humanChannelBindings.externalUserId, externalUserId),
          isNull(humanChannelBindings.revokedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function listForCompany(companyId: string) {
    return db
      .select()
      .from(humanChannelBindings)
      .where(eq(humanChannelBindings.companyId, companyId));
  }

  async function revokeBinding(
    companyId: string,
    bindingId: string,
    actor: { actorUserId: string | null },
  ) {
    const now = new Date();
    const revoked = await db
      .update(humanChannelBindings)
      .set({ revokedAt: now, revokedByUserId: actor.actorUserId, updatedAt: now })
      .where(
        and(
          eq(humanChannelBindings.id, bindingId),
          eq(humanChannelBindings.companyId, companyId),
          isNull(humanChannelBindings.revokedAt),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!revoked) throw notFound("Active channel binding not found");

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.actorUserId ?? "board",
      action: "human_channel.binding_revoked",
      entityType: "human_channel_binding",
      entityId: revoked.id,
      agentId: revoked.agentId,
      details: { provider: revoked.provider },
    });

    return revoked;
  }

  /**
   * A channel grants a person a path to act for an agent, so it must not
   * outlive their stewardship of it.
   */
  async function revokeBindingsForEndedStewardship(
    companyId: string,
    userId: string,
    actor: { actorUserId: string | null },
  ) {
    const now = new Date();
    const revoked = await db
      .update(humanChannelBindings)
      .set({ revokedAt: now, revokedByUserId: actor.actorUserId, updatedAt: now })
      .where(
        and(
          eq(humanChannelBindings.companyId, companyId),
          eq(humanChannelBindings.userId, userId),
          isNull(humanChannelBindings.revokedAt),
        ),
      )
      .returning();

    for (const binding of revoked) {
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actor.actorUserId ?? "board",
        action: "human_channel.binding_revoked",
        entityType: "human_channel_binding",
        entityId: binding.id,
        agentId: binding.agentId,
        details: { provider: binding.provider, reason: "stewardship_ended" },
      });
    }

    return revoked;
  }

  /**
   * Exactly-once claim for an inbound provider event.
   *
   * The unique index does the work, not a read-then-write: providers redeliver
   * aggressively and concurrently, so a check-then-insert would let duplicates
   * through under exactly the load that makes redelivery likely.
   */
  async function claimEvent(
    provider: string,
    companyId: string,
    externalEventId: string,
    payloadDigest?: string | null,
    input: { eventType?: string | null; bindingId?: string | null; approvalRevision?: number | null } = {},
  ): Promise<{ claimed: boolean; eventId: string | null }> {
    const inserted = await db
      .insert(externalChannelEvents)
      .values({
        companyId,
        provider,
        externalEventId,
        eventType: input.eventType ?? null,
        bindingId: input.bindingId ?? null,
        approvalRevision: input.approvalRevision ?? null,
        payloadDigest: payloadDigest ?? null,
      })
      .onConflictDoNothing()
      .returning()
      .then((rows) => rows[0] ?? null);

    return inserted ? { claimed: true, eventId: inserted.id } : { claimed: false, eventId: null };
  }

  async function markEventProcessed(eventId: string, state: "processed" | "failed") {
    return db
      .update(externalChannelEvents)
      .set({ processingState: state, processedAt: new Date() })
      .where(eq(externalChannelEvents.id, eventId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  return {
    verifyBinding,
    resolveActiveBinding,
    listForCompany,
    revokeBinding,
    revokeBindingsForEndedStewardship,
    claimEvent,
    markEventProcessed,
  };
}
