import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  channelPairingChallenges,
  externalChannelEvents,
  humanChannelBindings,
} from "@paperclipai/db";
import { policyListAllows } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { isUniqueViolation } from "../lib/pg-error.js";
import { agentGovernanceService } from "./agent-governance.js";
import { agentStewardshipService } from "./agent-stewardships.js";
import { logActivity } from "./activity-log.js";

/** Long enough to open a link on another device, short enough to matter. */
const PAIRING_CHALLENGE_TTL_MS = 15 * 60 * 1000;

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
  const governance = agentGovernanceService(db);

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

    // AgentDash-MK: a binding is the delivery path for that agent's approval
    // cards, so the agent's own provider ceiling decides which channels may
    // carry them. Keyed to the stewarded agent because the binding is only
    // meaningful in relation to it — the row above already established that
    // pairing, and it is the same agent recorded in `agentId` below.
    //
    // `resolveAgentPolicy` is null outside the profile, so default-profile
    // companies bind exactly as before.
    const policy = await governance.resolveAgentPolicy(companyId, active.agentId);
    if (policy && !policyListAllows(policy.providers, input.provider)) {
      throw forbidden(
        `The owner ceiling for this agent does not allow ${input.provider}; ` +
          "an administrator must widen it before this channel can be paired",
      );
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

  // -------------------------------------------------------------------------
  // Pairing ceremony
  //
  // Provider-generic: Telegram carries the token in a `?start=` deep link,
  // WhatsApp in a template quick-reply, Teams in an install link. All three get
  // the same expiry, single-use, and replacement rules from one implementation
  // rather than three that drift apart.
  // -------------------------------------------------------------------------

  /**
   * Mint a single-use pairing token for a human.
   *
   * Any outstanding challenge for the same (company, provider, human) is
   * consumed first. A user who abandons a pairing and starts over must not
   * leave a second live token behind — the first one already travelled through
   * a channel someone else may have seen.
   */
  async function mintPairingChallenge(
    companyId: string,
    input: { userId: string; provider: string; ttlMs?: number },
  ): Promise<{ token: string; expiresAt: Date }> {
    const active = await stewardships.activeByUser(companyId, input.userId);
    if (!active) {
      throw conflict("Channel pairing requires an active stewarded agent");
    }

    // Same ceiling gate as verifyBinding, applied at mint time so the refusal
    // arrives when the user asks rather than after they open the deep link.
    const policy = await governance.resolveAgentPolicy(companyId, active.agentId);
    if (policy && !policyListAllows(policy.providers, input.provider)) {
      throw forbidden(
        `The owner ceiling for this agent does not allow ${input.provider}; ` +
          "an administrator must widen it before this channel can be paired",
      );
    }

    const now = new Date();
    await db
      .update(channelPairingChallenges)
      .set({ consumedAt: now })
      .where(
        and(
          eq(channelPairingChallenges.companyId, companyId),
          eq(channelPairingChallenges.provider, input.provider),
          eq(channelPairingChallenges.userId, input.userId),
          isNull(channelPairingChallenges.consumedAt),
        ),
      );

    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? PAIRING_CHALLENGE_TTL_MS));
    await db.insert(channelPairingChallenges).values({
      token,
      companyId,
      userId: input.userId,
      provider: input.provider,
      expiresAt,
      createdAt: now,
    });
    return { token, expiresAt };
  }

  /**
   * Read a live challenge WITHOUT consuming it.
   *
   * The webhook needs the company id before it can claim the inbound event for
   * deduplication, and claiming has to happen before consuming — otherwise a
   * provider redelivery would find the token already spent and report a failed
   * pairing for a pairing that in fact succeeded.
   */
  async function peekPairingChallenge(provider: string, token: string) {
    return db
      .select()
      .from(channelPairingChallenges)
      .where(
        and(
          eq(channelPairingChallenges.provider, provider),
          eq(channelPairingChallenges.token, token),
          isNull(channelPairingChallenges.consumedAt),
          gt(channelPairingChallenges.expiresAt, new Date()),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Atomically spend a challenge. Returns null if it was already spent or has
   * expired — the conditional UPDATE is the claim, so two concurrent
   * redemptions cannot both win.
   */
  async function consumePairingChallenge(provider: string, token: string) {
    return db
      .update(channelPairingChallenges)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(channelPairingChallenges.provider, provider),
          eq(channelPairingChallenges.token, token),
          isNull(channelPairingChallenges.consumedAt),
          gt(channelPairingChallenges.expiresAt, new Date()),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
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
    mintPairingChallenge,
    peekPairingChallenge,
    consumePairingChallenge,
    resolveActiveBinding,
    listForCompany,
    revokeBinding,
    claimEvent,
    markEventProcessed,
  };
}
