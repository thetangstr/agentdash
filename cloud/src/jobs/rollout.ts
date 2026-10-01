// AgentDash: the fleet rollout orchestrator (spec §6.1, SC-12, GH #773).
//
//   start   target_release must name a tag with a GHCR image (refused
//           otherwise); its digest is resolved once. Every upgradable box
//           is planned into waves, stored as box_upgrades rows:
//             wave 0  canary boxes (purpose = canary, GH #861)
//             wave 1  10 percent of the rest, oldest first (at least one)
//             wave 2… batches of 5, oldest first
//           Held boxes (hold_upgrades; demo boxes by default), boxes already
//           on the release and suspended boxes are recorded as skipped.
//   tick    every minute (and on demand). Under an advisory lock, so two
//           control-plane replicas never double-enqueue: settle upgrades
//           whose job gave up; stop while rollout_paused; wait while a wave
//           is in flight; otherwise, inside the nightly window (or always,
//           for a rollout started with "now"), enqueue the next wave's
//           upgrade jobs. All state is in the database, so a restarted
//           control plane carries on from the rows.
//   pause / resume   the rollout_paused setting (audited). The first failed
//           upgrade sets it (./upgrade.ts); resume clears it. Failed boxes
//           stay held until an operator unholds them.
//   upgrade one box  an operator's single-box upgrade (no rollout), at once
//           or at the next window opening.
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import {
  BOX_UPGRADE_LIVE_STATES,
  boxEvents,
  boxes,
  boxUpgrades,
  jobs,
  rollouts,
  type BoxPurpose,
} from "../db/schema.js";
import type { Logger } from "../logger.js";
import { ImageNotFound, RELEASE_TAG_RE, resolveImageDigest, resolveTagCommit } from "../railway/image.js";
import { settingsService } from "../settings.js";
import { enqueueJob } from "./queue.js";
import { holdAndPause, ineligibleReason, type UpgradeRow } from "./upgrade.js";
import { inWindow, nextWindowStart, parseWindow, type UpgradeWindow } from "./upgrade-window.js";

const ROLLOUT_LOCK_KEY = 773_001;
export const TEN_PERCENT_WAVE = 1;
export const BATCH_SIZE = 5;

export class RolloutError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RolloutError";
  }
}

export interface ReleaseResolverDeps {
  imageRepo: string;
  sourceRepo: string;
  fetch?: typeof fetch;
}

/** The release's GHCR digest (required: tags without one are refused, spec §6.1) and, best effort, its commit. */
export async function resolveRelease(deps: ReleaseResolverDeps, tag: string): Promise<{ digest: string; commit: string | null }> {
  if (!RELEASE_TAG_RE.test(tag)) throw new RolloutError(`not a release tag: ${tag}`, 400);
  let digest: string;
  try {
    digest = await resolveImageDigest(deps.imageRepo, tag, { fetch: deps.fetch });
  } catch (err) {
    if (err instanceof ImageNotFound) throw new RolloutError(`no GHCR image for ${tag} at ${deps.imageRepo}; fleet upgrades are image-only (spec §6.1)`, 409);
    throw err;
  }
  const commit = await resolveTagCommit(deps.sourceRepo, tag, { fetch: deps.fetch }).catch(() => null);
  return { digest, commit };
}

export interface PlanCandidate {
  id: string;
  purpose: BoxPurpose;
  createdAt: Date;
}

/** Wave per box id: canaries first, then 10 percent oldest-first, then batches of 5. */
export function planWaves(candidates: PlanCandidate[]): Map<string, number> {
  const byAge = (a: PlanCandidate, b: PlanCandidate) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
  const waves = new Map<string, number>();
  const canary = candidates.filter((c) => c.purpose === "canary").sort(byAge);
  const rest = candidates.filter((c) => c.purpose !== "canary").sort(byAge);
  for (const c of canary) waves.set(c.id, 0);
  const first = rest.length ? Math.max(1, Math.ceil(rest.length * 0.1)) : 0;
  rest.forEach((c, i) => waves.set(c.id, i < first ? TEN_PERCENT_WAVE : TEN_PERCENT_WAVE + 1 + Math.floor((i - first) / BATCH_SIZE)));
  return waves;
}

async function windowOf(db: CloudDb): Promise<UpgradeWindow | null> {
  const s = await settingsService(db).getAll();
  return parseWindow(s.upgrade_window, s.upgrade_window_tz);
}

