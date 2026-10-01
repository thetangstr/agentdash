// AgentDash (SC-10, GH #771): what the admin CLI shows (spec §6.3 "the admin
// CLI shows a fleet summary"), and the operator's suspend and wake. Read-only
// apart from suspend and wake, which only queue the jobs.
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { boxEvents, boxes, boxHealth, boxHealthChecks, boxIdleNotices, fleetAlerts, jobs } from "../db/schema.js";
import { BoxOpError } from "../jobs/ops.js";
import { enqueueJob } from "../jobs/queue.js";
import { settingsService } from "../settings.js";
import { latestReadings } from "./checks.js";
import { IDLE_DAYS, IDLE_POLICY_PLANS, idleDays, nextIdleStep } from "./idle.js";

export async function fleetStatus(db: CloudDb, opts: { edgeLive: boolean; now?: () => Date }) {
  const now = (opts.now ?? (() => new Date()))();
  const settings = await settingsService(db).getAll();
  const byState = await db.select({ state: boxes.state, n: sql<number>`count(*)::int` }).from(boxes).groupBy(boxes.state);
  const byPlan = await db
    .select({ plan: boxes.planTier, n: sql<number>`count(*)::int` })
    .from(boxes)
    .where(inArray(boxes.state, ["awaiting_claim", "active", "suspended"]))
    .groupBy(boxes.planTier);
  const health = await db
    .select({ path: boxHealth.path, status: boxHealth.status, n: sql<number>`count(*)::int` })
    .from(boxHealth)
    .innerJoin(boxes, eq(boxes.id, boxHealth.boxId))
    .where(eq(boxes.state, "active"))
    .groupBy(boxHealth.path, boxHealth.status);
  const healthSummary = (path: "direct" | "router") =>
    Object.fromEntries(health.filter((h) => h.path === path).map((h) => [h.status, Number(h.n)]));
  const failing = await db
    .select({
      slug: boxes.slug,
      path: boxHealth.path,
      consecutiveFailures: boxHealth.consecutiveFailures,
      lastError: boxHealth.lastError,
      lastOkAt: boxHealth.lastOkAt,
      lastCheckedAt: boxHealth.lastCheckedAt,
    })
    .from(boxHealth)
    .innerJoin(boxes, eq(boxes.id, boxHealth.boxId))
    .where(and(eq(boxes.state, "active"), sql`${boxHealth.consecutiveFailures} > 0`))
    .orderBy(desc(boxHealth.consecutiveFailures))
    .limit(50);
  const alerts = await db
    .select({ key: fleetAlerts.key, kind: fleetAlerts.kind, subject: fleetAlerts.subject, firstFiredAt: fleetAlerts.firstFiredAt, lastNotifiedAt: fleetAlerts.lastNotifiedAt, notifyCount: fleetAlerts.notifyCount, suppressedCount: fleetAlerts.suppressedCount })
    .from(fleetAlerts)
    .where(eq(fleetAlerts.state, "firing"))
    .orderBy(desc(fleetAlerts.firstFiredAt))
    .limit(100);
  const jobCounts = await db.select({ state: jobs.state, n: sql<number>`count(*)::int` }).from(jobs).where(inArray(jobs.state, ["queued", "running"])).groupBy(jobs.state);
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const badJobs = await db
    .select({ slug: boxes.slug, kind: jobs.kind, state: jobs.state, step: jobs.step, lastError: jobs.lastError, finishedAt: jobs.finishedAt })
    .from(jobs)
    .innerJoin(boxes, eq(boxes.id, jobs.boxId))
    .where(and(inArray(jobs.state, ["failed", "dead"]), gte(jobs.updatedAt, dayAgo)))
    .orderBy(desc(jobs.updatedAt))
    .limit(20);
  const free = await db
    .select({ state: boxes.state, lastHumanRequestAt: boxes.lastHumanRequestAt, claimedAt: boxes.claimedAt, createdAt: boxes.createdAt })
    .from(boxes)
    .where(and(inArray(boxes.planTier, [...IDLE_POLICY_PLANS]), inArray(boxes.state, ["active", "suspended", "pending_delete"])));
  const idleBucket = (min: number) => free.filter((b) => b.state === "active" && idleDays(b, now) >= min).length;
  const [router] = await latestReadings(db, "router_5xx");
  const [spend] = await latestReadings(db, "spend");
  const certs = await latestReadings(db, "cert");

  return {
    generatedAt: now.toISOString(),
    boxes: {
      byState: Object.fromEntries(byState.map((r) => [r.state, Number(r.n)])),
      byPlan: Object.fromEntries(byPlan.map((r) => [r.plan, Number(r.n)])),
    },
    health: {
      direct: healthSummary("direct"),
      router: opts.edgeLive ? healthSummary("router") : "not polled (CLOUD_EDGE_LIVE is not true)",
      failing,
    },
    alerts: { firing: alerts.length, list: alerts },
    jobs: {
      live: Object.fromEntries(jobCounts.map((r) => [r.state, Number(r.n)])),
      failedOrDeadLast24h: badJobs,
    },
    router5xx: router
      ? { ratePct: router.value, ...(router.detail ?? {}), at: router.createdAt }
      : "no reading yet",
    certificates: certs.map((c) => ({ host: c.subject, daysLeft: c.value, ...(c.detail ?? {}), at: c.createdAt })),
    spend: spend
      ? { monthlyUsd: spend.value, available: spend.value !== null, ...(spend.detail ?? {}), at: spend.createdAt }
      : "no reading yet",
    idlePolicy: {
      suspendEnabled: settings.idle_suspend_enabled,
      deleteEnabled: settings.idle_delete_enabled,
      days: IDLE_DAYS,
      freeBoxes: {
        active: free.filter((b) => b.state === "active").length,
        idle14Plus: idleBucket(IDLE_DAYS.suspendWarning),
        idle21Plus: idleBucket(IDLE_DAYS.suspend),
        suspended: free.filter((b) => b.state === "suspended").length,
        pendingDelete: free.filter((b) => b.state === "pending_delete").length,
      },
    },
    killSwitch: { provisioningEnabled: settings.provisioning_enabled, spendAlarmUsd: settings.spend_alarm_usd },
  };
}

