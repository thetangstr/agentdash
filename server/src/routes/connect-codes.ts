// Redeeming a connect code: the one endpoint in this flow that is public.
//
// POST /api/connect/redeem is UNAUTHENTICATED by necessity — the caller is a
// machine that has no credential yet; acquiring one is the entire point. What
// makes that safe is not authentication but the shape of the secret it accepts:
//
//   1. The code lives for ten minutes and dies on first use, so a leaked one is
//      worth almost nothing almost immediately.
//   2. Redemption is a single conditional UPDATE, so two machines racing the
//      same code cannot both come away with a key.
//   3. The auth-tier rate limiter is mounted on the route itself, because an
//      eight-character code is only unguessable while guessing stays expensive.
//   4. Every failure — unknown, expired, already used, revoked, agent since
//      deleted — answers with one identical message. Distinguishing them would
//      turn this into an oracle that tells an attacker which codes exist.
//
// What comes back is a device-scoped key named for the machine that redeemed
// it, so an administrator can later revoke one laptop without disturbing
// anyone else's.

import { Router } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agentConnectCodes, agents, authUsers, companies } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { createAuthRateLimiter } from "../middleware/rate-limit.js";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "../services/index.js";
import { agentService } from "../services/agents.js";
import { bridgeService } from "../services/bridge.js";
import { STEWARD_INBOX_CAPABILITY } from "../services/steward-inbox.js";
import {
  hashConnectCode,
  isWellFormedConnectCode,
  sanitizeDeviceName,
} from "../lib/connect-codes.js";

/**
 * One message for every failure. See the header: anything more specific tells
 * a caller which codes are real.
 */
const REDEEM_FAILURE = "That code is not valid. Codes expire after ten minutes and can only be used once.";

const redeemSchema = z.object({
  code: z.string().min(1).max(64),
  deviceName: z.string().max(200).optional().nullable(),
});

