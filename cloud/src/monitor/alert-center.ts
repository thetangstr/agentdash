// AgentDash (SC-10, GH #771): alert state for fleet monitoring (spec §6.3).
// Every condition has a stable key (`health:direct:<box id>`, `router_5xx`,
// `cert:<host>`, `spend`, …) and one row in fleet_alerts:
//
//   fire     first time: notify. Still firing: a reminder at most every
//            `repeatMs` (6 h), otherwise counted as suppressed. Firing again
//            within `flapWindowMs` (30 min) of a recovery that itself came
//            within that window of the last notice: flapping, suppressed (the
//            row still says firing, so `fleet status` shows it). A
//            suppressed episode still firing once the flap window has passed
//            is notified then: a flap that settles into an outage is paged.
//   resolve  a firing condition clears: one recovery notice, unless the
//            episode was never notified (flap-suppressed).
//   notify   a one-off notice with no state (e.g. a box entered deletion).
//
// The notice goes out after the row is written, through the existing
// transports (log, ops webhook, email; ../jobs/alerts.ts), which redact and
// never throw. Times come from the injected clock so tests can drive it.
import { eq } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { fleetAlerts } from "../db/schema.js";
import type { Alert, Alerter } from "../jobs/alerts.js";
import type { Logger } from "../logger.js";

export const ALERT_REPEAT_MS = 6 * 60 * 60_000;
export const ALERT_FLAP_WINDOW_MS = 30 * 60_000;

export type FireOutcome = "notified" | "reminded" | "suppressed";

export interface AlertCenter {
  fire(key: string, alert: Alert): Promise<FireOutcome>;
  resolve(key: string, note?: string): Promise<boolean>;
  notify(alert: Alert): Promise<void>;
}

export interface AlertCenterOptions {
  db: CloudDb;
  alerter: Alerter;
  log: Logger;
  now?: () => Date;
  repeatMs?: number;
  flapWindowMs?: number;
}

export function alertCenter(opts: AlertCenterOptions): AlertCenter {
  const now = opts.now ?? (() => new Date());
  const repeatMs = opts.repeatMs ?? ALERT_REPEAT_MS;
  const flapMs = opts.flapWindowMs ?? ALERT_FLAP_WINDOW_MS;
  const log = opts.log.child({ component: "alert-center" });

  const send = async (alert: Alert) => {
    await opts.alerter.send(alert).catch((err: unknown) => log.error("alert delivery failed", { err, alertKind: alert.kind }));
  };

  return {
    async fire(key, alert) {
      const at = now();
      const detail = { detail: alert.detail ?? null, error: alert.error ?? null, slug: alert.slug ?? null };
      const outcome = await opts.db.transaction(async (tx) => {
        const [row] = await tx.select().from(fleetAlerts).where(eq(fleetAlerts.key, key)).for("update");
        if (!row) {
          await tx.insert(fleetAlerts).values({
            key,
            kind: alert.kind,
            state: "firing",
            subject: alert.subject,
            boxId: alert.boxId ?? null,
            detail,
            firstFiredAt: at,
            lastFiredAt: at,
            lastNotifiedAt: at,
            notifyCount: 1,
          });
          return "notified" as const;
        }
        if (row.state === "firing") {
          // An episode suppressed as flapping that is still firing once the flap window
          // has passed is a real outage: notify it then, not a reminder interval later.
          const unnotified = !row.lastNotifiedAt || row.lastNotifiedAt.getTime() < row.firstFiredAt.getTime();
          const since = row.lastNotifiedAt ? at.getTime() - row.lastNotifiedAt.getTime() : Number.POSITIVE_INFINITY;
          const due = since >= (unnotified ? flapMs : repeatMs);
          await tx
            .update(fleetAlerts)
            .set({
              subject: alert.subject,
              detail,
              lastFiredAt: at,
              updatedAt: at,
              ...(due ? { lastNotifiedAt: at, notifyCount: row.notifyCount + 1 } : { suppressedCount: row.suppressedCount + 1 }),
            })
            .where(eq(fleetAlerts.key, key));
          if (!due) return "suppressed" as const;
          return unnotified ? ("notified" as const) : ("reminded" as const);
        }
        // Resolved before: a new episode. Flapping when it cleared and came back within the window.
        const flapping =
          row.resolvedAt !== null &&
          at.getTime() - row.resolvedAt.getTime() < flapMs &&
          row.lastNotifiedAt !== null &&
          at.getTime() - row.lastNotifiedAt.getTime() < flapMs;
        await tx
          .update(fleetAlerts)
          .set({
            state: "firing",
            subject: alert.subject,
            detail,
            firstFiredAt: at,
            lastFiredAt: at,
            resolvedAt: null,
            updatedAt: at,
            ...(flapping ? { suppressedCount: row.suppressedCount + 1 } : { lastNotifiedAt: at, notifyCount: row.notifyCount + 1 }),
          })
          .where(eq(fleetAlerts.key, key));
        return flapping ? ("suppressed" as const) : ("notified" as const);
      });
      if (outcome === "notified") await send(alert);
      else if (outcome === "reminded") await send({ ...alert, subject: `still failing: ${alert.subject}` });
      else log.info("alert suppressed (already notified, or flapping)", { key, alertKind: alert.kind });
      return outcome;
    },

    async resolve(key, note) {
      const at = now();
      const row = await opts.db.transaction(async (tx) => {
        const [r] = await tx.select().from(fleetAlerts).where(eq(fleetAlerts.key, key)).for("update");
        if (!r || r.state !== "firing") return null;
        await tx.update(fleetAlerts).set({ state: "resolved", resolvedAt: at, updatedAt: at }).where(eq(fleetAlerts.key, key));
        return r;
      });
      if (!row) return false;
      // An episode that was never notified (flap-suppressed) clears quietly.
      const notified = row.lastNotifiedAt !== null && row.lastNotifiedAt.getTime() >= row.firstFiredAt.getTime();
      if (notified) {
        await send({
          kind: row.kind as Alert["kind"],
          subject: `resolved: ${row.subject}`,
          boxId: row.boxId,
          slug: typeof row.detail?.slug === "string" ? row.detail.slug : null,
          detail: note ?? `cleared after ${Math.max(1, Math.round((at.getTime() - row.firstFiredAt.getTime()) / 60_000))} min`,
          resolved: true,
        });
      }
      return true;
    },

    async notify(alert) {
      await send(alert);
    },
  };
}
