// AgentDash (#807 review, SC-5): the fleet step run once the edge router is
// live (DNS #758, SC-4): give every running box that does not have it its
// AGENTDASH_EDGE_SECRET (the one the control plane already holds and the
// router already sends), with skipDeploys, so each box starts enforcing it at
// its next deploy. Refused while the router is not live.
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { decryptField, encryptField, type DataKeyring } from "../crypto.js";
import type { CloudDb } from "../db/client.js";
import { boxEvents, boxes } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { getProject, upsertVariables, variableNames } from "./api.js";
import type { RailwayClient } from "./client.js";
import { newEdgeSecret } from "./secrets.js";

export interface EdgeBackfillResult {
  set: string[];
  alreadySet: string[];
  failed: Array<{ slug: string; error: string }>;
}

export class EdgeNotLive extends Error {}

export async function backfillEdgeSecrets(
  db: CloudDb,
  deps: { client: RailwayClient; workspaceId: string; dataKeys: DataKeyring; edgeLive: boolean; log: Logger },
): Promise<EdgeBackfillResult> {
  if (!deps.edgeLive) throw new EdgeNotLive("the edge router is not live (CLOUD_EDGE_LIVE); boxes must not enforce the edge secret yet");
  const rows = await db
    .select()
    .from(boxes)
    .where(and(inArray(boxes.state, ["awaiting_claim", "active", "suspended"]), isNotNull(boxes.projectId), isNotNull(boxes.webServiceId)));
  const result: EdgeBackfillResult = { set: [], alreadySet: [], failed: [] };
  for (const box of rows) {
    try {
      const p = await getProject(deps.client, box.projectId!);
      if (p.workspaceId !== deps.workspaceId) throw new Error("project is not in the boxes workspace");
      const names = await variableNames(deps.client, box.projectId!, box.environmentId!, box.webServiceId!);
      if (names.includes("AGENTDASH_EDGE_SECRET")) {
        result.alreadySet.push(box.slug);
        continue;
      }
      let edge = box.edgeSecretEnc ? decryptField(deps.dataKeys, box.edgeSecretEnc, "boxes.edge_secret_enc") : null;
      if (!edge) {
        edge = newEdgeSecret();
        await db.update(boxes).set({ edgeSecretEnc: encryptField(deps.dataKeys, edge, "boxes.edge_secret_enc"), updatedAt: new Date() }).where(eq(boxes.id, box.id));
      }
      await upsertVariables(deps.client, box.projectId!, box.environmentId!, box.webServiceId!, { AGENTDASH_EDGE_SECRET: edge });
      await db.insert(boxEvents).values({ boxId: box.id, kind: "edge_secret_backfilled", actor: "admin-cli", detail: { takesEffect: "next deploy" } });
      result.set.push(box.slug);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.log.warn("edge secret back-fill failed for a box", { slug: box.slug, error });
      result.failed.push({ slug: box.slug, error });
    }
  }
  return result;
}
