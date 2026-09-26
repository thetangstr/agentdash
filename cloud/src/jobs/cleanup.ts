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
import { FatalJobError } from "./errors.js";
import { enqueueJob } from "./queue.js";
import type { JobHandler } from "./runner.js";

export const UNCLAIMED_DAYS = 7;

export async function sweepCleanup(db: CloudDb, log: Logger, actor = "cleanup-sweep"): Promise<{ expired: number; enqueued: number }> {
  const expired = (await db.execute(sql`
    update boxes set state = 'cleanup', updated_at = now()
     where state = 'awaiting_claim' and claimed_at is null
       and coalesce(claim_expires_at, updated_at + ${UNCLAIMED_DAYS} * interval '1 day') < now()
    returning id, slug`)) as unknown as Array<{ id: string; slug: string }>;
  for (const b of expired) {
    await db.insert(boxEvents).values({ boxId: b.id, kind: "unclaimed_expired", actor, detail: { days: UNCLAIMED_DAYS } });
    log.info("unclaimed box expired; queued for cleanup", { slug: b.slug });
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
  return { expired: expired.length, enqueued };
}

export function deleteHandler(deps: { client: RailwayClient; workspaceId: string }): JobHandler {
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
