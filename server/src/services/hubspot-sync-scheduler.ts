import type { Db } from "@agentdash/db";

// AgentDash: HubSpot sync scheduler
export function createHubSpotSyncScheduler(db: Db) {
  return {
    start() { /* no-op until HubSpot integration configured */ },
    stop() {},
  };
}