export async function startRollout(
  db: CloudDb,
  deps: ReleaseResolverDeps,
  opts: { actor: string; now?: boolean },
): Promise<Record<string, unknown>> {
  const settings = await settingsService(db).getAll();
  const tag = settings.target_release;
  if (!tag) throw new RolloutError("target_release is not set; set it to the release to roll out (settings set target_release vYYYY.MDD.N)", 409);
  if (settings.rollout_paused) throw new RolloutError("rollout_paused is on; resume (rollout resume) or clear it before starting a rollout", 409);
  const [live] = await db.select({ id: rollouts.id }).from(rollouts).where(eq(rollouts.state, "running"));
  if (live) throw new RolloutError(`rollout ${live.id} is still running; cancel it or let it finish`, 409);
  const { digest, commit } = await resolveRelease(deps, tag);

  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROLLOUT_LOCK_KEY})`);
    const [again] = await tx.select({ id: rollouts.id }).from(rollouts).where(eq(rollouts.state, "running"));
    if (again) throw new RolloutError(`rollout ${again.id} is still running`, 409);
    const [rollout] = await tx
      .insert(rollouts)
      .values({ releaseTag: tag, imageDigest: digest, releaseCommit: commit, ignoreWindow: opts.now === true, createdBy: opts.actor })
      .returning();
    const fleet = await tx
      .select()
      .from(boxes)
      .where(inArray(boxes.state, ["active", "awaiting_claim", "suspended"]))
      .orderBy(asc(boxes.createdAt));
    const skipped: Array<{ slug: string; reason: string }> = [];
    const candidates: PlanCandidate[] = [];
    for (const b of fleet) {
      const reason = b.releaseTag === tag && b.imageDigest === digest ? `already on ${tag}` : ineligibleReason(b);
      if (reason) skipped.push({ slug: b.slug, reason });
      else candidates.push({ id: b.id, purpose: b.purpose, createdAt: b.createdAt });
    }
    const waves = planWaves(candidates);
    const slugOf = new Map(fleet.map((b) => [b.id, b.slug]));
    const rows: Array<typeof boxUpgrades.$inferInsert> = [
      ...[...waves].map(([boxId, wave]) => ({ boxId, rolloutId: rollout!.id, wave, state: "planned" as const, toTag: tag, toDigest: digest, toCommit: commit })),
      ...fleet
        .filter((b) => !waves.has(b.id))
        .map((b) => ({
          boxId: b.id,
          rolloutId: rollout!.id,
          wave: -1,
          state: "skipped" as const,
          toTag: tag,
          toDigest: digest,
          toCommit: commit,
          error: skipped.find((s) => s.slug === b.slug)?.reason ?? "ineligible",
          finishedAt: new Date(),
        })),
    ];
    if (rows.length) await tx.insert(boxUpgrades).values(rows);
    await tx.insert(boxEvents).values({
      kind: "rollout_started",
      actor: opts.actor,
      detail: { rolloutId: rollout!.id, releaseTag: tag, imageDigest: digest, planned: waves.size, skipped: skipped.length, now: opts.now === true },
    });
    const plan = new Map<number, string[]>();
    for (const [id, w] of [...waves].sort((a, b) => a[1] - b[1])) plan.set(w, [...(plan.get(w) ?? []), slugOf.get(id)!]);
    return {
      rolloutId: rollout!.id,
      releaseTag: tag,
      imageDigest: digest,
      releaseCommit: commit,
      ignoreWindow: opts.now === true,
      waves: [...plan].map(([wave, slugs]) => ({ wave, slugs })),
      skipped,
      ...(candidates.some((c) => c.purpose === "canary") ? {} : { warning: "no canary box (purpose canary): the first wave is 10 percent of customer boxes" }),
    };
  });
}

export type TickResult =
  | { action: "idle" }
  | { action: "paused"; rolloutId: string }
  | { action: "waiting"; rolloutId: string; wave: number; inFlight: number }
  | { action: "outside_window"; rolloutId: string; wave: number; opensAt: string }
  | { action: "started_wave"; rolloutId: string; wave: number; queued: string[]; skipped: string[] }
  | { action: "completed"; rolloutId: string };

/** One orchestrator pass. Safe to run from several replicas and at any time. */
export async function tickRollout(db: CloudDb, opts: { now?: Date; log?: Logger } = {}): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const result = await db.transaction(async (tx): Promise<TickResult & { failures?: UpgradeRow[] }> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROLLOUT_LOCK_KEY})`);
    const [rollout] = await tx.select().from(rollouts).where(eq(rollouts.state, "running"));
    if (!rollout) return { action: "idle" };
    const txDb = tx as unknown as CloudDb;

    // Settle upgrades whose job ended without the job settling them (a crash in onGiveUp).
    const live = await tx
      .select({ up: boxUpgrades, jobState: jobs.state, jobError: jobs.lastError })
      .from(boxUpgrades)
      .leftJoin(jobs, eq(jobs.id, boxUpgrades.jobId))
      .where(and(eq(boxUpgrades.rolloutId, rollout.id), inArray(boxUpgrades.state, [...BOX_UPGRADE_LIVE_STATES])));
    const failures: UpgradeRow[] = [];
    let inFlight = 0;
    for (const { up, jobState, jobError } of live) {
      if (jobState === "failed" || jobState === "dead" || jobState === "succeeded") {
        const error = `upgrade job ended ${jobState} without settling: ${jobError ?? "no error recorded"}`;
        await tx.update(boxUpgrades).set({ state: "failed", error: error.slice(0, 1000), finishedAt: now, updatedAt: now }).where(eq(boxUpgrades.id, up.id));
        failures.push({ ...up, state: "failed", error });
      } else {
        inFlight += 1;
      }
    }
    if (failures.length) return { action: "paused", rolloutId: rollout.id, failures };

    if (await settingsService(txDb).get("rollout_paused")) return { action: "paused", rolloutId: rollout.id };
    const [nextRow] = await tx
      .select({ wave: boxUpgrades.wave })
      .from(boxUpgrades)
      .where(and(eq(boxUpgrades.rolloutId, rollout.id), eq(boxUpgrades.state, "planned")))
      .orderBy(asc(boxUpgrades.wave))
      .limit(1);
    if (inFlight > 0) return { action: "waiting", rolloutId: rollout.id, wave: nextRow?.wave ?? -1, inFlight };
    if (!nextRow) {
      await tx.update(rollouts).set({ state: "completed", finishedAt: now, updatedAt: now }).where(eq(rollouts.id, rollout.id));
      await tx.insert(boxEvents).values({ kind: "rollout_completed", actor: "rollout", detail: { rolloutId: rollout.id, releaseTag: rollout.releaseTag } });
      return { action: "completed", rolloutId: rollout.id };
    }
    const wave = nextRow.wave;
    if (!rollout.ignoreWindow) {
      const w = await windowOf(txDb);
      if (!inWindow(now, w)) return { action: "outside_window", rolloutId: rollout.id, wave, opensAt: nextWindowStart(now, w).toISOString() };
    }
    const members = await tx
      .select({ up: boxUpgrades, box: boxes })
      .from(boxUpgrades)
      .innerJoin(boxes, eq(boxes.id, boxUpgrades.boxId))
      .where(and(eq(boxUpgrades.rolloutId, rollout.id), eq(boxUpgrades.wave, wave), eq(boxUpgrades.state, "planned")))
      .orderBy(asc(boxes.createdAt));
    const queued: string[] = [];
    const skipped: string[] = [];
    // Jobs claim in run_after order; staggering by a millisecond keeps the wave oldest-first.
    const base = Date.now() - members.length - 1;
    for (const [i, { up, box }] of members.entries()) {
      const reason = ineligibleReason(box);
      if (reason) {
        await tx.update(boxUpgrades).set({ state: "skipped", error: reason, finishedAt: now, updatedAt: now }).where(eq(boxUpgrades.id, up.id));
        skipped.push(box.slug);
        continue;
      }
      // A box with another upgrade in flight (an operator's single-box upgrade) waits for the next tick.
      const [busy] = await tx
        .select({ id: boxUpgrades.id })
        .from(boxUpgrades)
        .where(and(eq(boxUpgrades.boxId, box.id), ne(boxUpgrades.id, up.id), inArray(boxUpgrades.state, [...BOX_UPGRADE_LIVE_STATES])));
      if (busy) continue;
      const job = await enqueueJob(tx, { boxId: box.id, kind: "upgrade", payload: { upgradeId: up.id, rolloutId: rollout.id }, runAfter: new Date(base + i) });
      if (!job.created) continue;
      await tx.update(boxUpgrades).set({ state: "queued", jobId: job.id, updatedAt: now }).where(eq(boxUpgrades.id, up.id));
      queued.push(box.slug);
    }
    await tx.insert(boxEvents).values({ kind: "rollout_wave_started", actor: "rollout", detail: { rolloutId: rollout.id, wave, queued, skipped } });
    return { action: "started_wave", rolloutId: rollout.id, wave, queued, skipped };
  });
  // Outside the claim transaction: holding and pausing writes the audited setting.
  if ("failures" in result && result.failures) {
    for (const up of result.failures) await holdAndPause(db, up, up.error ?? "upgrade job ended", "rollout");
    const { failures: _f, ...rest } = result;
    opts.log?.warn("rollout paused: an upgrade job ended without settling", { result: rest as unknown as Record<string, unknown>, count: _f.length });
    return rest;
  }
  if (result.action !== "idle" && result.action !== "waiting" && result.action !== "outside_window") opts.log?.info("rollout tick", result as unknown as Record<string, unknown>);
  return result;
}