export async function boxHealthReport(db: CloudDb, slug: string, opts: { now?: () => Date } = {}) {
  const now = (opts.now ?? (() => new Date()))();
  const [box] = await db.select().from(boxes).where(eq(boxes.slug, slug));
  if (!box) throw new BoxOpError(`no box ${slug}`, 404);
  const settings = await settingsService(db).getAll();
  const paths = await db.select().from(boxHealth).where(eq(boxHealth.boxId, box.id));
  const checks = await db
    .select({ path: boxHealthChecks.path, ok: boxHealthChecks.ok, httpStatus: boxHealthChecks.httpStatus, latencyMs: boxHealthChecks.latencyMs, error: boxHealthChecks.error, checkedAt: boxHealthChecks.checkedAt })
    .from(boxHealthChecks)
    .where(eq(boxHealthChecks.boxId, box.id))
    .orderBy(desc(boxHealthChecks.checkedAt))
    .limit(20);
  const alerts = await db.select().from(fleetAlerts).where(and(eq(fleetAlerts.boxId, box.id), eq(fleetAlerts.state, "firing")));
  const notices = await db.select().from(boxIdleNotices).where(eq(boxIdleNotices.boxId, box.id)).orderBy(desc(boxIdleNotices.sentAt)).limit(10);
  const events = await db
    .select({ kind: boxEvents.kind, actor: boxEvents.actor, createdAt: boxEvents.createdAt })
    .from(boxEvents)
    .where(and(eq(boxEvents.boxId, box.id), sql`${boxEvents.kind} like any (array['box_%', 'idle_%', 'job_%'])`))
    .orderBy(desc(boxEvents.createdAt))
    .limit(10);
  return {
    slug: box.slug,
    state: box.state,
    planTier: box.planTier,
    releaseTag: box.releaseTag,
    lastHealth: box.lastHealth,
    paths: paths.map((p) => ({ path: p.path, status: p.status, consecutiveFailures: p.consecutiveFailures, lastCheckedAt: p.lastCheckedAt, lastOkAt: p.lastOkAt, lastError: p.lastError, release: p.release })),
    recentChecks: checks,
    firingAlerts: alerts.map((a) => ({ key: a.key, subject: a.subject, firstFiredAt: a.firstFiredAt })),
    idle: {
      lastHumanRequestAt: box.lastHumanRequestAt,
      idleDays: Math.floor(idleDays(box, now) * 10) / 10,
      suspendedAt: box.suspendedAt,
      deleteAfter: box.deleteAfter,
      next: nextIdleStep(box, now, settings),
      notices: notices.map((n) => ({ kind: n.kind, idleSince: n.idleSince, sentAt: n.sentAt })),
    },
    recentEvents: events,
  };
}

/** Operator suspend: a suspend job for an active box (any plan). The idle kill switch governs only the automatic policy. */
export async function operatorSuspend(db: CloudDb, slug: string, actor: string): Promise<{ jobId: string; created: boolean }> {
  const [box] = await db.select().from(boxes).where(eq(boxes.slug, slug));
  if (!box) throw new BoxOpError(`no box ${slug}`, 404);
  if (box.state !== "active") throw new BoxOpError(`box ${slug} is ${box.state}; only an active box can be suspended`, 409);
  const { id, created } = await enqueueJob(db, { boxId: box.id, kind: "suspend", payload: { reason: "operator", requestedBy: actor } });
  if (created) await db.insert(boxEvents).values({ boxId: box.id, kind: "suspend_requested", actor, detail: { jobId: id } });
  return { jobId: id, created };
}

/** Operator wake: a resume job for a suspended box (the router queues the same job on a visit). */
export async function operatorWake(db: CloudDb, slug: string, actor: string): Promise<{ jobId: string; created: boolean }> {
  const [box] = await db.select().from(boxes).where(eq(boxes.slug, slug));
  if (!box) throw new BoxOpError(`no box ${slug}`, 404);
  if (box.state !== "suspended") throw new BoxOpError(`box ${slug} is ${box.state}; only a suspended box can be woken`, 409);
  const { id, created } = await enqueueJob(db, { boxId: box.id, kind: "resume", payload: { requestedBy: actor } });
  if (created) await db.insert(boxEvents).values({ boxId: box.id, kind: "wake_requested", actor, detail: { jobId: id } });
  return { jobId: id, created };
}
