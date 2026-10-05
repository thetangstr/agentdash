// AgentDash: the per-box upgrade job (spec §6.1, SC-12, GH #773).
//
// One `upgrade` job moves one box to a release, driven by its box_upgrades
// row (payload.upgradeId). Steps, each idempotent and each recording what it
// learned on the row before moving on, so a job resumed after a control-plane
// restart continues where it stopped and never deploys twice:
//
//   prepare          eligibility (held, state, secrets present), what runs now
//                    (tag, digest, the current SUCCESS deployment to roll back to)
//   snapshot         a pre-upgrade snapshot of both volumes (database and /paperclip)
//   point            the web service's source → the release's GHCR image BY DIGEST
//   variables        AGENTDASH_RELEASE_TAG → the release; variables already
//                    upserted with skipDeploys (close-signup, the edge secret) ride
//                    this deploy too: they are the "pending variable changes"
//   deploy           one deployment, recorded the moment it exists; waits for SUCCESS
//   verify           /api/health on the Railway host and (once live) through the
//                    router reports the exact release: releaseTag, and releaseCommit
//                    when the box reports one
//   rollback         on a failed deploy or verify: the previous source and tag
//                    back, and Railway's rollback to the previous deployment
//   rollback_verify  the rollback deployment healthy on the previous release
//   finish           success: the box row records the release. Failure: the box
//                    gets hold_upgrades, a rollout gets rollout_paused, ops is paged
//
// An upgrade that fails is a SUCCEEDED job (it did its job: upgrade or roll
// back); the outcome is the box_upgrades row. A job that gives up (Railway
// unreachable through every retry) also holds the box and pauses the rollout.
import { and, eq } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { boxEvents, boxes, boxUpgrades, BOX_UPGRADE_DONE_STATES, rollouts, type BoxUpgradeState } from "../db/schema.js";
import { redactString } from "../logger.js";
import { DEPLOY_FAILED, deleteDeploymentTrigger, deploymentTriggerIds, deployService, getProject, latestDeployment, type ProjectDetail, updateServiceInstance, upsertVariables, variableNames } from "../railway/api.js";
import { RailwayApiError, type RailwayClient } from "../railway/client.js";
import { GUARDED_SECRETS, PG_MOUNT, publicHost, WEB_MOUNT } from "../railway/provisioner.js";
import { BACKUP_PRUNE_WAIT_MS, BackupPruneExhaustedError, createVolumeBackup, DEFAULT_VOLUME_BACKUP_LIMIT, deployedArtifact, getDeployment, makeRoomForVolumeBackup, rollbackDeployment } from "../railway/upgrade-api.js";
import { assertBoxProjectName, boxProjectName, ProjectNameRefused, projectTag } from "../railway/names.js";

/** How long a rollback request may stay unlisted before the job asks Railway again. */
const ROLLBACK_REQUEST_GRACE_MS = 3 * 60_000;
import { settingsService } from "../settings.js";
import type { Alerter } from "./alerts.js";
import { FatalJobError } from "./errors.js";
import type { BoxRow, JobContext, JobHandler, JobStep } from "./runner.js";

export type UpgradeRow = typeof boxUpgrades.$inferSelect;

export interface UpgradeDeps {
  client: RailwayClient;
  workspaceId: string;
  edgeDomain: string;
  imageRepo: string;
  sourceRepo: string;
  /** Verify through the edge router too (spec §6.1); off until the router serves the slug hosts. */
  edgeLive: boolean;
  alerter?: Alerter;
  /** For box health checks. */
  fetch?: typeof fetch;
  pollMs?: number;
  deployWaitMs?: number;
  healthWaitMs?: number;
  edgeHealthWaitMs?: number;
  /** Railway's per-volume backup cap; prune the oldest manual backups before each pre-upgrade snapshot. */
  backupLimit?: number;
  /** Give up waiting on in-flight backup deletions after this long. */
  backupPruneWaitMs?: number;
}

/**
 * Box states an upgrade may touch. A suspended box is skipped (a rollout lists it as such);
 * upgrade it with `boxes upgrade` once it is active again.
 */
export const UPGRADABLE_BOX_STATES = ["active", "awaiting_claim"] as const;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const isDone = (s: BoxUpgradeState) => (BOX_UPGRADE_DONE_STATES as readonly string[]).includes(s);