export function connectCodeRoutes(db: Db, opts: { deploymentMode: DeploymentMode }) {
  const router = Router();
  const svc = agentService(db);
  const bridge = bridgeService(db);

  /**
   * The other half of connecting a machine: the credential that lets the
   * agent's questions reach the person.
   *
   * A connect code used to mint only an agent API key. That key is the agent's
   * own identity — it drives the control plane — and every `/bridge/*` route
   * refuses it, because letting an agent's credential read its steward's inbox
   * and receive decision handles would hand the agent authority over the very
   * approvals meant to constrain it. The inbox needs a SECOND credential, a
   * bridge endpoint bound to the PERSON: their machine, their inbox, their
   * decisions.
   *
   * There used to be a button that minted one. It was deleted when the connect
   * page was consolidated, which left `bridge:inbox` capable of being granted
   * and nothing capable of asking — the onboarding copy promised "the question
   * lands in your Claude Code" over a path with no way to create its
   * credential. Found by a steward who traced both 403s to their causes.
   *
   * So the code now delegates for both. The person who created it did so from
   * their signed-in session, deliberately, to connect THEIR machine — the code
   * IS their authorization, time-boxed to ten minutes and spent on first use.
   * The endpoint binds to the code's creator, never to the redeeming caller,
   * who is unauthenticated. Self-approval here is the same authority the old
   * button exercised: request and approve were both the steward's own acts.
   *
   * Failure is deliberately non-fatal, matching everything else in this file:
   * a pairing that worked must not fail because the inbox half did.
   */
  async function mintBridgeEndpointForCodeCreator(input: {
    companyId: string;
    createdByUserId: string | null;
    deviceName: string;
  }): Promise<{ endpointId: string; token: string } | null> {
    if (!input.createdByUserId) return null;
    const capabilities = ["bridge:read", STEWARD_INBOX_CAPABILITY];
    // Labels are unique per user. The same laptop redeeming a second code is
    // the common collision, so retry once with a discriminating suffix rather
    // than failing the whole pairing over a name.
    const labels = [input.deviceName, `${input.deviceName} (${Date.now().toString(36)})`];
    for (const label of labels) {
      try {
        const { enrollmentId } = await bridge.requestEnrollment(input.companyId, {
          userId: input.createdByUserId,
          label,
          capabilities,
        });
        const approved = await bridge.approveEnrollment(
          input.companyId,
          enrollmentId,
          input.createdByUserId,
        );
        return { endpointId: approved.endpointId, token: approved.token };
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 409) continue; // label taken — try the suffixed one
        logger.warn({ err, companyId: input.companyId }, "connect code redeemed but bridge endpoint minting failed");
        return null;
      }
    }
    logger.warn({ companyId: input.companyId }, "connect code redeemed but both endpoint labels collided");
    return null;
  }

  router.post(
    "/connect/redeem",
    createAuthRateLimiter({ deploymentMode: opts.deploymentMode }),
    validate(redeemSchema),
    async (req, res) => {
      const submitted = String(req.body.code ?? "");

      // Reject malformed input before touching the database. This is cheap
      // rather than revealing: length and alphabet are public knowledge, and
      // it keeps junk from occupying a connection slot on a public endpoint.
      if (!isWellFormedConnectCode(submitted)) {
        res.status(400).json({ error: REDEEM_FAILURE });
        return;
      }

      const deviceName = sanitizeDeviceName(req.body.deviceName);
      const codeHash = hashConnectCode(submitted);
      const now = new Date();

      // Claim the code and mint the key in one transaction. The UPDATE is the
      // lock: only the caller whose statement flips redeemed_at from NULL gets
      // a row back, so a race resolves to exactly one winner without an
      // advisory lock or a read-then-write window.
      const claimed = await db
        .update(agentConnectCodes)
        .set({ redeemedAt: now, redeemedDeviceName: deviceName, updatedAt: now })
        .where(
          and(
            eq(agentConnectCodes.codeHash, codeHash),
            isNull(agentConnectCodes.redeemedAt),
            isNull(agentConnectCodes.revokedAt),
            sql`${agentConnectCodes.expiresAt} > now()`,
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!claimed) {
        res.status(400).json({ error: REDEEM_FAILURE });
        return;
      }

      const agent = await db
        .select({
          id: agents.id,
          name: agents.name,
          companyId: agents.companyId,
          status: agents.status,
          runtimeConfig: agents.runtimeConfig,
          lastHeartbeatAt: agents.lastHeartbeatAt,
        })
        .from(agents)
        .where(eq(agents.id, claimed.agentId))
        .then((rows) => rows[0] ?? null);

      // The agent can be deleted or terminated between minting and redeeming.
      // The code is already spent by the UPDATE above, which is the correct
      // outcome — it must not become reusable because this attempt failed.
      if (!agent || agent.status === "terminated") {
        res.status(400).json({ error: REDEEM_FAILURE });
        return;
      }

      let issued;
      try {
        issued = await svc.createApiKey(agent.id, `${agent.name} — ${deviceName}`, {
          source: "connect_code",
          createdByUserId: (claimed as { createdByUserId?: string | null }).createdByUserId ?? null,
        });
      } catch (err) {
        logger.error({ err, agentId: agent.id }, "connect code redeemed but key minting failed");
        res.status(500).json({ error: "Could not issue a key for this agent. Ask for a new code." });
        return;
      }

      await db
        .update(agentConnectCodes)
        .set({ issuedApiKeyId: issued.id, updatedAt: new Date() })
        .where(eq(agentConnectCodes.id, claimed.id));

      /*
       * Wake an agent that has been waiting for a harness.
       *
       * An agent provisioned for somebody -- rather than created by them --
       * starts with its heartbeat off, because switching it on before anyone
       * has connected a harness only produces failing runs. Redeeming a connect
       * code is exactly the moment that stops being true: a machine has just
       * paired with it. Leaving it off here is what makes a new member's first
       * agent look broken -- it has a key, it has an identity, and it never
       * does anything.
       *
       * Narrow on purpose. Only an agent that has NEVER run is switched on, so
       * this can never resurrect one somebody deliberately quietened. A paused
       * or terminated agent is already refused above.
       */
      const runtimeConfig = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
      const heartbeat = (runtimeConfig.heartbeat ?? {}) as Record<string, unknown>;
      if (heartbeat.enabled !== true && agent.lastHeartbeatAt === null) {
        await db
          .update(agents)
          .set({
            runtimeConfig: { ...runtimeConfig, heartbeat: { ...heartbeat, enabled: true } },
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agent.id))
          .catch((err: unknown) => {
            // A pairing that worked must not fail because this did.
            logger.warn({ err, agentId: agent.id }, "could not enable heartbeat on first pairing");
          });
      }

      const company = await db
        .select({ name: companies.name })
        .from(companies)
        .where(eq(companies.id, agent.companyId))
        .then((rows) => rows[0] ?? null);

      await logActivity(db, {
        companyId: agent.companyId,
        actorType: "system",
        // No user is present — the caller is a machine redeeming a code. The
        // device name in `details` is what identifies who this was.
        actorId: "system",
        action: "agent.connect_code_redeemed",
        entityType: "agent",
        entityId: agent.id,
        details: { deviceName, keyId: issued.id, connectCodeId: claimed.id },
      }).catch((err: unknown) => {
        // A pairing that worked must not fail because the audit write did.
        logger.warn({ err, agentId: agent.id }, "failed to log connect code redemption");
      });

      /**
       * Who this pairing belongs to, by name. The CLI prints it at pairing
       * and refuses to silently replace a token that belongs to somebody
       * else — the failure that actually happened: a machine holding one
       * person's inbox was re-paired under another signed-in account and
       * nothing said so. Display identity only; the credential is above.
       */
      const creatorId = (claimed as { createdByUserId?: string | null }).createdByUserId ?? null;
      const owner = creatorId
        ? await db
            .select({ name: authUsers.name, email: authUsers.email })
            .from(authUsers)
            .where(eq(authUsers.id, creatorId))
            .then((rows) => rows[0] ?? null)
        : null;

      const bridgeEndpoint = await mintBridgeEndpointForCodeCreator({
        companyId: agent.companyId,
        createdByUserId: (claimed as { createdByUserId?: string | null }).createdByUserId ?? null,
        deviceName,
      });

      res.json({
        apiKey: issued.token,
        agentId: agent.id,
        agentName: agent.name,
        companyId: agent.companyId,
        companyName: company?.name ?? null,
        deviceName,
        // Null when the code has no recorded creator (a board key minted it) or
        // the endpoint could not be created. The pairing above still stands.
        bridgeToken: bridgeEndpoint?.token ?? null,
        bridgeEndpointId: bridgeEndpoint?.endpointId ?? null,
        owner: owner ? { name: owner.name, email: owner.email } : null,
      });
    },
  );

  return router;
}
