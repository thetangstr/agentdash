// AgentDash (SC-10, GH #771): the idle policy for Free boxes (spec §5.2,
// founder decision 5).
//
//   day 14  email: "your workspace will pause in 7 days"
//   day 21  suspend: the `suspend` job removes the web deployment (data stays)
//   day 45  email: "your paused workspace will be deleted in 15 days"
//   day 60  the deletion flow (spec §6.5): the box goes `pending_delete`
//
// "Idle" counts from the last human request through the router
// (`last_human_request_at`, never health polls or the assistant endpoint),
// or the claim, or creation, whichever is latest known. Only `plan_tier`
// `free` and `pro_canceled` boxes are subject — a canceled or lapsed Pro
// subscription is Free for this policy (SC-8 review: a lapsed trial must
// not stay exempt forever); paying, trialing and past-due boxes are exempt.
// Only `purpose = 'customer'` boxes are subject either: demo, canary and
// internal boxes are ops-managed (SC-12). A box with a live upgrade row
// (queued/running/rolling_back) is skipped for the sweep while its upgrade
// is in flight. A box with a held Stripe routing conflict (a dead
// `stripe_events` row carrying a binding-conflict reason, SC-8) is left
// alone entirely: its `plan_tier` may be stale because its real checkout is
// the held event, so the sweep alerts ops instead of acting.
//
// Safety:
//   - idle_suspend_enabled and idle_delete_enabled are both OFF by default.
//     Each email is sent only when the step it announces is enabled.
//   - No box is suspended without its warning having gone out at least 7 days
//     before, and none enters deletion without its warning 15 days before, so
//     turning a step on late never surprises a customer: the clock then
//     starts at the email. A failed email means no step.
//   - Deletion also needs the master key escrow on record (spec §5.2 "escrow
//     check"); without it ops is told and nothing happens.
//   - Moving to `pending_delete` deletes nothing. The project, its volumes
//     and its snapshots stay until the §6.5 deletion job, which this sweep
//     does not start.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { accounts, BOX_UPGRADE_LIVE_STATES, boxEvents, boxes, boxIdleNotices, type IdleNoticeKind } from "../db/schema.js";
import { emails, type Mailer } from "../front-door/mailer.js";
import { enqueueJob } from "../jobs/queue.js";
import type { Logger } from "../logger.js";
import { settingsService } from "../settings.js";
import type { AlertCenter } from "./alert-center.js";

export const DAY_MS = 86_400_000;
export const IDLE_DAYS = { suspendWarning: 14, suspend: 21, deleteWarning: 45, delete: 60 } as const;
/** Minimum notice between an email and the step it announces. */
export const SUSPEND_NOTICE_DAYS = IDLE_DAYS.suspend - IDLE_DAYS.suspendWarning;
export const DELETE_NOTICE_DAYS = IDLE_DAYS.delete - IDLE_DAYS.deleteWarning;
/** A box entering deletion keeps its final snapshot this long (spec §6.5). */
export const FINAL_SNAPSHOT_KEEP_DAYS = 30;
export const IDLE_SWEEP_MS = 60 * 60_000;

/** Plans the policy applies to: free, and a Pro subscription that lapsed or was canceled. Anything else is exempt. */
export const IDLE_POLICY_PLANS = ["free", "pro_canceled"] as const;

/** Purposes the policy applies to. demo/canary/internal boxes are ops-managed and exempt (SC-12). */
export const IDLE_POLICY_PURPOSES = ["customer"] as const;

export interface IdleDeps {
  db: CloudDb;
  log: Logger;
  alerts: AlertCenter;
  mailer: Mailer;
  edgeDomain: string;
  now?: () => Date;
}

export interface IdleSummary {
  examined: number;
  suspendWarned: number;
  suspendQueued: number;
  deleteWarned: number;
  deleteStarted: number;
  blocked: number;
}

type BoxRow = typeof boxes.$inferSelect;

export function idleSince(box: Pick<BoxRow, "lastHumanRequestAt" | "claimedAt" | "createdAt">): Date {
  return box.lastHumanRequestAt ?? box.claimedAt ?? box.createdAt;
}

export function idleDays(box: Pick<BoxRow, "lastHumanRequestAt" | "claimedAt" | "createdAt">, now: Date): number {
  return (now.getTime() - idleSince(box).getTime()) / DAY_MS;
}

/** What the policy would do next for a box, for `box health` and `fleet status`. */
export function nextIdleStep(
  box: Pick<BoxRow, "state" | "planTier" | "purpose" | "lastHumanRequestAt" | "claimedAt" | "createdAt">,
  now: Date,
  settings: { idle_suspend_enabled: boolean; idle_delete_enabled: boolean },
): string {
  if (!(IDLE_POLICY_PLANS as readonly string[]).includes(box.planTier)) return `exempt (plan ${box.planTier})`;
  if (!(IDLE_POLICY_PURPOSES as readonly string[]).includes(box.purpose)) return `exempt (purpose ${box.purpose})`;
  const since = idleSince(box).getTime();
  const at = (days: number) => new Date(since + days * DAY_MS).toISOString();
  if (box.state === "active") {
    if (!settings.idle_suspend_enabled) return "none (idle_suspend_enabled is off)";
    return `pause warning from ${at(IDLE_DAYS.suspendWarning)}, pause from ${at(IDLE_DAYS.suspend)} (at least ${SUSPEND_NOTICE_DAYS} days after the warning)`;
  }
  if (box.state === "suspended") {
    if (!settings.idle_delete_enabled) return "none (idle_delete_enabled is off)";
    return `deletion warning from ${at(IDLE_DAYS.deleteWarning)}, deletion flow from ${at(IDLE_DAYS.delete)} (at least ${DELETE_NOTICE_DAYS} days after the warning)`;
  }
  return `none (box is ${box.state})`;
}

