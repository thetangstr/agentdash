// AgentDash (SC-10, GH #771): the fleet health poller (spec §6.3).
//
//   direct  every 60 s, each active box's own Railway host:
//           https://<upstream_host>/api/health. Health is exempt from the
//           edge secret (spec §4.4), so no secret is sent.
//   router  every 5 min, through the edge router:
//           https://<slug>.<edge domain>/api/health (only once the router is
//           live). The router does not count health as human activity.
//
// A poll is healthy when the box answers 200 with `status: "ok"`. Each poll
// is kept in box_health_checks; box_health holds the latest state per path
// and the run of consecutive failures. At 3 in a row the box is `failing`
// and ops is alerted (deduplicated by ./alert-center.ts); the first healthy
// poll after that sends a recovery notice. Boxes with a live suspend, resume
// or upgrade job are skipped: they are expected to be down.
import { and, eq, inArray, isNotNull, like, ne, sql } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { boxes, boxHealth, boxHealthChecks, fleetAlerts, type HealthPath, jobs } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { redactString } from "../logger.js";
import type { AlertCenter } from "./alert-center.js";

export const HEALTH_FAILURE_THRESHOLD = 3;
export const DIRECT_POLL_MS = 60_000;
export const ROUTER_POLL_MS = 5 * 60_000;
/** Job kinds during which a box is expected to be unreachable. */
const BUSY_JOB_KINDS = ["suspend", "resume", "upgrade"] as const;

export interface HealthPollDeps {
  db: CloudDb;
  log: Logger;
  alerts: AlertCenter;
  edgeDomain: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  concurrency?: number;
}

export interface ProbeResult {
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number;
  error: string | null;
  releaseTag: string | null;
}

export function healthUrl(path: HealthPath, box: { slug: string; upstreamHost: string | null }, edgeDomain: string): string | null {
  if (path === "direct") return box.upstreamHost ? `https://${box.upstreamHost}/api/health` : null;
  return `https://${box.slug}.${edgeDomain}/api/health`;
}

export async function probeHealth(url: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<ProbeResult> {
  const f = opts.fetch ?? fetch;
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const res = await f(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000), headers: { accept: "application/json" } });
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = (await res.json()) as unknown;
      body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    const releaseTag = typeof body?.releaseTag === "string" ? body.releaseTag : null;
    if (!res.ok) return { ok: false, httpStatus: res.status, latencyMs: ms(), error: `HTTP ${res.status}`, releaseTag };
    if (body?.status !== "ok") return { ok: false, httpStatus: res.status, latencyMs: ms(), error: "health did not report status ok", releaseTag };
    return { ok: true, httpStatus: res.status, latencyMs: ms(), error: null, releaseTag };
  } catch (err) {
    const name = err instanceof Error ? ((err as { code?: string }).code ?? err.name) : "error";
    return { ok: false, httpStatus: null, latencyMs: ms(), error: `unreachable (${name})`, releaseTag: null };
  }
}

async function inPool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(runners);
}

export interface PollSummary {
  checked: number;
  ok: number;
  failed: number;
  alerted: number;
  recovered: number;
  skipped: number;
}

