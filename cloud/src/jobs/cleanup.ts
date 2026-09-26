// AgentDash: cleanup of unclaimed and abandoned boxes (spec §3.4, GH #764).
//   sweepCleanup  moves boxes unclaimed past their claim window (7 days) to
//                 `cleanup` and makes sure every `cleanup` box has a delete job;
//   deleteHandler the `delete` job: the guarded delete from
//                 ../railway/delete.ts, then the box is `deleted`.
// A guard refusal is a FatalJobError: the job goes dead, ops is paged, and
// nothing is deleted.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { boxEvents, boxes } from "../db/schema.js";
import type { Logger } from "../logger.js";
import type { RailwayClient } from "../railway/client.js";
import { DeleteRefused, guardedDeleteBoxProject } from "../railway/delete.js";
import { ProjectNameRefused } from "../railway/names.js";
import type { Alerter } from "./alerts.js";
import { probeClaim } from "./claim.js";
import { FatalJobError } from "./errors.js";
import { enqueueJob } from "./queue.js";
import type { JobHandler } from "./runner.js";

export const UNCLAIMED_DAYS = 7;
const FLAG_EVERY_HOURS = 24;

export interface SweepOptions {
  actor?: string;
  fetch?: typeof fetch;
  alerter?: Alerter;
}

/**
 * GH #800 security review: a box is moved to cleanup ONLY on positive
 * evidence from its own health that it is unclaimed, and only after its claim
 * window. A box that reports a claim becomes `active`. A box past its window
 * whose claim state is unknown is never touched; an operator is told instead
 * (at most once a day per box).
 */
export async function sweepCleanup(db: CloudDb, log: Logger, opts: SweepOptions = {}): Promise<{ claimed: number; expired: number; flagged: number; enqueued: number }> {
  const actor = opts.actor ?? "cleanup-sweep";
  const waiting = await db.select().from(boxes).where(eq(boxes.state, "awaiting_claim"));
  let claimed = 0;
  let expired = 0;
  let flagged = 0;
  for (const box of waiting) {
    const probe = await probeClaim(box.upstreamHost, { fetch: opts.fetch });
    const lastHealth = { ...(probe.health ?? {}), claimProbe: probe.state, claimProbeReason: probe.reason, checkedAt: new Date().toISOString() };
    if (probe.state === "claimed") {
      const moved = await db
        .update(boxes)
        .set({ state: "active", claimedAt: box.claimedAt ?? new Date(), lastHealth, updatedAt: new Date() })
        .where(and(eq(boxes.id, box.id), eq(boxes.state, "awaiting_claim")))
        .returning({ id: boxes.id });
      if (moved.length) {
        await db.insert(boxEvents).values({ boxId: box.id, kind: "claim_seen", actor, detail: { reason: probe.reason } });
        // AgentDash (#767): close sign-up on the box (variables ride the next deploy).
        await enqueueJob(db, { boxId: box.id, kind: "close_signup", payload: { reason: "claim_seen" } });
        claimed += 1;
      }
      continue;
    }
    await db.update(boxes).set({ lastHealth }).where(eq(boxes.id, box.id));
    const windowEnd = box.claimExpiresAt ?? new Date(box.createdAt.getTime() + UNCLAIMED_DAYS * 86_400_000);
    if (windowEnd.getTime() > Date.now() || box.claimedAt) continue;
    if (probe.state === "unclaimed") {
      const moved = await db
        .update(boxes)
        .set({ state: "cleanup", updatedAt: new Date() })
        .where(and(eq(boxes.id, box.id), eq(boxes.state, "awaiting_claim"), isNull(boxes.claimedAt)))
        .returning({ id: boxes.id });
      if (moved.length) {
        await db.insert(boxEvents).values({ boxId: box.id, kind: "unclaimed_expired", actor, detail: { days: UNCLAIMED_DAYS, evidence: probe.reason } });
        log.info("unclaimed box expired; queued for cleanup", { slug: box.slug });
        expired += 1;
      }
      continue;
    }
    // Unknown: never delete. Flag for an operator, at most once a day.
    const recent = (await db.execute(sql`
      select 1 from box_events where box_id = ${box.id} and kind = 'cleanup_needs_operator'
         and created_at > now() - ${FLAG_EVERY_HOURS} * interval '1 hour' limit 1`)) as unknown as unknown[];
    if (!recent.length) {
      await db.insert(boxEvents).values({ boxId: box.id, kind: "cleanup_needs_operator", actor, detail: { reason: probe.reason } });
      await opts.alerter
        ?.send({ kind: "cleanup_refused", subject: `box ${box.slug} is past its claim window but its claim state is unknown; not deleted`, boxId: box.id, slug: box.slug, error: probe.reason })
        .catch((err: unknown) => log.error("alert failed", { err }));
      log.warn("box past its claim window with an unknown claim state; not deleting, operator flagged", { slug: box.slug, reason: probe.reason });
      flagged += 1;
    }
  }
  // Every cleanup box needs a delete job; a dead one (a guard refused) is left for an operator.
  const pending = (await db.execute(sql`
    select b.id from boxes b
     where b.state = 'cleanup'
       and not exists (select 1 from jobs j where j.box_id = b.id and j.kind = 'delete' and j.state in ('queued', 'running', 'dead'))`)) as unknown as Array<{ id: string }>;
  let enqueued = 0;
  for (const b of pending) {
    const r = await enqueueJob(db, { boxId: b.id, kind: "delete", payload: { reason: "cleanup" } });
    if (r.created) enqueued += 1;
  }
  return { claimed, expired, flagged, enqueued };
}

