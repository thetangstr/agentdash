import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";

// Mini safety: the ingest pipeline must never run while a news agent is in a
// heartbeat-spawnable state. Paused agents are skipped by the heartbeat
// (heartbeat.ts:3978 et al). Anything else risks the EPIPE crash-loop.
export async function assertNoActiveNewsAgents(db: Db, companyId: string): Promise<void> {
  const rows = await db
    .select({ id: agents.id, status: agents.status })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const offenders = rows.filter((r) => r.status !== "paused" && r.status !== "terminated");
  if (offenders.length > 0) {
    throw new Error(
      `Refusing to ingest: ${offenders.length} Atlas Wire agent(s) not paused ` +
        `(${offenders.map((o) => `${o.id}:${o.status}`).join(", ")}). Pause them first.`,
    );
  }
}
