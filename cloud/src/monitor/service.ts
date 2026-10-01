// AgentDash (SC-10, GH #771): the fleet monitor's schedule in cloud-control.
//
//   direct health   every 60 s       ./health.ts
//   router health   every 5 min      only when CLOUD_EDGE_LIVE=true
//   router 5xx      every 5 min      ./checks.ts
//   certificates    every 6 h        CLOUD_CERT_CHECK_HOSTS
//   spend           every 24 h       ./checks.ts
//   idle policy     every hour       ./idle.ts (does nothing until enabled)
//   prune           every 6 h        history older than 30 days
//
// Each pass is skipped while its previous run is still going, and a failed
// pass is logged, never thrown. Read-only checks always run; the destructive
// steps are behind their settings (idle_suspend_enabled, idle_delete_enabled).
import { sql } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import type { Mailer } from "../front-door/mailer.js";
import type { Alerter } from "../jobs/alerts.js";
import type { Logger } from "../logger.js";
import { alertCenter, type AlertCenter } from "./alert-center.js";
import { CERT_CHECK_MS, checkCertificates, checkRouter5xx, checkSpend, type CertReader, SPEND_CHECK_MS } from "./checks.js";
import { DIRECT_POLL_MS, pollFleetHealth, ROUTER_POLL_MS } from "./health.js";
import { IDLE_SWEEP_MS, sweepIdle } from "./idle.js";

export const PRUNE_MS = 6 * 60 * 60_000;
export const KEEP_HISTORY_DAYS = 30;

export interface MonitorConfig {
  /** Hosts whose TLS certificate is checked (CLOUD_CERT_CHECK_HOSTS). */
  certHosts: string[];
}

const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * CLOUD_CERT_CHECK_HOSTS: comma-separated host names, or "none". Default:
 * www.<edge domain>, plus edge.<edge domain> (a reserved name the router
 * answers with the wildcard certificate) once the edge is live.
 */
export function loadMonitorConfig(env: NodeJS.ProcessEnv, base: { edgeDomain: string; edgeLive: boolean }): MonitorConfig {
  const raw = env.CLOUD_CERT_CHECK_HOSTS?.trim();
  if (raw?.toLowerCase() === "none") return { certHosts: [] };
  if (raw) {
    const hosts = raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    for (const h of hosts) if (!HOST_RE.test(h)) throw new Error(`CLOUD_CERT_CHECK_HOSTS: not a host name: ${h}`);
    return { certHosts: hosts };
  }
  return { certHosts: [`www.${base.edgeDomain}`, ...(base.edgeLive ? [`edge.${base.edgeDomain}`] : [])] };
}

export interface MonitorDeps {
  db: CloudDb;
  log: Logger;
  alerter: Alerter;
  mailer: Mailer;
  edgeDomain: string;
  edgeLive: boolean;
  config: MonitorConfig;
  fetch?: typeof fetch;
  readCert?: CertReader;
}

export interface Monitor {
  alerts: AlertCenter;
  stop(): void;
}

export async function pruneFleetHistory(db: CloudDb, days = KEEP_HISTORY_DAYS): Promise<number> {
  const rows = (await db.execute(sql`select prune_fleet_history(${days * 86_400}) as n`)) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

export function startMonitor(deps: MonitorDeps): Monitor {
  const log = deps.log.child({ component: "monitor" });
  const alerts = alertCenter({ db: deps.db, alerter: deps.alerter, log });
  const timers: NodeJS.Timeout[] = [];
  const every = (name: string, ms: number, pass: () => Promise<unknown>, runNow = true) => {
    let running = false;
    const tick = () => {
      if (running) return;
      running = true;
      void pass()
        .catch((err: unknown) => log.error(`${name} pass failed`, { err }))
        .finally(() => {
          running = false;
        });
    };
    const t = setInterval(tick, ms);
    t.unref();
    timers.push(t);
    if (runNow) tick();
  };
  const health = { db: deps.db, log, alerts, edgeDomain: deps.edgeDomain, fetch: deps.fetch };

  every("direct health", DIRECT_POLL_MS, () => pollFleetHealth(health, "direct"));
  if (deps.edgeLive) {
    every("router health", ROUTER_POLL_MS, () => pollFleetHealth(health, "router"));
    every("router 5xx", ROUTER_POLL_MS, () => checkRouter5xx({ db: deps.db, alerts }));
  } else {
    log.info("edge router not live (CLOUD_EDGE_LIVE): health through the router and the 5xx rate are not checked");
  }
  if (deps.config.certHosts.length) {
    every("certificates", CERT_CHECK_MS, () => checkCertificates({ db: deps.db, alerts, log, hosts: deps.config.certHosts, read: deps.readCert }));
  }
  every("spend", SPEND_CHECK_MS, () => checkSpend({ db: deps.db, alerts, log }));
  every("idle policy", IDLE_SWEEP_MS, () => sweepIdle({ db: deps.db, log, alerts, mailer: deps.mailer, edgeDomain: deps.edgeDomain }));
  every("prune", PRUNE_MS, () => pruneFleetHistory(deps.db), false);

  return {
    alerts,
    stop() {
      for (const t of timers) clearInterval(t);
    },
  };
}
