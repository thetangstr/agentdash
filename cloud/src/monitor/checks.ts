// AgentDash (SC-10, GH #771): the fleet-wide checks of spec §6.3 and §5.1.
//
//   router 5xx     the edge router's replicas flush request and 5xx counts
//                  (edge_stats, through edge_record_stats()); above 1 percent
//                  over 15 minutes, with enough traffic to mean something,
//                  ops is alerted.
//   certificates   the TLS certificate on each configured host; under 14 days
//                  to expiry, ops is alerted.
//   spend          the fleet's monthly cost. Railway's usage is not read by
//                  this control plane's Railway client, so the reading is an
//                  ESTIMATE from operator-set per-box rates and the box
//                  counts, and it says so; with no rates set the reading is
//                  "not available" and no number is shown. Above
//                  spend_alarm_usd the kill switch (provisioning_enabled) is
//                  turned off, audited, and ops is paged.
import tls from "node:tls";
import { desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { boxes, edgeStats, monitorReadings } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { settingsService } from "../settings.js";
import type { AlertCenter } from "./alert-center.js";

// ---- Router 5xx ---------------------------------------------------------

export const ROUTER_5XX_WINDOW_MS = 15 * 60_000;
export const ROUTER_5XX_THRESHOLD_PCT = 1;
/** Below this many requests in the window a rate is noise (one 502 in 20 requests is not an outage). */
export const ROUTER_5XX_MIN_REQUESTS = 100;

export interface Router5xxResult {
  requests: number;
  serverErrors: number;
  ratePct: number | null;
  alerting: boolean;
}

export async function checkRouter5xx(deps: { db: CloudDb; alerts: AlertCenter; now?: () => Date; minRequests?: number }): Promise<Router5xxResult> {
  const now = (deps.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - ROUTER_5XX_WINDOW_MS);
  const [row] = await deps.db
    .select({
      requests: sql<number>`coalesce(sum(${edgeStats.requests}), 0)::int`,
      serverErrors: sql<number>`coalesce(sum(${edgeStats.serverErrors}), 0)::int`,
    })
    .from(edgeStats)
    .where(gte(edgeStats.createdAt, since));
  const requests = Number(row?.requests ?? 0);
  const serverErrors = Number(row?.serverErrors ?? 0);
  const ratePct = requests > 0 ? (serverErrors / requests) * 100 : null;
  const alerting = requests >= (deps.minRequests ?? ROUTER_5XX_MIN_REQUESTS) && ratePct !== null && ratePct > ROUTER_5XX_THRESHOLD_PCT;
  await deps.db.insert(monitorReadings).values({
    kind: "router_5xx",
    subject: "edge",
    value: ratePct,
    detail: { requests, serverErrors, windowMinutes: ROUTER_5XX_WINDOW_MS / 60_000 },
    createdAt: now,
  });
  if (alerting) {
    await deps.alerts.fire("router_5xx", {
      kind: "router_5xx",
      subject: `edge router 5xx rate ${ratePct!.toFixed(2)}% over the last 15 min (${serverErrors} of ${requests})`,
      detail: `threshold ${ROUTER_5XX_THRESHOLD_PCT}%`,
    });
  } else {
    await deps.alerts.resolve("router_5xx", ratePct === null ? "no router traffic in the window" : `5xx rate ${ratePct.toFixed(2)}%`);
  }
  return { requests, serverErrors, ratePct, alerting };
}

// ---- Certificates -------------------------------------------------------

export const CERT_WARN_DAYS = 14;
export const CERT_CHECK_MS = 6 * 60 * 60_000;

export type CertReader = (host: string) => Promise<{ validTo: Date }>;

/** Reads the leaf certificate a host presents on 443 (SNI = host). Sends nothing but the handshake. */
export function tlsCertReader(timeoutMs = 10_000): CertReader {
  return (host) =>
    new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port: 443, servername: host, timeout: timeoutMs });
      const fail = (err: Error) => {
        socket.destroy();
        reject(err);
      };
      socket.once("secureConnect", () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
        if (!validTo || Number.isNaN(validTo.getTime())) return reject(new Error("no certificate expiry"));
        resolve({ validTo });
      });
      socket.once("timeout", () => fail(new Error("timeout")));
      socket.once("error", fail);
    });
}

export interface CertResult {
  host: string;
  daysLeft: number | null;
  error: string | null;
  alerting: boolean;
}

export async function checkCertificates(deps: { db: CloudDb; alerts: AlertCenter; log: Logger; hosts: string[]; read?: CertReader; now?: () => Date }): Promise<CertResult[]> {
  const read = deps.read ?? tlsCertReader();
  const now = (deps.now ?? (() => new Date()))();
  const out: CertResult[] = [];
  for (const host of deps.hosts) {
    let daysLeft: number | null = null;
    let error: string | null = null;
    try {
      const { validTo } = await read(host);
      daysLeft = Math.floor((validTo.getTime() - now.getTime()) / 86_400_000);
    } catch (err) {
      // Reachability is the health poller's job; an unreadable certificate is logged and shown, not paged.
      error = err instanceof Error ? ((err as { code?: string }).code ?? err.message) : "error";
      deps.log.warn("could not read a certificate", { host, error });
    }
    const alerting = daysLeft !== null && daysLeft < CERT_WARN_DAYS;
    await deps.db.insert(monitorReadings).values({ kind: "cert", subject: host, value: daysLeft, detail: { error }, createdAt: now });
    if (alerting) {
      await deps.alerts.fire(`cert:${host}`, {
        kind: "cert_expiry",
        subject: daysLeft! < 0 ? `the TLS certificate for ${host} has expired` : `the TLS certificate for ${host} expires in ${daysLeft} days`,
        detail: `alert below ${CERT_WARN_DAYS} days; Railway renews the edge wildcard through the _acme-challenge CNAME (spec §4.2)`,
      });
    } else if (daysLeft !== null) {
      await deps.alerts.resolve(`cert:${host}`, `${daysLeft} days left`);
    }
    out.push({ host, daysLeft, error, alerting });
  }
  return out;
}