/** Why a box may not be upgraded now, or null. */
export function ineligibleReason(box: BoxRow): string | null {
  if (box.holdUpgrades) return "hold_upgrades is set";
  if (!(UPGRADABLE_BOX_STATES as readonly string[]).includes(box.state)) return `box is ${box.state}`;
  if (!box.projectId || !box.environmentId || !box.webServiceId) return "no Railway web service recorded";
  return null;
}

export async function patchUpgrade(db: CloudDb, id: string, patch: Partial<typeof boxUpgrades.$inferInsert>): Promise<void> {
  await db.update(boxUpgrades).set({ ...patch, updatedAt: new Date() }).where(eq(boxUpgrades.id, id));
}

/**
 * The failure path shared by the job and the rollout tick: hold the box, and
 * for a rollout set rollout_paused (the first failure stops the rollout) and
 * record why. Idempotent.
 */
export async function holdAndPause(db: CloudDb, up: UpgradeRow, reason: string, actor: string): Promise<{ paused: boolean }> {
  await db.update(boxes).set({ holdUpgrades: true, updatedAt: new Date() }).where(eq(boxes.id, up.boxId));
  if (!up.rolloutId) return { paused: false };
  const svc = settingsService(db);
  if (!(await svc.get("rollout_paused"))) await svc.set("rollout_paused", true, actor);
  await db
    .update(rollouts)
    .set({ pausedReason: redactString(reason).slice(0, 500), updatedAt: new Date() })
    .where(and(eq(rollouts.id, up.rolloutId), eq(rollouts.state, "running")));
  return { paused: true };
}

interface HealthExpect {
  /** The release tag health must report; null when the box reported none (an old box rolled back). */
  tag: string | null;
  commit: string | null;
}

type HealthResult = { ok: true; body: Record<string, unknown> } | { ok: false; definitive: boolean; why: string; body?: Record<string, unknown> };

/** Does one /api/health answer report exactly the expected release on a healthy hosted box? */
export function judgeHealth(status: number, body: Record<string, unknown> | null, want: HealthExpect): HealthResult {
  if (status < 200 || status >= 300 || !body) return { ok: false, definitive: false, why: `HTTP ${status}` };
  // "degraded" (stale on-volume backup, a stuck run, low disk) is the box's own
  // condition, not the release's: the process is up and its database answers.
  if (body.status !== "ok" && body.status !== "degraded") return { ok: false, definitive: false, why: `status=${String(body.status)}`, body };
  if (body.hostedBox !== true) return { ok: false, definitive: true, why: "hostedBox is not true", body };
  if (body.deploymentMode !== undefined && body.deploymentMode !== "authenticated") {
    return { ok: false, definitive: true, why: `deploymentMode=${String(body.deploymentMode)}`, body };
  }
  const reported = typeof body.releaseTag === "string" && body.releaseTag !== "" ? body.releaseTag : null;
  if (reported !== want.tag) return { ok: false, definitive: false, why: `releaseTag=${reported ?? "none"}, expected ${want.tag ?? "none"}`, body };
  const commit = typeof body.releaseCommit === "string" ? body.releaseCommit.toLowerCase() : null;
  if (commit && want.commit) {
    const w = want.commit.toLowerCase();
    if (!(w.startsWith(commit) || commit.startsWith(w))) {
      return { ok: false, definitive: true, why: `releaseCommit=${commit}, expected ${w}`, body };
    }
  }
  return { ok: true, body };
}

function volumeOn(p: ProjectDetail, serviceId: string, mountPath: string) {
  return p.volumes.find((v) => v.serviceId === serviceId && v.mountPath === mountPath) ?? null;
}

