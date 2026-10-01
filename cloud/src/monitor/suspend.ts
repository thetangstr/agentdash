// AgentDash (SC-10, GH #771): the `suspend` and `resume` jobs (spec §5.2,
// §4.3). Suspend is `railway down`: the web service's deployments are
// removed, Postgres and both volumes stay, so nothing is lost. Resume
// deploys the web service again from its recorded source (the image digest,
// or the release commit for a source-built box), waits for the deployment
// and the box's own health, and only then routes it again.
//
// Order matters for the router: suspend marks the box `suspended` FIRST, so
// a visitor sees the "waking" page (and a resume is queued) rather than a
// 502 while the deployment goes away; resume marks it `active` LAST, so the
// router never proxies to a box that is still starting. A resume that finds
// a live suspend job waits for it. Postgres is never suspended (off until a
// suspend-and-resume test on Postgres passes, spec §5.2).
import { and, eq, inArray, ne } from "drizzle-orm";
import { boxEvents, boxes, boxHealth, jobs } from "../db/schema.js";
import { FatalJobError, RetryableJobError } from "../jobs/errors.js";
import type { JobContext, JobHandler } from "../jobs/runner.js";
import { DEPLOY_FAILED, deployService, getProject, latestDeployment } from "../railway/api.js";
import type { RailwayClient } from "../railway/client.js";
import { assertBoxProjectName, boxProjectName, ProjectNameRefused, projectTag } from "../railway/names.js";
import { probeHealth } from "./health.js";
import { IDLE_POLICY_PLANS } from "./idle.js";

type Opt = { signal?: AbortSignal };

/** Deployment states that hold (or are about to hold) a running web container. */
const LIVE_DEPLOYMENT = new Set(["SUCCESS", "SLEEPING", "DEPLOYING", "INITIALIZING", "BUILDING", "QUEUED", "WAITING", "NEEDS_APPROVAL"]);

export async function recentDeployments(client: RailwayClient, p: string, e: string, s: string, o: Opt = {}): Promise<Array<{ id: string; status: string; createdAt: string }>> {
  const d = await client.request<{ deployments: { edges: Array<{ node: { id: string; status: string; createdAt: string } }> } }>(
    "deployments",
    `query($i:DeploymentListInput!){ deployments(first:10, input:$i){ edges { node { id status createdAt } } } }`,
    { i: { projectId: p, environmentId: e, serviceId: s } },
    o,
  );
  return d.deployments.edges.map((x) => x.node);
}

export async function removeDeployment(client: RailwayClient, id: string, o: Opt = {}): Promise<void> {
  await client.request("deploymentRemove", `mutation($id:String!){ deploymentRemove(id:$id) }`, { id }, o);
}

async function railwayBox(ctx: JobContext, deps: { client: RailwayClient; workspaceId: string }) {
  const box = await ctx.box();
  if (!box.projectId || !box.environmentId || !box.webServiceId) throw new FatalJobError(`box ${box.slug} has no recorded Railway web service`);
  const p = await getProject(deps.client, box.projectId, { signal: ctx.signal });
  if (p.workspaceId !== deps.workspaceId) throw new FatalJobError(`project ${p.id} is not in the boxes workspace`);
  // The same guards as the guarded delete (../railway/delete.ts): the box-name rule and
  // protected list, exactly this box's name, and this box's control-plane tag.
  try {
    assertBoxProjectName(p.name);
  } catch (err) {
    if (err instanceof ProjectNameRefused) throw new FatalJobError(err.message);
    throw err;
  }
  if (p.name !== boxProjectName(box.slug)) throw new FatalJobError(`project ${p.id} is not named ${boxProjectName(box.slug)}; refusing to touch it`);
  if (!(p.description ?? "").includes(projectTag(box.id))) {
    throw new FatalJobError(`project ${p.id} does not carry this box's control-plane tag; refusing to touch it`);
  }
  return { box, projectId: box.projectId, environmentId: box.environmentId, webServiceId: box.webServiceId };
}

export function suspendHandler(deps: { client: RailwayClient; workspaceId: string }): JobHandler {
  return {
    kind: "suspend",
    maxDurationMs: 15 * 60_000,
    steps: [
      {
        name: "mark_suspended",
        timeoutMs: 60_000,
        async run(ctx) {
          const box = await ctx.box();
          if (box.state === "suspended") return;
          if (box.state !== "active") throw new FatalJobError(`box ${box.slug} is ${box.state}; only an active box can be suspended`);
          const payload = ctx.job.payload ?? {};
          const idle = payload.reason === "idle";
          // The plan is rechecked now: a Free box that upgraded after the sweep queued it is exempt.
          if (idle && !(IDLE_POLICY_PLANS as readonly string[]).includes(box.planTier)) {
            throw new FatalJobError(`box ${box.slug} is on plan ${box.planTier}, which the idle policy exempts; not suspending`);
          }
          // An idle suspend whose box was used after the sweep queued it is dropped.
          if (payload.reason === "idle" && typeof payload.idleSince === "string" && box.lastHumanRequestAt && box.lastHumanRequestAt.getTime() > Date.parse(payload.idleSince)) {
            await ctx.db.insert(boxEvents).values({ boxId: box.id, kind: "idle_suspend_skipped", actor: "suspend-job", detail: { reason: "used since queued" } });
            return;
          }
          await railwayBox(ctx, deps);
          const moved = await ctx.db
            .update(boxes)
            .set({ state: "suspended", suspendedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(boxes.id, box.id), eq(boxes.state, "active"), ...(idle ? [inArray(boxes.planTier, [...IDLE_POLICY_PLANS])] : [])))
            .returning({ id: boxes.id });
          if (idle && !moved.length) {
            const now = await ctx.box();
            if (now.state === "active") throw new FatalJobError(`box ${box.slug} changed plan to ${now.planTier} while being suspended; not suspending`);
          }
          if (moved.length) {
            await ctx.db.insert(boxEvents).values({
              boxId: box.id,
              kind: "box_suspended",
              actor: "suspend-job",
              detail: { reason: payload.reason ?? null, requestedBy: payload.requestedBy ?? null, jobId: ctx.job.id },
            });
          }
        },
      },
      {
        name: "remove_deployment",
        timeoutMs: 2 * 60_000,
        async run(ctx) {
          const current = await ctx.box();
          if (current.state !== "suspended") return; // skipped above, or woken already
          const { projectId, environmentId, webServiceId } = await railwayBox(ctx, deps);
          const deployments = await recentDeployments(deps.client, projectId, environmentId, webServiceId, { signal: ctx.signal });
          const live = deployments.filter((d) => LIVE_DEPLOYMENT.has(d.status));
          for (const d of live) await removeDeployment(deps.client, d.id, { signal: ctx.signal });
          ctx.log.info("web deployment removed (box suspended)", { slug: current.slug, removed: live.length });
        },
      },
    ],
  };
}