// ---- Spend --------------------------------------------------------------

export const SPEND_CHECK_MS = 24 * 60 * 60_000;
/** Box states that run a web service (cost as a running box). */
const RUNNING_STATES = ["provisioning", "awaiting_claim", "active"] as const;
/** Box states with Postgres and volumes but no web deployment. */
const PARKED_STATES = ["suspended", "pending_delete"] as const;

export type SpendReading =
  | { available: true; source: "estimate"; monthlyUsd: number; basis: { runningBoxes: number; suspendedBoxes: number; boxUsd: number; suspendedBoxUsd: number } }
  | { available: false; source: "none"; reason: string };

export async function readSpend(db: CloudDb): Promise<SpendReading> {
  const s = await settingsService(db).getAll();
  if (s.spend_estimate_box_usd === null || s.spend_estimate_suspended_box_usd === null) {
    return {
      available: false,
      source: "none",
      reason: "Railway usage is not read by this control plane, and no estimate is configured (set spend_estimate_box_usd and spend_estimate_suspended_box_usd)",
    };
  }
  const rows = await db
    .select({ state: boxes.state, n: sql<number>`count(*)::int` })
    .from(boxes)
    .where(inArray(boxes.state, [...RUNNING_STATES, ...PARKED_STATES]))
    .groupBy(boxes.state);
  const count = (states: readonly string[]) => rows.filter((r) => states.includes(r.state)).reduce((a, r) => a + Number(r.n), 0);
  const runningBoxes = count(RUNNING_STATES);
  const suspendedBoxes = count(PARKED_STATES);
  const monthlyUsd = Math.round((runningBoxes * s.spend_estimate_box_usd + suspendedBoxes * s.spend_estimate_suspended_box_usd) * 100) / 100;
  return {
    available: true,
    source: "estimate",
    monthlyUsd,
    basis: { runningBoxes, suspendedBoxes, boxUsd: s.spend_estimate_box_usd, suspendedBoxUsd: s.spend_estimate_suspended_box_usd },
  };
}

export interface SpendCheckResult {
  reading: SpendReading;
  alarmUsd: number | null;
  tripped: boolean;
  killSwitchTurnedOff: boolean;
}

export async function checkSpend(deps: { db: CloudDb; alerts: AlertCenter; log: Logger; now?: () => Date }): Promise<SpendCheckResult> {
  const now = (deps.now ?? (() => new Date()))();
  const svc = settingsService(deps.db);
  const reading = await readSpend(deps.db);
  const alarmUsd = await svc.get("spend_alarm_usd");
  await deps.db.insert(monitorReadings).values({
    kind: "spend",
    subject: "fleet",
    value: reading.available ? reading.monthlyUsd : null,
    detail: reading.available ? { source: reading.source, basis: reading.basis, alarmUsd } : { source: reading.source, reason: reading.reason, alarmUsd },
    createdAt: now,
  });
  if (alarmUsd === null) {
    await deps.alerts.resolve("spend");
    await deps.alerts.resolve("spend:unavailable");
    return { reading, alarmUsd, tripped: false, killSwitchTurnedOff: false };
  }
  if (!reading.available) {
    // An alarm that cannot be evaluated must not look like "all clear".
    await deps.alerts.fire("spend:unavailable", {
      kind: "spend_alarm",
      subject: `the spend alarm is set to $${alarmUsd}/month but no spend reading is available`,
      detail: reading.reason,
    });
    return { reading, alarmUsd, tripped: false, killSwitchTurnedOff: false };
  }
  await deps.alerts.resolve("spend:unavailable");
  if (reading.monthlyUsd <= alarmUsd) {
    await deps.alerts.resolve("spend", `estimated $${reading.monthlyUsd}/month, alarm at $${alarmUsd}`);
    return { reading, alarmUsd, tripped: false, killSwitchTurnedOff: false };
  }
  let killSwitchTurnedOff = false;
  if (await svc.get("provisioning_enabled")) {
    await svc.set("provisioning_enabled", false, "spend-alarm");
    killSwitchTurnedOff = true;
    deps.log.warn("spend alarm: provisioning turned off", { monthlyUsd: reading.monthlyUsd, alarmUsd });
  }
  await deps.alerts.fire("spend", {
    kind: "spend_alarm",
    subject: `spend alarm: estimated $${reading.monthlyUsd}/month is above the $${alarmUsd} alarm`,
    detail: `${killSwitchTurnedOff ? "provisioning was turned OFF (kill switch); " : "provisioning was already off; "}estimate from ${reading.basis.runningBoxes} running boxes at $${reading.basis.boxUsd} and ${reading.basis.suspendedBoxes} suspended at $${reading.basis.suspendedBoxUsd}. Turn provisioning back on by hand once resolved.`,
  });
  return { reading, alarmUsd, tripped: true, killSwitchTurnedOff };
}

/** The latest reading of a kind (per subject), for `fleet status`. */
export async function latestReadings(db: CloudDb, kind: "spend" | "cert" | "router_5xx") {
  const rows = await db.select().from(monitorReadings).where(eq(monitorReadings.kind, kind)).orderBy(desc(monitorReadings.createdAt)).limit(50);
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.subject) ? false : (seen.add(r.subject), true)));
}