export function deleteHandler(deps: { client: RailwayClient; workspaceId: string; fetch?: typeof fetch }): JobHandler {
  return {
    kind: "delete",
    maxDurationMs: 30 * 60_000,
    steps: [
      {
        name: "delete_project",
        timeoutMs: 2 * 60_000,
        async run(ctx) {
          const box = await ctx.box();
          if (box.state === "deleted") return;
          if (box.state !== "cleanup") throw new FatalJobError(`box ${box.slug} is ${box.state}, not cleanup; refusing to delete`);
          // A box that was ever handed over (box_ready) may be in use: re-check its own health right
          // before deleting, and delete only on positive evidence that it is unclaimed (GH #800).
          const handedOver = await ctx.db
            .select({ id: boxEvents.id })
            .from(boxEvents)
            .where(and(eq(boxEvents.boxId, box.id), eq(boxEvents.kind, "box_ready")))
            .limit(1);
          if (handedOver.length) {
            const probe = await probeClaim(box.upstreamHost, { fetch: deps.fetch });
            if (probe.state !== "unclaimed") {
              throw new FatalJobError(`box ${box.slug} was handed over and its claim state is ${probe.state} (${probe.reason}); refusing to delete without positive evidence it is unclaimed`);
            }
          }
          try {
            const r = await guardedDeleteBoxProject(deps.client, box, { workspaceId: deps.workspaceId, signal: ctx.signal });
            ctx.log.info("box project delete", { slug: box.slug, result: r });
          } catch (err) {
            if (err instanceof DeleteRefused || err instanceof ProjectNameRefused) throw new FatalJobError(err.message);
            throw err;
          }
        },
      },
      {
        name: "mark_deleted",
        timeoutMs: 30_000,
        async run(ctx) {
          const updated = await ctx.db
            .update(boxes)
            .set({ state: "deleted", updatedAt: new Date() })
            .where(and(eq(boxes.id, ctx.job.boxId), eq(boxes.state, "cleanup"), isNull(boxes.claimedAt)))
            .returning({ id: boxes.id });
          if (updated.length) {
            await ctx.db.insert(boxEvents).values({ boxId: ctx.job.boxId, kind: "box_deleted", actor: "delete-job", detail: { jobId: ctx.job.id } });
          }
        },
      },
    ],
  };
}
