// AgentDash: Scheduled HubSpot sync — keeps CRM data fresh automatically.
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { hubspotService } from "./hubspot.js";
import { logger } from "../middleware/logger.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function createHubSpotSyncScheduler(db: Db) {
  const svc = hubspotService(db);
  let running = false;

  async function findAllHubSpotEnabledCompanies(): Promise<string[]> {
    const rows = await db
      .select({ id: companies.id })
      .from(companies)
      .where(
        sql`${companies.metadata}->'hubspot'->>'syncEnabled' = 'true'
            AND ${companies.metadata}->'hubspot'->>'accessToken' IS NOT NULL
            AND ${companies.metadata}->'hubspot'->>'accessToken' != ''`,
      );
    return rows.map((r) => r.id);
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const companyIds = await findAllHubSpotEnabledCompanies();
      if (companyIds.length === 0) return;

      logger.info({ count: companyIds.length }, "HubSpot sync scheduler: starting sync tick");

      for (const companyId of companyIds) {
        try {
          const result = await svc.syncAll(companyId);
          logger.info(
            { companyId, totalSynced: result.totalSynced, totalErrors: result.totalErrors },
            "HubSpot sync scheduler: company sync complete",
          );
        } catch (err) {
          logger.error({ err, companyId }, "HubSpot sync scheduler: company sync failed");
        }
      }
    } catch (err) {
      logger.error({ err }, "HubSpot sync scheduler: tick failed");
    } finally {
      running = false;
    }
  }

  return {
    start(intervalMs = DEFAULT_INTERVAL_MS) {
      logger.info({ intervalMs }, "HubSpot sync scheduler started");
      setInterval(() => {
        void tick();
      }, intervalMs);
    },
  };
}