export async function pauseRollout(db: CloudDb, actor: string, reason = "paused by an operator"): Promise<Record<string, unknown>> {
  await settingsService(db).set("rollout_paused", true, actor);
  await db.update(rollouts).set({ pausedReason: reason.slice(0, 500), updatedAt: new Date() }).where(eq(rollouts.state, "running"));
  return { rolloutPaused: true, reason };
}

export async function resumeRollout(db: CloudDb, actor: string): Promise<Record<string, unknown>> {
  await settingsService(db).set("rollout_paused", false, actor);
  await db.update(rollouts).set({ pausedReason: null, updatedAt: new Date() }).where(eq(rollouts.state, "running"));
  const held = await db
    .select({ slug: boxes.slug })
    .from(boxUpgrades)
    .innerJoin(boxes, eq(boxes.id, boxUpgrades.boxId))
    .innerJoin(rollouts, eq(rollouts.id, boxUpgrades.rolloutId))
    .where(and(eq(rollouts.state, "running"), inArray(boxUpgrades.state, ["failed", "rolled_back"]), eq(boxes.holdUpgrades, true)));
  return { rolloutPaused: false, stillHeld: held.map((h) => h.slug) };
}

export async function cancelRollout(db: CloudDb, actor: string): Promise<Record<string, unknown>> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROLLOUT_LOCK_KEY})`);
    const [r] = await tx.select().from(rollouts).where(eq(rollouts.state, "running"));
    if (!r) throw new RolloutError("no rollout is running", 404);
    const now = new Date();
    const dropped = await tx
      .update(boxUpgrades)
      .set({ state: "skipped", error: "rollout cancelled", finishedAt: now, updatedAt: now })
      .where(and(eq(boxUpgrades.rolloutId, r.id), eq(boxUpgrades.state, "planned")))
      .returning({ id: boxUpgrades.id });
    await tx.update(rollouts).set({ state: "cancelled", finishedAt: now, updatedAt: now }).where(eq(rollouts.id, r.id));
    await tx.insert(boxEvents).values({ kind: "rollout_cancelled", actor, detail: { rolloutId: r.id, dropped: dropped.length } });
    return { rolloutId: r.id, cancelled: true, droppedPlanned: dropped.length, note: "upgrades already in flight run to completion" };
  });
}

export async function rolloutStatus(db: CloudDb, opts: { now?: Date } = {}): Promise<Record<string, unknown>> {
  const now = opts.now ?? new Date();
  const settings = await settingsService(db).getAll();
  const w = parseWindow(settings.upgrade_window, settings.upgrade_window_tz);
  const [r] = await db.select().from(rollouts).orderBy(desc(rollouts.createdAt)).limit(1);
  const window = {
    window: settings.upgrade_window ?? "always",
    tz: settings.upgrade_window_tz,
    openNow: inWindow(now, w),
    opensAt: nextWindowStart(now, w).toISOString(),
  };
  const single = await db
    .select({ slug: boxes.slug, state: boxUpgrades.state, toTag: boxUpgrades.toTag, error: boxUpgrades.error, createdAt: boxUpgrades.createdAt })
    .from(boxUpgrades)
    .innerJoin(boxes, eq(boxes.id, boxUpgrades.boxId))
    .where(isNull(boxUpgrades.rolloutId))
    .orderBy(desc(boxUpgrades.createdAt))
    .limit(20);
  if (!r) return { targetRelease: settings.target_release, rolloutPaused: settings.rollout_paused, window, rollout: null, singleBoxUpgrades: single };
  const rows = await db
    .select({ slug: boxes.slug, purpose: boxes.purpose, wave: boxUpgrades.wave, state: boxUpgrades.state, fromTag: boxUpgrades.fromTag, error: boxUpgrades.error, held: boxes.holdUpgrades })
    .from(boxUpgrades)
    .innerJoin(boxes, eq(boxes.id, boxUpgrades.boxId))
    .where(eq(boxUpgrades.rolloutId, r.id))
    .orderBy(asc(boxUpgrades.wave), asc(boxes.createdAt));
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  return {
    targetRelease: settings.target_release,
    rolloutPaused: settings.rollout_paused,
    window,
    rollout: { ...r, counts, boxes: rows },
    singleBoxUpgrades: single,
  };
}

/** An operator's upgrade of one box, outside any rollout: now, or at the next window opening. */
export async function upgradeOneBox(
  db: CloudDb,
  deps: ReleaseResolverDeps,
  input: { slug: string; releaseTag?: string | null; now?: boolean },
  actor: string,
): Promise<Record<string, unknown>> {
  const [box] = await db.select().from(boxes).where(eq(boxes.slug, input.slug));
  if (!box) throw new RolloutError(`no box ${input.slug}`, 404);
  const reason = ineligibleReason(box);
  if (reason) throw new RolloutError(`box ${input.slug} cannot be upgraded: ${reason}${box.holdUpgrades ? " (boxes unhold it first)" : ""}`, 409);
  const tag = input.releaseTag ?? (await settingsService(db).get("target_release"));
  if (!tag) throw new RolloutError("no release given and target_release is not set", 409);
  const { digest, commit } = await resolveRelease(deps, tag);
  if (box.releaseTag === tag && box.imageDigest === digest) throw new RolloutError(`box ${input.slug} is already on ${tag}`, 409);
  const runAfter = input.now ? new Date() : nextWindowStart(new Date(), await windowOf(db));
  return await db.transaction(async (tx) => {
    const [busy] = await tx
      .select({ id: boxUpgrades.id })
      .from(boxUpgrades)
      .where(and(eq(boxUpgrades.boxId, box.id), inArray(boxUpgrades.state, [...BOX_UPGRADE_LIVE_STATES])));
    if (busy) throw new RolloutError(`box ${input.slug} already has an upgrade in flight (${busy.id})`, 409);
    const [up] = await tx.insert(boxUpgrades).values({ boxId: box.id, state: "queued", toTag: tag, toDigest: digest, toCommit: commit }).returning();
    const job = await enqueueJob(tx, { boxId: box.id, kind: "upgrade", payload: { upgradeId: up!.id, requestedBy: actor }, runAfter });
    if (!job.created) throw new RolloutError(`box ${input.slug} already has an upgrade job (${job.id})`, 409);
    await tx.update(boxUpgrades).set({ jobId: job.id }).where(eq(boxUpgrades.id, up!.id));
    await tx.insert(boxEvents).values({ boxId: box.id, kind: "upgrade_requested", actor, detail: { upgradeId: up!.id, toTag: tag, runAfter: runAfter.toISOString() } });
    return { slug: input.slug, upgradeId: up!.id, jobId: job.id, toTag: tag, imageDigest: digest, runAfter: runAfter.toISOString() };
  });
}

/** hold_upgrades on or off for one box (spec §6.1: also for a customer who asks us to wait). */
export async function setHold(db: CloudDb, slug: string, hold: boolean, actor: string): Promise<Record<string, unknown>> {
  const [row] = await db.update(boxes).set({ holdUpgrades: hold, updatedAt: new Date() }).where(eq(boxes.slug, slug)).returning({ id: boxes.id });
  if (!row) throw new RolloutError(`no box ${slug}`, 404);
  await db.insert(boxEvents).values({ boxId: row.id, kind: hold ? "upgrades_held" : "upgrades_unheld", actor, detail: {} });
  return { holdUpgrades: hold };
}

export async function setPurpose(db: CloudDb, slug: string, purpose: BoxPurpose, actor: string): Promise<Record<string, unknown>> {
  const [prev] = await db.select({ id: boxes.id, purpose: boxes.purpose }).from(boxes).where(eq(boxes.slug, slug));
  if (!prev) throw new RolloutError(`no box ${slug}`, 404);
  await db.update(boxes).set({ purpose, updatedAt: new Date() }).where(eq(boxes.id, prev.id));
  await db.insert(boxEvents).values({ boxId: prev.id, kind: "purpose_changed", actor, detail: { from: prev.purpose, to: purpose } });
  return { purpose, previous: prev.purpose, note: purpose === "demo" ? "demo boxes are created held; this box's hold_upgrades is unchanged" : undefined };
}