async function notice(db: CloudDb, boxId: string, kind: IdleNoticeKind, since: Date) {
  const [row] = await db
    .select()
    .from(boxIdleNotices)
    .where(and(eq(boxIdleNotices.boxId, boxId), eq(boxIdleNotices.kind, kind), eq(boxIdleNotices.idleSince, since)));
  return row ?? null;
}

export async function sweepIdle(deps: IdleDeps): Promise<IdleSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log.child({ component: "idle-policy" });
  const settings = await settingsService(deps.db).getAll();
  const summary: IdleSummary = { examined: 0, suspendWarned: 0, suspendQueued: 0, deleteWarned: 0, deleteStarted: 0, blocked: 0 };
  if (!settings.idle_suspend_enabled && !settings.idle_delete_enabled) return summary;

  const rows = await deps.db
    .select({
      box: boxes,
      email: accounts.email,
      // A Stripe event naming this box is held as a routing conflict (dead,
      // with a binding-conflict reason; SC-8). The box's own checkout may be
      // that event, so plan_tier can be stale and the box must not be warned,
      // suspended or deleted while the conflict stands. Matching by slug: the
      // held row's box_id is the *other* box (or null), never the named one.
      heldStripeConflict: sql<boolean>`exists (select 1 from stripe_events e where e.box_slug = ${boxes.slug} and e.state = 'dead' and e.reason in ('customer_bound_to_another_box', 'box_bound_to_another_customer'))`,
    })
    .from(boxes)
    .innerJoin(accounts, eq(accounts.id, boxes.accountId))
    .where(
      and(
        inArray(boxes.planTier, [...IDLE_POLICY_PLANS]),
        inArray(boxes.purpose, [...IDLE_POLICY_PURPOSES]),
        inArray(boxes.state, ["active", "suspended"]),
        // A box whose upgrade is queued, running or rolling back is left alone (the
        // box_upgrades_one_live_per_box_uq "live" states, SC-12). The upgrade's own
        // prepare step skips a suspended box, so pausing it first only wastes the slot;
        // the sweep picks the box up again once the upgrade row is done.
        sql`not exists (select 1 from box_upgrades u where u.box_id = ${boxes.id} and u.state in (${sql.join(
          BOX_UPGRADE_LIVE_STATES.map((s) => sql`${s}`),
          sql`, `,
        )}))`,
      ),
    );
  const url = (slug: string) => `https://${slug}.${deps.edgeDomain}`;

  const sendNotice = async (box: BoxRow, email: string, kind: IdleNoticeKind, since: Date, stepAt: Date): Promise<boolean> => {
    const message =
      kind === "suspend_warning"
        ? emails.idleSuspendWarning(email, { slug: box.slug, url: url(box.slug), pauseOn: stepAt })
        : emails.idleDeleteWarning(email, { slug: box.slug, url: url(box.slug), deleteOn: stepAt });
    try {
      await deps.mailer.send(message);
    } catch (err) {
      log.error("idle email failed; the step it announces waits for it", { err, slug: box.slug, kind });
      return false;
    }
    const inserted = await deps.db.insert(boxIdleNotices).values({ boxId: box.id, kind, idleSince: since, sentAt: now }).onConflictDoNothing().returning();
    if (inserted.length) {
      await deps.db.insert(boxEvents).values({ boxId: box.id, kind: `idle_${kind}_sent`, actor: "idle-policy", detail: { idleSince: since.toISOString(), stepAt: stepAt.toISOString() } });
    }
    return true;
  };

  for (const { box, email, heldStripeConflict } of rows) {
    summary.examined += 1;
    const since = idleSince(box);
    const days = idleDays(box, now);
    try {
      if (heldStripeConflict) {
        // Exempt until an operator resolves the conflict (redelivery clears the
        // dead row); alert only once the box is far enough along for a step to
        // matter, so a fresh box does not page anyone.
        const due =
          (box.state === "active" && settings.idle_suspend_enabled && days >= IDLE_DAYS.suspendWarning) ||
          (box.state === "suspended" && settings.idle_delete_enabled && days >= IDLE_DAYS.deleteWarning);
        if (due) {
          summary.blocked += 1;
          await deps.alerts.fire(`idle_stripe_conflict:${box.id}`, {
            kind: "idle_policy",
            subject: `box ${box.slug} (idle ${Math.floor(days)} days, plan ${box.planTier}) has a held Stripe routing conflict; the idle policy is not touching it`,
            boxId: box.id,
            slug: box.slug,
            detail: "its real checkout may be the held event, so plan_tier can be stale; resolve the binding and redeliver (`admin stripe events dead`, `admin stripe redeliver`) and the policy applies again",
          });
        }
        continue;
      }
      if (box.state === "active" && settings.idle_suspend_enabled) {
        const warned = await notice(deps.db, box.id, "suspend_warning", since);
        if (!warned) {
          if (days >= IDLE_DAYS.suspendWarning) {
            const pauseOn = new Date(Math.max(since.getTime() + IDLE_DAYS.suspend * DAY_MS, now.getTime() + SUSPEND_NOTICE_DAYS * DAY_MS));
            if (await sendNotice(box, email, "suspend_warning", since, pauseOn)) summary.suspendWarned += 1;
          }
          continue;
        }
        if (days >= IDLE_DAYS.suspend && now.getTime() - warned.sentAt.getTime() >= SUSPEND_NOTICE_DAYS * DAY_MS) {
          const { created } = await enqueueJob(deps.db, {
            boxId: box.id,
            kind: "suspend",
            payload: { reason: "idle", requestedBy: "idle-policy", idleSince: since.toISOString() },
          });
          if (created) {
            await deps.db.insert(boxEvents).values({ boxId: box.id, kind: "idle_suspend_queued", actor: "idle-policy", detail: { idleDays: Math.floor(days) } });
            summary.suspendQueued += 1;
          }
        }
        continue;
      }
      if (box.state === "suspended" && settings.idle_delete_enabled) {
        const warned = await notice(deps.db, box.id, "delete_warning", since);
        if (!warned) {
          if (days >= IDLE_DAYS.deleteWarning) {
            const deleteOn = new Date(Math.max(since.getTime() + IDLE_DAYS.delete * DAY_MS, now.getTime() + DELETE_NOTICE_DAYS * DAY_MS));
            if (await sendNotice(box, email, "delete_warning", since, deleteOn)) summary.deleteWarned += 1;
          }
          continue;
        }
        if (days < IDLE_DAYS.delete || now.getTime() - warned.sentAt.getTime() < DELETE_NOTICE_DAYS * DAY_MS) continue;
        if (!box.masterKeyEscrow) {
          summary.blocked += 1;
          await deps.alerts.fire(`idle_delete_blocked:${box.id}`, {
            kind: "idle_policy",
            subject: `box ${box.slug} is due for deletion (idle ${Math.floor(days)} days) but has no master key escrow on record; not entering deletion`,
            boxId: box.id,
            slug: box.slug,
            detail: "escrow the key (or decide by hand) before the box can enter the deletion flow",
          });
          continue;
        }
        const deleteAfter = new Date(now.getTime() + FINAL_SNAPSHOT_KEEP_DAYS * DAY_MS);
        const moved = await deps.db.transaction(async (tx) => {
          const r = await tx
            .update(boxes)
            .set({ state: "pending_delete", deleteAfter, updatedAt: now })
            .where(and(eq(boxes.id, box.id), eq(boxes.state, "suspended"), inArray(boxes.planTier, [...IDLE_POLICY_PLANS]),
              // Untouched since the sweep read it: a visit to the waking page touches
              // last_human_request_at under the row lock (edge_request_resume, migration 0009).
              sql`date_trunc('milliseconds', ${boxes.lastHumanRequestAt}) is not distinct from ${box.lastHumanRequestAt?.toISOString() ?? null}::timestamptz`,
              // And no wake queued or deploying (an operator wake does not touch the idle clock).
              sql`not exists (select 1 from jobs j where j.box_id = ${boxes.id} and j.kind = 'resume' and j.state in ('queued', 'running'))`,
              // And no Stripe routing conflict was held since the sweep read the row (SC-8 review).
              sql`not exists (select 1 from stripe_events e where e.box_slug = ${boxes.slug} and e.state = 'dead' and e.reason in ('customer_bound_to_another_box', 'box_bound_to_another_customer'))`))
            .returning({ id: boxes.id });
          if (r.length) {
            await tx.insert(boxEvents).values({
              boxId: box.id,
              kind: "idle_delete_started",
              actor: "idle-policy",
              detail: { idleDays: Math.floor(days), deleteAfter: deleteAfter.toISOString(), flow: "spec §6.5" },
            });
          }
          return r.length > 0;
        });
        if (moved) {
          summary.deleteStarted += 1;
          await deps.alerts.notify({
            kind: "idle_policy",
            subject: `box ${box.slug} entered the deletion flow after ${Math.floor(days)} idle days (pending_delete)`,
            boxId: box.id,
            slug: box.slug,
            detail: `nothing is deleted yet; the §6.5 deletion job (Stripe, Resend key, final snapshot kept ${FINAL_SNAPSHOT_KEEP_DAYS} days, project delete) runs from delete_after ${deleteAfter.toISOString()}`,
          });
        }
      }
    } catch (err) {
      log.error("idle policy failed for a box", { err, slug: box.slug });
    }
  }
  return summary;
}
