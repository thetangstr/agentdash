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
import { agentConnectCodes, agents, companies } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { createAuthRateLimiter } from "../middleware/rate-limit.js";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "../services/index.js";
import { agentService } from "../services/agents.js";
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
        issued = await svc.createApiKey(agent.id, `${agent.name} — ${deviceName}`);
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

      res.json({
        apiKey: issued.token,
        agentId: agent.id,
        agentName: agent.name,
        companyId: agent.companyId,
        companyName: company?.name ?? null,
        deviceName,
      });
    },
  );

  return router;
}