export function upgradeHandler(deps: UpgradeDeps): JobHandler {
  const { client } = deps;
  const f = deps.fetch ?? fetch;
  const pollMs = deps.pollMs ?? 10_000;
  const deployWaitMs = deps.deployWaitMs ?? 15 * 60_000;
  const healthWaitMs = deps.healthWaitMs ?? 5 * 60_000;
  const edgeHealthWaitMs = deps.edgeHealthWaitMs ?? 2 * 60_000;
  const backupLimit = deps.backupLimit ?? DEFAULT_VOLUME_BACKUP_LIMIT;
  const backupPruneWaitMs = deps.backupPruneWaitMs ?? BACKUP_PRUNE_WAIT_MS;

  const load = async (ctx: Pick<JobContext, "db" | "job">): Promise<UpgradeRow> => {
    const id = typeof ctx.job.payload?.upgradeId === "string" ? ctx.job.payload.upgradeId : null;
    if (!id) throw new FatalJobError("upgrade job has no upgradeId in its payload");
    const [row] = await ctx.db.select().from(boxUpgrades).where(eq(boxUpgrades.id, id));
    if (!row) throw new FatalJobError(`no box_upgrades row ${id}`);
    if (row.boxId !== ctx.job.boxId) throw new FatalJobError(`box_upgrades row ${id} is for another box`);
    return row;
  };

  // Every read of the recorded project re-checks the guards the provisioner and the delete path
  // use (names.ts): the boxes workspace, a box project name (never a protected one), and this
  // box's control-plane tag. A mistyped workspace or token can never point an upgrade elsewhere.
  const project = async (box: BoxRow, signal: AbortSignal) => {
    const p = await getProject(client, box.projectId!, { signal });
    if (p.workspaceId !== deps.workspaceId) {
      throw new FatalJobError(`recorded project ${p.id} is not in the boxes workspace; refusing to act on it`);
    }
    try {
      assertBoxProjectName(p.name);
    } catch (err) {
      if (err instanceof ProjectNameRefused) throw new FatalJobError(err.message);
      throw err;
    }
    if (p.name !== boxProjectName(box.slug) || !(p.description ?? "").includes(projectTag(box.id))) {
      throw new FatalJobError(`recorded project ${p.id} is not ${boxProjectName(box.slug)} with this box's tag; refusing to act on it`);
    }
    return p;
  };

  /** The deployment must run exactly the expected artifact, per Railway's own record of it. */
  const checkArtifact = async (ctx: JobContext, id: string, want: { digest: string | null; commit: string | null }): Promise<string | null> => {
    const d = await getDeployment(client, id, { signal: ctx.signal });
    const got = deployedArtifact(d?.meta ?? null);
    if (want.digest && !got.digests.includes(want.digest)) {
      return `deployment ${id} runs ${got.digests.length ? got.digests.join(", ") : "no recorded image digest"}, expected ${want.digest}`;
    }
    if (want.commit && got.commit && !(want.commit.toLowerCase().startsWith(got.commit) || got.commit.startsWith(want.commit.toLowerCase()))) {
      return `deployment ${id} built commit ${got.commit}, expected ${want.commit}`;
    }
    if (want.commit && !want.digest && !got.commit) return `deployment ${id} records no commit, expected ${want.commit}`;
    return null;
  };

  const event = (db: CloudDb, boxId: string, kind: string, detail: Record<string, unknown>) =>
    db.insert(boxEvents).values({ boxId, kind, actor: "upgrade", detail });

  const startRollback = async (ctx: JobContext, up: UpgradeRow, why: string) => {
    const error = redactString(why).slice(0, 1000);
    await patchUpgrade(ctx.db, up.id, { state: "rolling_back", error });
    await event(ctx.db, up.boxId, "upgrade_rolling_back", { upgradeId: up.id, toTag: up.toTag, fromTag: up.fromTag, error });
    ctx.log.warn("upgrade failed; rolling back", { upgradeId: up.id, error });
  };

  /** Poll one deployment to a terminal state. */
  const awaitDeployment = async (ctx: JobContext, id: string, capMs: number): Promise<{ ok: boolean; why: string }> => {
    const started = Date.now();
    for (;;) {
      const d = await getDeployment(client, id, { signal: ctx.signal });
      if (!d) return { ok: false, why: `deployment ${id} is gone` };
      if (d.status === "SUCCESS") return { ok: true, why: "" };
      if (DEPLOY_FAILED.has(d.status)) return { ok: false, why: `deployment ${id} ended ${d.status}` };
      if (Date.now() - started > capMs) return { ok: false, why: `deployment ${id} did not succeed within ${Math.round(capMs / 60_000)} min (${d.status})` };
      await sleep(pollMs, ctx.signal);
    }
  };

  /** Poll health on the Railway host, then (once live) through the router, until it reports `want`. */
  const awaitRelease = async (ctx: JobContext, box: BoxRow, want: HealthExpect): Promise<HealthResult> => {
    const urls: Array<[string, number]> = [[`https://${box.upstreamHost}`, healthWaitMs]];
    if (deps.edgeLive) urls.push([`https://${publicHost(box.slug, deps.edgeDomain)}`, edgeHealthWaitMs]);
    if (!box.upstreamHost) return { ok: false, definitive: true, why: "no upstream host recorded" };
    let last: HealthResult = { ok: false, definitive: false, why: "no answer" };
    for (const [url, capMs] of urls) {
      const started = Date.now();
      for (;;) {
        try {
          const res = await f(`${url}/api/health`, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]) });
          const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
          last = judgeHealth(res.status, body, want);
        } catch (err) {
          if (ctx.signal.aborted) throw ctx.signal.reason;
          last = { ok: false, definitive: false, why: err instanceof Error ? err.name : String(err) };
        }
        if (last.ok) break;
        if (last.definitive) return { ...last, why: `${url}: ${last.why}` };
        if (Date.now() - started > capMs) return { ...last, why: `${url} did not report ${want.tag ?? "no release tag"} within ${Math.round(capMs / 60_000)} min (${last.why})` };
        await sleep(pollMs, ctx.signal);
      }
    }
    return last;
  };

  const step = (name: string, timeoutMs: number, states: readonly BoxUpgradeState[], run: (ctx: JobContext, up: UpgradeRow, box: BoxRow) => Promise<void>): JobStep => ({
    name,
    timeoutMs,
    async run(ctx) {
      const up = await load(ctx);
      if (!states.includes(up.state)) return;
      await run(ctx, up, await ctx.box());
    },
  });

  return {
    kind: "upgrade",
    maxDurationMs: 90 * 60_000,
    async onGiveUp(ctx, outcome, error) {
      const up = await load(ctx).catch(() => null);
      if (!up || isDone(up.state)) return;
      const why = `upgrade job ${outcome}: ${error}${up.deploymentId ? " (the box may be mid-deploy; roll back by hand from the pre-upgrade snapshot if needed)" : ""}`;
      await patchUpgrade(ctx.db, up.id, { state: "failed", error: redactString(why).slice(0, 1000), finishedAt: new Date() });
      await holdAndPause(ctx.db, up, why, "upgrade");
      await event(ctx.db, up.boxId, "upgrade_failed", { upgradeId: up.id, toTag: up.toTag, error: why });
    },
    steps: [
      step("prepare", 2 * 60_000, ["planned", "queued"], async (ctx, up, box) => {
        if (up.rolloutId) {
          // The first failure pauses the rollout: wave members that have not started yet go back
          // to `planned` and are re-queued after `rollout resume`. A cancelled rollout drops them.
          const [r] = await ctx.db.select({ state: rollouts.state }).from(rollouts).where(eq(rollouts.id, up.rolloutId));
          if (r?.state !== "running") {
            await patchUpgrade(ctx.db, up.id, { state: "skipped", error: `rollout ${r?.state ?? "missing"}`, finishedAt: new Date() });
            return;
          }
          if (await settingsService(ctx.db).get("rollout_paused")) {
            await patchUpgrade(ctx.db, up.id, { state: "planned", jobId: null });
            await event(ctx.db, box.id, "upgrade_deferred", { upgradeId: up.id, reason: "rollout_paused" });
            return;
          }
        }
        const reason = ineligibleReason(box);
        if (reason) {
          await patchUpgrade(ctx.db, up.id, { state: "skipped", error: reason, finishedAt: new Date() });
          await event(ctx.db, box.id, "upgrade_skipped", { upgradeId: up.id, toTag: up.toTag, reason });
          return;
        }
        const p = await project(box, ctx.signal);
        const latest = await latestDeployment(client, box.projectId!, box.environmentId!, box.webServiceId!, { signal: ctx.signal });
        const failBeforeChange = async (why: string) => {
          // Nothing on Railway was changed yet: no rollback, but the box is held and a rollout pauses.
          await patchUpgrade(ctx.db, up.id, { state: "failed", error: why });
        };
        if (!latest || latest.status !== "SUCCESS") {
          return void (await failBeforeChange(`the box's current deployment is ${latest ? latest.status : "missing"}, not SUCCESS; not upgrading an unhealthy box`));
        }
        if (box.releaseTag === up.toTag && box.imageDigest === up.toDigest) {
          await patchUpgrade(ctx.db, up.id, { state: "skipped", error: `already on ${up.toTag}`, finishedAt: new Date() });
          return;
        }
        // A deploy without these would lock users out or orphan stored secrets: never upgrade such a box.
        const names = new Set(await variableNames(client, box.projectId!, box.environmentId!, box.webServiceId!, { signal: ctx.signal }));
        const missing = GUARDED_SECRETS.filter((s) => !names.has(s));
        if (missing.length) return void (await failBeforeChange(`the box is missing ${missing.join(", ")}; restore from escrow before upgrading`));
        if (!volumeOn(p, box.pgServiceId ?? "", PG_MOUNT) || !volumeOn(p, box.webServiceId!, WEB_MOUNT)) {
          return void (await failBeforeChange("a box volume is not listed; cannot take the pre-upgrade snapshot"));
        }
        await patchUpgrade(ctx.db, up.id, {
          state: "running",
          fromTag: box.releaseTag,
          fromDigest: box.imageDigest,
          fromBuildSource: box.buildSource,
          fromSourceCommit: box.sourceCommit,
          fromDeploymentId: latest.id,
          startedAt: new Date(),
          error: null,
        });
        await event(ctx.db, box.id, "upgrade_started", { upgradeId: up.id, rolloutId: up.rolloutId, fromTag: box.releaseTag, toTag: up.toTag, toDigest: up.toDigest });
      }),

      step("snapshot", 2 * 60_000, ["running"], async (ctx, up, box) => {
        const snaps = { ...(up.snapshots ?? {}) } as Record<string, unknown>;
        if (snaps.pg && snaps.web) return;
        const p = await project(box, ctx.signal);
        const targets: Array<[string, ReturnType<typeof volumeOn>]> = [
          ["pg", volumeOn(p, box.pgServiceId ?? "", PG_MOUNT)],
          ["web", volumeOn(p, box.webServiceId!, WEB_MOUNT)],
        ];
        for (const [key, vol] of targets) {
          if (snaps[key]) continue;
          if (!vol) throw new Error(`the ${key} volume is not listed; retrying`);
          let workflowId: string;
          try {
            // Railway caps a volume at 10 backups; accumulated "Manual" snapshots
            // used to fail every eleventh upgrade. Prune the oldest ones first.
            await makeRoomForVolumeBackup(client, vol.id, { signal: ctx.signal, limit: backupLimit, pollMs, waitMs: backupPruneWaitMs, log: ctx.log, sleep: (ms) => sleep(ms, ctx.signal) });
            workflowId = await createVolumeBackup(client, vol.id, { signal: ctx.signal });
          } catch (err) {
            // Nothing prunable — or Railway still refuses the create — can never
            // heal by retrying: fail dead so ops is paged once, not after 5 tries.
            if (err instanceof BackupPruneExhaustedError) throw new FatalJobError(`cannot take the pre-upgrade ${key} snapshot: ${err.message}`);
            if (err instanceof RailwayApiError && err.messages.some((m) => /limit.*backup|backup.*limit/i.test(m))) {
              throw new FatalJobError(`cannot take the pre-upgrade ${key} snapshot on volume instance ${vol.id}: ${err.messages.join("; ")}`);
            }
            throw err;
          }
          snaps[key] = { volumeInstanceId: vol.id, workflowId, at: new Date().toISOString() };
          // Recorded per volume, so a retry never snapshots the same volume twice.
          await patchUpgrade(ctx.db, up.id, { snapshots: snaps });
        }
        await event(ctx.db, box.id, "pre_upgrade_snapshot", { upgradeId: up.id, snapshots: snaps });
      }),

      step("point", 60_000, ["running"], async (ctx, up, box) => {
        await updateServiceInstance(client, box.webServiceId!, box.environmentId!, { source: { image: `${deps.imageRepo}@${up.toDigest}` } }, { signal: ctx.signal });
      }),

      step("variables", 60_000, ["running"], async (ctx, up, box) => {
        await upsertVariables(client, box.projectId!, box.environmentId!, box.webServiceId!, { AGENTDASH_RELEASE_TAG: up.toTag }, { signal: ctx.signal });
      }),

      step("deploy", deployWaitMs + 2 * 60_000, ["running"], async (ctx, up, box) => {
        let id = up.deploymentId;
        if (!id) {
          // A deployment started after this upgrade began but not recorded (a crash right
          // after the deploy call) is adopted, never doubled.
          const latest = await latestDeployment(client, box.projectId!, box.environmentId!, box.webServiceId!, { signal: ctx.signal });
          const since = up.startedAt ? up.startedAt.getTime() - 1000 : Number.POSITIVE_INFINITY;
          // A FAILED one is adopted too: it is this upgrade's deploy, and it leads to the rollback.
          if (latest && latest.id !== up.fromDeploymentId && Date.parse(latest.createdAt) >= since) {
            id = latest.id;
          } else {
            id = await deployService(client,box.webServiceId!, box.environmentId!, null, { signal: ctx.signal });
          }
          await patchUpgrade(ctx.db, up.id, { deploymentId: id });
        }
        const r = await awaitDeployment(ctx, id, deployWaitMs);
        if (!r.ok) return void (await startRollback(ctx, { ...up, deploymentId: id }, r.why));
        // Health reads AGENTDASH_RELEASE_TAG, which this job sets itself; the image is proven here.
        const wrong = await checkArtifact(ctx, id, { digest: up.toDigest, commit: null });
        if (wrong) return void (await startRollback(ctx, { ...up, deploymentId: id }, wrong));
        await event(ctx.db, box.id, "upgrade_deployed", { upgradeId: up.id, deploymentId: id });
      }),

      step("verify", healthWaitMs + edgeHealthWaitMs + 2 * 60_000, ["running"], async (ctx, up, box) => {
        const r = await awaitRelease(ctx, box, { tag: up.toTag, commit: up.toCommit });
        const health = { ...(r.ok ? r.body : (r.body ?? {})), checkedAt: new Date().toISOString() };
        if (!r.ok) {
          await patchUpgrade(ctx.db, up.id, { lastHealth: health });
          return void (await startRollback(ctx, up, `health did not verify: ${r.why}`));
        }
        await ctx.db.transaction(async (tx) => {
          await tx
            .update(boxes)
            .set({ releaseTag: up.toTag, imageDigest: up.toDigest, buildSource: "image", lastHealth: health, updatedAt: new Date() })
            .where(eq(boxes.id, box.id));
          await tx
            .update(boxUpgrades)
            .set({ state: "succeeded", lastHealth: health, finishedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(boxUpgrades.id, up.id), eq(boxUpgrades.state, "running")));
        });
      }),

      step("rollback", 3 * 60_000, ["rolling_back"], async (ctx, up, box) => {
        const P = box.projectId!;
        const E = box.environmentId!;
        const W = box.webServiceId!;
        await project(box, ctx.signal);
        // A source-built box goes back to its pinned commit, never the repository's HEAD.
        const fromSource = up.fromBuildSource === "source";
        const source = fromSource ? { repo: deps.sourceRepo } : up.fromDigest ? { image: `${deps.imageRepo}@${up.fromDigest}` } : null;
        if (source) await updateServiceInstance(client, W, E, { source }, { signal: ctx.signal });
        if (fromSource) {
          // Setting a repository source adds a push trigger; a source-built box must never redeploy on a push.
          for (const t of await deploymentTriggerIds(client, P, E, W, { signal: ctx.signal })) await deleteDeploymentTrigger(client, t, { signal: ctx.signal });
        }
        // The previous value, or empty when the box had none (health then reports no tag, as before).
        await upsertVariables(client, P, E, W, { AGENTDASH_RELEASE_TAG: up.fromTag ?? "" }, { signal: ctx.signal });
        if (!up.deploymentId || up.rollbackDeploymentId) return;
        if (!up.fromDeploymentId) throw new FatalJobError("no previous deployment recorded to roll back to");
        const isRollback = (d: { id: string; createdAt: string } | null) =>
          d !== null && d.id !== up.deploymentId && d.id !== up.fromDeploymentId && Date.parse(d.createdAt) >= (up.startedAt?.getTime() ?? 0) - 1000;
        let latest = await latestDeployment(client, P, E, W, { signal: ctx.signal });
        if (!isRollback(latest)) {
          // Ask Railway once; a retry waits for the deployment that request made, and asks
          // again only if none has appeared after ROLLBACK_REQUEST_GRACE_MS.
          const askedAt = up.rollbackRequestedAt?.getTime() ?? null;
          if (askedAt === null || Date.now() - askedAt > ROLLBACK_REQUEST_GRACE_MS) {
            await patchUpgrade(ctx.db, up.id, { rollbackRequestedAt: new Date() });
            if (fromSource && up.fromSourceCommit) {
              const id = await deployService(client, W, E, up.fromSourceCommit, { signal: ctx.signal });
              await patchUpgrade(ctx.db, up.id, { rollbackDeploymentId: id });
              return;
            }
            await rollbackDeployment(client, up.fromDeploymentId, { signal: ctx.signal });
            latest = await latestDeployment(client, P, E, W, { signal: ctx.signal });
          }
          if (!isRollback(latest)) throw new Error("Railway does not list the rollback deployment yet; retrying");
        }
        await patchUpgrade(ctx.db, up.id, { rollbackDeploymentId: latest!.id });
      }),

      step("rollback_verify", deployWaitMs + healthWaitMs + edgeHealthWaitMs + 2 * 60_000, ["rolling_back"], async (ctx, up, box) => {
        let why: string | null = null;
        if (up.rollbackDeploymentId) {
          const d = await awaitDeployment(ctx, up.rollbackDeploymentId, deployWaitMs);
          if (!d.ok) why = `rollback ${d.why}`;
          if (!why) {
            const wrong = await checkArtifact(ctx, up.rollbackDeploymentId, {
              digest: up.fromBuildSource === "source" ? null : up.fromDigest,
              commit: up.fromBuildSource === "source" ? up.fromSourceCommit : null,
            });
            if (wrong) why = `rollback ${wrong}`;
          }
        }
        if (!why && up.deploymentId) {
          const h = await awaitRelease(ctx, box, { tag: up.fromTag, commit: null });
          if (!h.ok) why = `rollback health: ${h.why}`;
        }
        await patchUpgrade(ctx.db, up.id, {
          state: why ? "failed" : "rolled_back",
          error: why ? redactString(`${up.error ?? "upgrade failed"}; ${why}`).slice(0, 1000) : up.error,
          finishedAt: new Date(),
        });
      }),

      step("finish", 60_000, ["succeeded", "rolled_back", "failed"], async (ctx, up, box) => {
        if (up.state === "succeeded") {
          await event(ctx.db, box.id, "upgraded", { upgradeId: up.id, rolloutId: up.rolloutId, fromTag: up.fromTag, toTag: up.toTag, toDigest: up.toDigest });
          ctx.log.info("box upgraded", { slug: box.slug, toTag: up.toTag });
          return;
        }
        if (!up.finishedAt) await patchUpgrade(ctx.db, up.id, { finishedAt: new Date() });
        const why = up.error ?? "upgrade failed";
        const { paused } = await holdAndPause(ctx.db, up, `${box.slug}: ${why}`, "upgrade");
        await event(ctx.db, box.id, "upgrade_failed", { upgradeId: up.id, rolloutId: up.rolloutId, outcome: up.state, toTag: up.toTag, fromTag: up.fromTag, error: why, rolloutPaused: paused });
        await deps.alerter
          ?.send({
            kind: "job_failed",
            subject: `upgrade of ${box.slug} to ${up.toTag} ${up.state === "rolled_back" ? "failed and was rolled back" : "failed (NOT rolled back cleanly)"}; box held${paused ? ", rollout paused" : ""}`,
            boxId: box.id,
            slug: box.slug,
            jobId: ctx.job.id,
            jobKind: "upgrade",
            step: "finish",
            attempt: ctx.job.attempt,
            error: why,
          })
          .catch((err: unknown) => ctx.log.error("alert failed", { err }));
      }),
    ],
  };
}
