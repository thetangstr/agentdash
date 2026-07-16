import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { clockchainService } from "./clockchain.js";

export function agentIdentityService(db: Db, clock = clockchainService()) {
  async function resolveAgentDid(agentId: string): Promise<string | undefined> {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return undefined;
    if (agent.clockchainDid) return agent.clockchainDid;
    const minted = await clock.mintIdentity({ agentId, name: agent.name });
    if (!minted.minted || !minted.did) return undefined;
    await db.update(agents).set({ clockchainDid: minted.did, updatedAt: new Date() }).where(eq(agents.id, agentId));
    return minted.did;
  }
  return { resolveAgentDid };
}