/** One pass over every active box on one path. */
export async function pollFleetHealth(deps: HealthPollDeps, path: HealthPath): Promise<PollSummary> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log.child({ component: "health-poller", path });
  // A box that was suspended, entered deletion or was deleted is not polled any more:
  // close its health alerts instead of leaving them firing forever.
  const stale = await deps.db
    .select({ key: fleetAlerts.key, slug: boxes.slug, state: boxes.state })
    .from(fleetAlerts)
    .innerJoin(boxes, eq(boxes.id, fleetAlerts.boxId))
    .where(and(eq(fleetAlerts.state, "firing"), like(fleetAlerts.key, `health:${path}:%`), ne(boxes.state, "active")));
  for (const a of stale) await deps.alerts.resolve(a.key, `${a.slug} is ${a.state}; no longer polled`);
  const active = await deps.db
    .select({ id: boxes.id, slug: boxes.slug, upstreamHost: boxes.upstreamHost, lastHealth: boxes.lastHealth })
    .from(boxes)
    .where(and(eq(boxes.state, "active"), isNotNull(boxes.upstreamHost)));
  const busy = active.length
    ? new Set(
        (
          await deps.db
            .select({ boxId: jobs.boxId })
            .from(jobs)
            .where(and(inArray(jobs.boxId, active.map((b) => b.id)), inArray(jobs.kind, [...BUSY_JOB_KINDS]), inArray(jobs.state, ["queued", "running"])))
        ).map((r) => r.boxId),
      )
    : new Set<string>();
  const summary: PollSummary = { checked: 0, ok: 0, failed: 0, alerted: 0, recovered: 0, skipped: 0 };

  await inPool(active, deps.concurrency ?? 8, async (box) => {
    const url = healthUrl(path, box, deps.edgeDomain);
    if (!url || busy.has(box.id)) {
      summary.skipped += 1;
      return;
    }
    const r = await probeHealth(url, { fetch: deps.fetch, timeoutMs: deps.timeoutMs });
    const at = now();
    const error = r.error ? redactString(r.error).slice(0, 500) : null;
    summary.checked += 1;
    try {
      await deps.db.insert(boxHealthChecks).values({ boxId: box.id, path, ok: r.ok, httpStatus: r.httpStatus, latencyMs: r.latencyMs, error, checkedAt: at });
      const [row] = await deps.db
        .insert(boxHealth)
        .values({
          boxId: box.id,
          path,
          status: r.ok ? "ok" : "unknown",
          consecutiveFailures: r.ok ? 0 : 1,
          lastCheckedAt: at,
          lastOkAt: r.ok ? at : null,
          lastError: error,
          release: r.releaseTag,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: [boxHealth.boxId, boxHealth.path],
          set: {
            consecutiveFailures: r.ok ? 0 : sql`${boxHealth.consecutiveFailures} + 1`,
            // Below the threshold a failing box keeps its last status (a blip is not an outage).
            status: r.ok
              ? "ok"
              : sql`case when ${boxHealth.consecutiveFailures} + 1 >= ${HEALTH_FAILURE_THRESHOLD} then 'failing' else ${boxHealth.status} end`,
            lastCheckedAt: at,
            lastOkAt: r.ok ? at : sql`${boxHealth.lastOkAt}`,
            lastError: error,
            release: r.releaseTag ?? sql`${boxHealth.release}`,
            updatedAt: at,
          },
        })
        .returning();
      if (path === "direct") {
        // spec §3.2 `last_health`: the latest direct reading, for the admin CLI and the progress page.
        await deps.db
          .update(boxes)
          .set({
            lastHealth: { ...(box.lastHealth ?? {}), status: r.ok ? "ok" : "failing", httpStatus: r.httpStatus, releaseTag: r.releaseTag, checkedAt: at.toISOString(), path: "direct" },
          })
          .where(and(eq(boxes.id, box.id), eq(boxes.state, "active")));
      }
      const failures = row?.consecutiveFailures ?? 0;
      const key = `health:${path}:${box.id}`;
      if (r.ok) {
        summary.ok += 1;
        if (await deps.alerts.resolve(key, `${box.slug} answers health on the ${path} path again`)) summary.recovered += 1;
      } else {
        summary.failed += 1;
        if (failures >= HEALTH_FAILURE_THRESHOLD) {
          await deps.alerts.fire(key, {
            kind: "box_unhealthy",
            subject: `box ${box.slug} failed ${failures} health checks in a row (${path === "direct" ? "Railway host" : "through the router"})`,
            boxId: box.id,
            slug: box.slug,
            error,
            detail: `last ok ${row?.lastOkAt ? row.lastOkAt.toISOString() : "never"}`,
          });
          summary.alerted += 1;
        }
      }
    } catch (err) {
      log.error("could not record a health poll", { err, slug: box.slug });
    }
  });
  return summary;
}
