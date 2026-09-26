// AgentDash: putting work on the job queue (spec §3.4, §5.1, GH #764).
// The kill switch, waitlist mode and the daily cap are enforced HERE, when a
// provision is requested: a box that may not be provisioned now goes to
// `waitlisted` (and onto the waitlist) instead of getting a job.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { accounts, boxEvents, boxes, jobs, waitlist, type JobKind } from "../db/schema.js";
import { settingsService } from "../settings.js";

const ENQUEUE_LOCK_KEY = 764_002;

type Tx = Parameters<Parameters<CloudDb["transaction"]>[0]>[0];

/**
 * Add a job unless a live one (queued or running) of that kind already
 * exists for the box; returns the live job's id either way.
 */
export async function enqueueJob(
  db: CloudDb | Tx,
  input: { boxId: string; kind: JobKind; payload?: Record<string, unknown>; runAfter?: Date; maxAttempts?: number },
): Promise<{ id: string; created: boolean }> {
  const inserted = await db
    .insert(jobs)
    .values({
      boxId: input.boxId,
      kind: input.kind,
      payload: input.payload ?? null,
      runAfter: input.runAfter ?? new Date(),
      ...(input.maxAttempts ? { maxAttempts: input.maxAttempts } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const [live] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.boxId, input.boxId), eq(jobs.kind, input.kind), inArray(jobs.state, ["queued", "running"])));
  if (!live) throw new Error(`could not enqueue ${input.kind} for box ${input.boxId}`);
  return { id: live.id, created: false };
}

export type WaitlistReason = "kill_switch" | "waitlist_mode" | "daily_cap";

export type ProvisionRequestResult =
  | { outcome: "queued"; jobId: string }
  | { outcome: "waitlisted"; reason: WaitlistReason };

export class ProvisionRequestError extends Error {}

/** Provision jobs created since 00:00 UTC today (the daily cap's window). */
export async function provisionsToday(db: CloudDb | Tx): Promise<number> {
  const rows = (await db.execute(
    sql`select count(*)::int as n from jobs where kind = 'provision' and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/**
 * Ask for a box to be provisioned. `approved` is true when an operator
 * approved it off the waitlist (waitlist mode no longer applies; the kill
 * switch and the daily cap still do). Serialised by an advisory lock so two
 * requests cannot both take the last slot under the cap.
 */
export async function requestProvision(
  db: CloudDb,
  boxId: string,
  opts: { actor: string; approved?: boolean },
): Promise<ProvisionRequestResult> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ENQUEUE_LOCK_KEY})`);
    const [box] = await tx.select().from(boxes).where(eq(boxes.id, boxId)).for("update");
    if (!box) throw new ProvisionRequestError(`no box ${boxId}`);
    if (box.state !== "requested" && box.state !== "waitlisted") {
      throw new ProvisionRequestError(`box ${box.slug} is ${box.state}; only a requested or waitlisted box can be provisioned`);
    }
    const settings = await settingsService(tx as unknown as CloudDb).getAll();
    let reason: WaitlistReason | null = null;
    if (!settings.provisioning_enabled) reason = "kill_switch";
    else if (settings.waitlist_mode && !opts.approved) reason = "waitlist_mode";
    else if ((await provisionsToday(tx)) >= settings.daily_cap) reason = "daily_cap";

    if (reason) {
      if (box.state === "requested") {
        await tx.update(boxes).set({ state: "waitlisted", updatedAt: new Date() }).where(eq(boxes.id, box.id));
      }
      const [existing] = await tx
        .select({ id: waitlist.id })
        .from(waitlist)
        .where(and(eq(waitlist.accountId, box.accountId), inArray(waitlist.state, ["waiting", "approved"])));
      if (!existing) {
        const [acct] = await tx.select({ email: accounts.email }).from(accounts).where(eq(accounts.id, box.accountId));
        await tx.insert(waitlist).values({
          accountId: box.accountId,
          email: acct?.email ?? "",
          requestedSlug: box.slug,
          ...(opts.approved ? { state: "approved" as const, approvedAt: new Date(), approvedBy: opts.actor } : {}),
        });
      }
      await tx.insert(boxEvents).values({ boxId: box.id, kind: "provision_waitlisted", actor: opts.actor, detail: { reason } });
      return { outcome: "waitlisted", reason };
    }

    await tx.update(boxes).set({ state: "provisioning", updatedAt: new Date() }).where(eq(boxes.id, box.id));
    const { id } = await enqueueJob(tx, { boxId: box.id, kind: "provision", payload: { requestedBy: opts.actor } });
    await tx.insert(boxEvents).values({ boxId: box.id, kind: "provision_queued", actor: opts.actor, detail: { jobId: id } });
    return { outcome: "queued", jobId: id };
  });
}