export interface ResumeDeps {
  client: RailwayClient;
  workspaceId: string;
  fetch?: typeof fetch;
  /** Waits between polls; injectable for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
  deployWaitMs?: number;
  healthWaitMs?: number;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}

export function resumeHandler(deps: ResumeDeps): JobHandler {
  const sleep = deps.sleep ?? defaultSleep;
  const pollMs = deps.pollMs ?? 3_000;
  return {
    kind: "resume",
    maxDurationMs: 20 * 60_000,
    steps: [
      {
        name: "check",
        timeoutMs: 30_000,
        async run(ctx) {
          const box = await ctx.box();
          if (box.state === "active") return;
          if (box.state !== "suspended") throw new FatalJobError(`box ${box.slug} is ${box.state}; only a suspended box can be woken`);
          const suspending = await ctx.db
            .select({ id: jobs.id })
            .from(jobs)
            .where(and(eq(jobs.boxId, box.id), eq(jobs.kind, "suspend"), inArray(jobs.state, ["queued", "running"]), ne(jobs.id, ctx.job.id)));
          if (suspending.length) throw new RetryableJobError(`box ${box.slug} is still being suspended; waking it after that`, 5_000);
        },
      },
      {
        name: "deploy",
        timeoutMs: 2 * 60_000,
        async run(ctx) {
          const current = await ctx.box();
          if (current.state !== "suspended") return;
          const { box, projectId, environmentId, webServiceId } = await railwayBox(ctx, deps);
          // A deployment started after the suspend (a crashed earlier attempt) is reused.
          const latest = await latestDeployment(deps.client, projectId, environmentId, webServiceId, { signal: ctx.signal });
          const since = box.suspendedAt?.getTime() ?? 0;
          if (latest && Date.parse(latest.createdAt) > since && !DEPLOY_FAILED.has(latest.status)) return;
          await deployService(deps.client, webServiceId, environmentId, box.buildSource === "source" ? box.sourceCommit : null, { signal: ctx.signal });
        },
      },
      {
        name: "wait_healthy",
        timeoutMs: 12 * 60_000,
        async run(ctx) {
          const current = await ctx.box();
          if (current.state !== "suspended") return;
          const { box, projectId, environmentId, webServiceId } = await railwayBox(ctx, deps);
          const deployCap = Date.now() + (deps.deployWaitMs ?? 10 * 60_000);
          for (;;) {
            const d = await latestDeployment(deps.client, projectId, environmentId, webServiceId, { signal: ctx.signal });
            if (d?.status === "SUCCESS") break;
            if (d && DEPLOY_FAILED.has(d.status)) throw new Error(`the web deployment ended ${d.status}`);
            if (Date.now() > deployCap) throw new Error("the web deployment did not finish in time");
            await sleep(pollMs, ctx.signal);
          }
          if (!box.upstreamHost) throw new FatalJobError(`box ${box.slug} has no upstream host`);
          const healthCap = Date.now() + (deps.healthWaitMs ?? 3 * 60_000);
          for (;;) {
            const r = await probeHealth(`https://${box.upstreamHost}/api/health`, { fetch: deps.fetch });
            if (r.ok) return;
            if (Date.now() > healthCap) throw new Error(`the box did not answer health after its deployment (${r.error ?? "not ok"})`);
            await sleep(pollMs, ctx.signal);
          }
        },
      },
      {
        name: "mark_active",
        timeoutMs: 30_000,
        async run(ctx) {
          const now = new Date();
          const moved = await ctx.db
            .update(boxes)
            // The wake is human activity: the idle clock restarts (a visit through the router queued it,
            // or an operator did), so the next sweep does not pause the box again.
            .set({ state: "active", suspendedAt: null, lastHumanRequestAt: now, updatedAt: now })
            .where(and(eq(boxes.id, ctx.job.boxId), eq(boxes.state, "suspended")))
            .returning({ id: boxes.id });
          if (!moved.length) return;
          await ctx.db.update(boxHealth).set({ status: "unknown", consecutiveFailures: 0, updatedAt: now }).where(eq(boxHealth.boxId, ctx.job.boxId));
          await ctx.db.insert(boxEvents).values({
            boxId: ctx.job.boxId,
            kind: "box_resumed",
            actor: "resume-job",
            detail: { requestedBy: ctx.job.payload?.requestedBy ?? null, jobId: ctx.job.id, secondsSinceQueued: Math.round((now.getTime() - ctx.job.createdAt.getTime()) / 1000) },
          });
        },
      },
    ],
  };
}
