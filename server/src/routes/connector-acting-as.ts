// AgentDash (security): one authorization step for connector routes that name a
// specific connection and may name an acting agent in the request.
import type { Request } from "express";
import type { ActingAsResolution, ConnectorActionClass } from "@paperclipai/shared";
import type { connectorService } from "../services/connectors.js";
import { getActorInfo } from "./authz.js";

export type AuthorizeNamedConnectionResult =
  | { ok: true; resolution: ActingAsResolution; actingId: string }
  | { ok: false; code: string; message: string };

/**
 * Authorize the caller against the exact connection named in the request,
 * before any token is decrypted.
 *
 * - An agent key acts as itself; a request `agentId` naming a different agent
 *   is refused.
 * - A human acts as themselves (and may use connections they own), or as the
 *   request `agentId` when given.
 * - A human acting through an agent never reaches another human's private
 *   connection. In an agentdash_mk company the resolver falls back to the
 *   agent's steward's private connection, so without this check a member could
 *   name an agent a colleague stewards and borrow the colleague's token.
 */
export async function authorizeNamedConnection(
  connSvc: ReturnType<typeof connectorService>,
  req: Request,
  input: {
    companyId: string;
    connectionId: string;
    provider: string;
    actionClass: ConnectorActionClass;
    requestedAgentId?: unknown;
  },
): Promise<AuthorizeNamedConnectionResult> {
  const actor = getActorInfo(req);
  const notAuthorized = (message = "Connection is not authorized for this agent") =>
    ({ ok: false, code: "not_authorized", message }) as const;
  const agentIdArg =
    typeof input.requestedAgentId === "string" && input.requestedAgentId
      ? input.requestedAgentId
      : undefined;

  let actingId: string;
  let actingType: "agent" | "user";
  if (actor.actorType === "agent") {
    if (agentIdArg && agentIdArg !== actor.actorId) {
      return notAuthorized("An agent may only act as itself");
    }
    actingId = actor.actorId;
    actingType = "agent";
  } else if (agentIdArg) {
    actingId = agentIdArg;
    actingType = "agent";
  } else {
    actingId = actor.actorId;
    actingType = "user";
  }

  const resolution = await connSvc.resolveActingAs(
    input.companyId,
    actingId,
    input.actionClass,
    input.provider,
    { connectionId: input.connectionId, actorType: actingType },
  );
  if (!resolution.ok) {
    return { ok: false, code: resolution.blocked.reason, message: resolution.blocked.message };
  }
  if (resolution.resolution.connectionId !== input.connectionId) return notAuthorized();

  if (actor.actorType === "user" && actingType === "agent" && resolution.resolution.ownerType === "user") {
    const conn = await connSvc.getById(input.connectionId);
    if (!conn || (conn.visibility !== "workspace" && conn.ownerId !== actor.actorId)) {
      return notAuthorized();
    }
  }

  return { ok: true, resolution: resolution.resolution, actingId };
}
