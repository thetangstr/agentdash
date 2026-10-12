import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, bridgeEndpoints } from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { featureFlagsService } from "./feature-flags.js";

/**
 * A bridge endpoint describing itself to its own machine.
 *
 * What `agentdash-connect check` needs to tell a person "this machine lacks
 * bridge:work, reconnect" apart from "your company has not turned co-worker
 * review on": whose inbox the credential reads, the machine's label and
 * capabilities, and the company flag. Nothing about anyone else, no handles,
 * no cursor movement. Any live, approved endpoint may ask, whatever its
 * capabilities: a machine missing one is exactly the machine that needs to
 * hear so.
 */
export function bridgeEndpointSelfService(db: Db) {
  const flags = featureFlagsService(db);

  async function describe(endpointId: string) {
    const endpoint = await db
      .select({
        id: bridgeEndpoints.id,
        companyId: bridgeEndpoints.companyId,
        userId: bridgeEndpoints.userId,
        label: bridgeEndpoints.label,
        capabilities: bridgeEndpoints.capabilities,
        enrolledAt: bridgeEndpoints.enrolledAt,
      })
      .from(bridgeEndpoints)
      .where(and(eq(bridgeEndpoints.id, endpointId), isNull(bridgeEndpoints.revokedAt)))
      .then((rows) => rows[0] ?? null);
    if (!endpoint) throw notFound("Endpoint not found");
    if (!endpoint.enrolledAt) throw conflict("That endpoint has not been approved yet");

    const owner = await db
      .select({ name: authUsers.name, email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.id, endpoint.userId))
      .then((rows) => rows[0] ?? null);

    return {
      owner: { name: owner?.name ?? null, email: owner?.email ?? null },
      endpoint: {
        id: endpoint.id,
        label: endpoint.label,
        capabilities: endpoint.capabilities ?? [],
      },
      coworkerBridgeEnabled: await flags.isEnabled(endpoint.companyId, FEATURE_FLAG_KEYS.COWORKER_BRIDGE),
    };
  }

  return { describe };
}
