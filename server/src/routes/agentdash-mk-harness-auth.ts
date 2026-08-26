import type { Request } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentConnectCodes } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";

/**
 * Resolve the human principal represented by an AgentDash-MK harness.
 *
 * A connect code intentionally produces an agent API key so the local harness
 * can use the ordinary agent-facing API. That credential may represent the
 * steward only on the two explicit harness control surfaces, and only while:
 *
 * - it is the exact key produced by a redeemed connect code for this agent;
 * - the user who created that code is still this agent's active steward; and
 * - the request remains scoped to the same company and agent.
 *
 * Ordinary agent keys and JWTs have no connect-code provenance and therefore
 * cannot acquire human authority through this helper.
 */
export async function requireActiveStewardHarness(
  db: Db,
  req: Request,
  companyId: string,
  agentId: string,
  message: string,
) {
  const active = await agentStewardshipService(db).activeByAgent(companyId, agentId);
  if (!active) throw forbidden(message);

  if (req.actor.type === "board") {
    if (req.actor.userId === active.userId) return active;
    throw forbidden(message);
  }

  if (
    req.actor.type !== "agent" ||
    req.actor.source !== "agent_key" ||
    !req.actor.keyId ||
    req.actor.companyId !== companyId ||
    req.actor.agentId !== agentId
  ) {
    throw forbidden(message);
  }

  const pairing = await db
    .select({ createdByUserId: agentConnectCodes.createdByUserId })
    .from(agentConnectCodes)
    .where(
      and(
        eq(agentConnectCodes.companyId, companyId),
        eq(agentConnectCodes.agentId, agentId),
        eq(agentConnectCodes.issuedApiKeyId, req.actor.keyId),
        isNull(agentConnectCodes.revokedAt),
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (pairing?.createdByUserId === active.userId) return active;
  throw forbidden(message);
}
