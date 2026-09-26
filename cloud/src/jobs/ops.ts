// AgentDash: operator actions on a failed box (spec §3.4, GH #764), used by
// the admin CLI through /internal:
//   retry    resumes the failed job AT ITS FAILED STEP, with fresh attempts
//            and a fresh time cap;
//   abandon  gives up on the box and sends it through the guarded delete.
import { and, desc, eq, inArray } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { boxEvents, boxes, jobs } from "../db/schema.js";
import { enqueueJob } from "./queue.js";

export class BoxOpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function retryBox(db: CloudDb, slug: string, actor: string): Promise<{ jobId: string; step: string | null }> {
  return await db.transaction(async (tx) => {
    const [box] = await tx.select().from(boxes).where(eq(boxes.slug, slug)).for("update");
    if (!box) throw new BoxOpError(`no box ${slug}`, 404);
    if (box.state !== "failed") throw new BoxOpError(`box ${slug} is ${box.state}; only a failed box can be retried`, 409);
    const [job] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.boxId, box.id), eq(jobs.kind, "provision")))
      .orderBy(desc(jobs.createdAt))
      .limit(1)
      .for("update");
    if (!job) throw new BoxOpError(`box ${slug} has no provision job`, 409);
    if (job.state === "dead") {
      throw new BoxOpError(`the provision job for ${slug} is dead (a safety rule refused it: ${job.lastError ?? "see box events"}); fix the cause, then abandon or repair by hand`, 409);
    }
    if (job.state !== "failed") throw new BoxOpError(`the provision job for ${slug} is ${job.state}`, 409);
    await tx
      .update(jobs)
      .set({ state: "queued", attempt: 0, startedAt: null, finishedAt: null, runAfter: new Date(), lockedBy: null, lockedUntil: null, updatedAt: new Date() })
      .where(eq(jobs.id, job.id));
    await tx.update(boxes).set({ state: "provisioning", updatedAt: new Date() }).where(eq(boxes.id, box.id));
    await tx.insert(boxEvents).values({ boxId: box.id, kind: "retry_requested", actor, detail: { jobId: job.id, step: job.step } });
    return { jobId: job.id, step: job.step };
  });
}

export async function abandonBox(db: CloudDb, slug: string, actor: string): Promise<{ deleteJobId: string }> {
  return await db.transaction(async (tx) => {
    const [box] = await tx.select().from(boxes).where(eq(boxes.slug, slug)).for("update");
    if (!box) throw new BoxOpError(`no box ${slug}`, 404);
    if (box.claimedAt) throw new BoxOpError(`box ${slug} was claimed; a claimed box is deleted only through the customer deletion flow`, 409);
    if (box.state !== "failed") throw new BoxOpError(`box ${slug} is ${box.state}; only a failed box can be abandoned`, 409);
    await tx
      .update(jobs)
      .set({ state: "dead", finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(jobs.boxId, box.id), inArray(jobs.state, ["failed"])));
    await tx.update(boxes).set({ state: "cleanup", updatedAt: new Date() }).where(eq(boxes.id, box.id));
    const { id } = await enqueueJob(tx, { boxId: box.id, kind: "delete", payload: { reason: "abandoned", requestedBy: actor } });
    await tx.insert(boxEvents).values({ boxId: box.id, kind: "abandoned", actor, detail: { deleteJobId: id } });
    return { deleteJobId: id };
  });
}
