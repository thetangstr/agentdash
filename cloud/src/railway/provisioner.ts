// AgentDash: the provisioning job (spec §3.3, SC-2, GH #763): a port of
// scripts/hosted/provision-box.sh to idempotent steps on Railway's GraphQL API,
// run by the SC-3 job runner.
//
// Every step reads Railway's state first, creates only what is missing, and
// records each created ID on the box row before moving on, so a crashed job
// resumes where it stopped. The safety rules of lib.sh carry over:
//   - secrets come from crypto.randomBytes and live in memory; none reaches a
//     log, a job row, a box event, an error or a URL (the Railway client never
//     logs variables; the logger redacts);
//   - a failed variable read stops the step with nothing changed;
//   - a deployed box missing BETTER_AUTH_SECRET, PAPERCLIP_SECRETS_MASTER_KEY
//     or its invite code is NEVER given new ones: the job goes dead and pages
//     ops (the script's --i-know-this-destroys-secrets has no equivalent here);
//   - the project name guard and protected list (./names.ts) are checked
//     before any project is touched, and only projects carrying this box's
//     control-plane tag are adopted;
//   - the master key is sealed to the offline escrow key; only the ciphertext
//     is stored.
import { and, eq, sql } from "drizzle-orm";
import { decryptField, encryptField, sha256Hex, type DataKeyring } from "../crypto.js";
import type { CloudDb } from "../db/client.js";
import { accounts, boxEvents, boxes, railwayWorkspaces } from "../db/schema.js";
import { FatalJobError } from "../jobs/errors.js";
import type { BoxRow, JobContext, JobHandler, JobStep } from "../jobs/runner.js";
import { settingsService } from "../settings.js";
import {
  createProject,
  createService,
  createServiceDomain,
  createVolume,
  DEPLOY_FAILED,
  DEPLOY_IN_PROGRESS,
  deleteDeploymentTrigger,
  deploymentTriggerIds,
  deployService,
  getProject,
  latestDeployment,
  type ProjectDetail,
  serviceDomains,
  setBackupSchedule,
  updateServiceInstance,
  upsertVariables,
  variableNames,
  variableValue,
} from "./api.js";
import type { RailwayClient } from "./client.js";
import { ImageNotFound, RELEASE_TAG_RE, resolveImageDigest, resolveTagCommit } from "./image.js";
import { findProjectsByName } from "./delete.js";
import { assertBoxProjectName, boxProjectDescription, boxProjectName, projectTag } from "./names.js";
import { newAuthSecret, newClaimCode, newEdgeSecret, newMasterKey, newPostgresPassword, sealToEscrow } from "./secrets.js";
import { validateNewSlug, validateSlug } from "./slug.js";

/** Railway's Postgres image, major pinned (spike §2.2: the template now defaults to 18). */
export const PG_IMAGE = "ghcr.io/railwayapp-templates/postgres-ssl:17";
const PG_MOUNT = "/var/lib/postgresql/data";
const WEB_MOUNT = "/paperclip";
const WEB_PORT = 3100;
const CLAIM_DAYS = 7;
/** Secrets a deployed box must already have; generating new ones would lock users out or orphan stored secrets. */
export const GUARDED_SECRETS = ["BETTER_AUTH_SECRET", "PAPERCLIP_SECRETS_MASTER_KEY", "AGENTDASH_INVITE_CODES"] as const;

// The Volume is mounted root-owned and the image drops to `node`, so the start
// command hands /paperclip to node while still root (provision-box.sh step 7).
export const START_COMMAND =
  '/bin/sh -c "if [ \\"$(id -u)\\" = 0 ]; then chown node:node /paperclip && exec docker-entrypoint.sh node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js; else exec node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js; fi"';

export interface ProvisionerDeps {
  client: RailwayClient;
  /** The dedicated boxes workspace; the only one boxes are created in. */
  workspaceId: string;
  workspaceName?: string;
  dataKeys: DataKeyring;
  escrowPublicKey: Uint8Array | null;
  /** Boxes live at https://<slug>.<edgeDomain>. */
  edgeDomain: string;
  imageRepo: string;
  sourceRepo: string;
  /** Check health through the edge router too (SC-4; off until DNS #758 and the router exist). */
  edgeLive: boolean;
  /** For GHCR, GitHub and box health checks. */
  fetch?: typeof fetch;
  pollMs?: number;
  /** How long to wait for Railway to start a deployment by itself before calling deploy. */
  autoDeployGraceMs?: number;
  /** Wait caps (spec §3.3 step 8). */
  imageDeployWaitMs?: number;
  sourceDeployWaitMs?: number;
  healthWaitMs?: number;
  edgeHealthWaitMs?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

async function recordBox(db: CloudDb, boxId: string, patch: Partial<typeof boxes.$inferInsert>): Promise<void> {
  await db.update(boxes).set({ ...patch, updatedAt: new Date() }).where(eq(boxes.id, boxId));
}

function need<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined || value === "") throw new Error(`${what} is not recorded yet (an earlier step did not finish)`);
  return value;
}

function productionEnv(p: ProjectDetail): string {
  const env = p.environments.find((e) => e.name === "production");
  if (!env) throw new Error(`project ${p.name} has no production environment`);
  return env.id;
}

/** The box's database: the service running a Postgres image, else the one named Postgres (lib.sh postgres_service_id_of). */
function findPostgresService(p: ProjectDetail, recorded: string | null): { id: string; name: string } | null {
  if (recorded) {
    const s = p.services.find((x) => x.id === recorded);
    if (s) return s;
  }
  return p.services.find((s) => s.instances.some((i) => /postgres/i.test(i.image ?? ""))) ?? p.services.find((s) => s.name === "Postgres") ?? null;
}

function volumeOn(p: ProjectDetail, serviceId: string, mountPath: string) {
  return p.volumes.find((v) => v.serviceId === serviceId && v.mountPath === mountPath) ?? null;
}

/**
 * Railway's project listing shows a new volume instance only after a moment
 * (seen live, GH #763): re-read until it appears. If it never does, the step
 * fails and its retry finds (never re-creates) the volume.
 */
async function awaitVolume(read: () => Promise<ProjectDetail>, serviceId: string, mountPath: string, signal: AbortSignal, pollMs: number) {
  for (let i = 0; i < 20; i++) {
    const v = volumeOn(await read(), serviceId, mountPath);
    if (v) return v;
    await sleep(Math.min(pollMs, 1_000), signal);
  }
  throw new Error(`the volume at ${mountPath} was created but is not listed yet; the retry will record it`);
}

export function publicHost(slug: string, edgeDomain: string): string {
  return `${slug}.${edgeDomain}`;
}

/** The runbook §12 variable set (non-secret part), public URLs on the slug host from the first boot (spec §3.3 step 5). */
export function boxVariables(input: {
  slug: string;
  edgeDomain: string;
  railwayHost: string;
  releaseTag: string;
  claimEmail: string;
  postgresServiceName: string;
}): Record<string, string> {
  const url = `https://${publicHost(input.slug, input.edgeDomain)}`;
  return {
    PORT: String(WEB_PORT),
    PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
    PAPERCLIP_DEPLOYMENT_EXPOSURE: "public",
    PAPERCLIP_PUBLIC_URL: url,
    PAPERCLIP_AUTH_PUBLIC_BASE_URL: url,
    BILLING_PUBLIC_BASE_URL: url,
    PAPERCLIP_ALLOWED_HOSTNAMES: `${publicHost(input.slug, input.edgeDomain)},${input.railwayHost}`,
    PAPERCLIP_MIGRATION_AUTO_APPLY: "true",
    DATABASE_URL: `\${{${input.postgresServiceName}.DATABASE_URL}}`,
    AGENTDASH_SELF_SERVE_BOOTSTRAP: "true",
    AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE: "true",
    AGENTDASH_INVITE_VALIDATION_URL: `${url}/api/invites/validate`,
    AGENTDASH_FREE_AGENT_CAP: "2",
    AGENTDASH_DEPLOYMENT_KIND: "hosted",
    AGENTDASH_HERMES_MANAGED_PROFILES: "true",
    // The anonymous Test Drive creates a company; a hosted box holds one (#725). The boot guard refuses "true".
    AGENTDASH_TRIAL_ANONYMOUS: "false",
    AGENTDASH_RELEASE_TAG: input.releaseTag,
    AGENTDASH_BOX_SLUG: input.slug,
    AGENTDASH_CLAIM_EMAIL: input.claimEmail,
  };
}

export function provisionHandler(deps: ProvisionerDeps): JobHandler {
  const { client } = deps;
  const f = deps.fetch ?? fetch;
  const pollMs = deps.pollMs ?? 10_000;
  const grace = deps.autoDeployGraceMs ?? 15_000;

  const step = (name: string, timeoutMs: number, run: (ctx: JobContext, box: BoxRow) => Promise<void>): JobStep => ({
    name,
    timeoutMs,
    async run(ctx) {
      const box = await ctx.box();
      if (box.state !== "provisioning") throw new FatalJobError(`box ${box.slug} is ${box.state}, not provisioning`);
      const started = Date.now();
      await run(ctx, box);
      ctx.log.info("provision step done", { step: name, slug: box.slug, ms: Date.now() - started });
    },
  });

  const project = async (box: BoxRow, signal: AbortSignal) => getProject(client, need(box.projectId, "project_id"), { signal });

  return {
    kind: "provision",
    maxDurationMs: 30 * 60_000,
    async onGiveUp(ctx, outcome) {
      await ctx.db
        .update(boxes)
        .set({ state: "failed", updatedAt: new Date() })
        .where(and(eq(boxes.id, ctx.job.boxId), eq(boxes.state, "provisioning")));
      ctx.log.error("box provisioning gave up", { outcome });
    },
    steps: [
      // 1. Slug rules, workspace capacity, release and what to run.
      step("reserve", 60_000, async (ctx, box) => {
        if (box.projectId) validateSlug(box.slug);
        else validateNewSlug(box.slug);
        assertBoxProjectName(boxProjectName(box.slug));
        if (!deps.escrowPublicKey) {
          throw new FatalJobError("CLOUD_ESCROW_PUBLIC_KEY is not set; refusing to provision a box whose master key cannot be escrowed");
        }
        await ctx.db
          .insert(railwayWorkspaces)
          .values({ railwayWorkspaceId: deps.workspaceId, name: deps.workspaceName ?? "AgentDash Boxes" })
          .onConflictDoNothing();
        const [ws] = await ctx.db.select().from(railwayWorkspaces).where(eq(railwayWorkspaces.railwayWorkspaceId, deps.workspaceId));
        if (!ws) throw new Error("boxes workspace row missing");
        if (!box.railwayWorkspaceId) {
          if (!ws.accepting || ws.projectCount >= ws.capacity) {
            throw new Error(`workspace ${ws.name} is full (${ws.projectCount}/${ws.capacity}) or not accepting; add a workspace`);
          }
        } else if (box.railwayWorkspaceId !== ws.id) {
          throw new FatalJobError(`box ${box.slug} belongs to another workspace than the one this token reaches`);
        }
        const settings = await settingsService(ctx.db).getAll();
        const payloadTag = typeof ctx.job.payload?.releaseTag === "string" ? ctx.job.payload.releaseTag : null;
        const releaseTag = box.releaseTag ?? payloadTag ?? settings.target_release;
        if (!releaseTag || !RELEASE_TAG_RE.test(releaseTag)) {
          throw new Error("no target release: set target_release (e.g. v2026.925.0) and retry");
        }
        const patch: Partial<typeof boxes.$inferInsert> = { railwayWorkspaceId: ws.id, releaseTag };
        if (!box.buildSource) {
          try {
            patch.imageDigest = await resolveImageDigest(deps.imageRepo, releaseTag, { fetch: f, signal: ctx.signal });
            patch.buildSource = "image";
          } catch (err) {
            if (!(err instanceof ImageNotFound)) throw err;
            if (!settings.allow_source_fallback) {
              throw new Error(`no image at ${deps.imageRepo}:${releaseTag} and allow_source_fallback is off`);
            }
            patch.sourceCommit = await resolveTagCommit(deps.sourceRepo, releaseTag, { fetch: f, signal: ctx.signal });
            patch.buildSource = "source";
            ctx.log.warn("no image for the release; building the tag's commit instead (fallback)", { releaseTag });
          }
        }
        await recordBox(ctx.db, box.id, patch);
      }),

      // 2. The project agentdash-box-<slug>, tagged with this box's id.
      step("project", 60_000, async (ctx, box) => {
        const name = boxProjectName(box.slug);
        assertBoxProjectName(name);
        if (box.projectId) {
          const p = await getProject(client, box.projectId, { signal: ctx.signal });
          if (p.name !== name || !(p.description ?? "").includes(projectTag(box.id))) {
            throw new FatalJobError(`recorded project ${box.projectId} is not ${name} with this box's tag`);
          }
          if (!box.environmentId) await recordBox(ctx.db, box.id, { environmentId: productionEnv(p) });
          return;
        }
        const existing = await findProjectsByName(client, deps.workspaceId, name, ctx.signal);
        if (existing.length > 1) throw new FatalJobError(`more than one project is named ${name}`);
        let projectId: string;
        if (existing[0]) {
          if (!(existing[0].description ?? "").includes(projectTag(box.id))) {
            throw new FatalJobError(`a project named ${name} exists that was not created for this box; refusing to adopt it`);
          }
          projectId = existing[0].id;
        } else {
          projectId = (await createProject(client, { name, workspaceId: deps.workspaceId, description: boxProjectDescription(box.id) }, { signal: ctx.signal })).id;
          await recordBox(ctx.db, box.id, { projectId });
          await ctx.db
            .update(railwayWorkspaces)
            .set({ projectCount: sql`${railwayWorkspaces.projectCount} + 1`, updatedAt: new Date() })
            .where(eq(railwayWorkspaces.railwayWorkspaceId, deps.workspaceId));
          await ctx.db.insert(boxEvents).values({ boxId: box.id, kind: "project_created", actor: "provisioner", detail: { projectId } });
        }
        const p = await getProject(client, projectId, { signal: ctx.signal });
        await recordBox(ctx.db, box.id, { projectId, environmentId: productionEnv(p) });
      }),

      // 3. Postgres from Railway's image with its own volume and an in-memory password (spike §2).
      step("postgres", 3 * 60_000, async (ctx, box) => {
        const P = need(box.projectId, "project_id");
        const E = need(box.environmentId, "environment_id");
        let p = await project(box, ctx.signal);
        let pg = findPostgresService(p, box.pgServiceId);
        if (!pg) {
          const id = await createService(client, { projectId: P, environmentId: E, name: "Postgres" }, { signal: ctx.signal });
          await recordBox(ctx.db, box.id, { pgServiceId: id });
          pg = { id, name: "Postgres" };
          p = await project(box, ctx.signal);
        } else if (box.pgServiceId !== pg.id) {
          await recordBox(ctx.db, box.id, { pgServiceId: pg.id });
        }
        let vol = volumeOn(p, pg.id, PG_MOUNT);
        const imageSet = p.services.find((s) => s.id === pg!.id)?.instances.find((i) => i.environmentId === E)?.image ?? null;
        const deployed = (await latestDeployment(client, P, E, pg.id, { signal: ctx.signal })) !== null;
        if (!vol && !deployed) {
          await createVolume(client, { projectId: P, environmentId: E, serviceId: pg.id, mountPath: PG_MOUNT }, { signal: ctx.signal });
          vol = await awaitVolume(() => project(box, ctx.signal), pg.id, PG_MOUNT, ctx.signal, pollMs);
        }
        if (vol && box.pgVolumeId !== vol.id) await recordBox(ctx.db, box.id, { pgVolumeId: vol.id });
        const names = await variableNames(client, P, E, pg.id, { signal: ctx.signal });
        if (!names.includes("POSTGRES_PASSWORD")) {
          if (deployed) throw new FatalJobError("the box's Postgres has been deployed but POSTGRES_PASSWORD is missing; refusing to generate a new one");
          await upsertVariables(client, P, E, pg.id, {
            PGDATA: `${PG_MOUNT}/pgdata`,
            POSTGRES_USER: "postgres",
            POSTGRES_DB: "railway",
            POSTGRES_PASSWORD: newPostgresPassword(),
            PGHOST: "${{RAILWAY_PRIVATE_DOMAIN}}",
            PGPORT: "5432",
            PGUSER: "${{POSTGRES_USER}}",
            PGDATABASE: "${{POSTGRES_DB}}",
            PGPASSWORD: "${{POSTGRES_PASSWORD}}",
            DATABASE_URL: "postgresql://${{PGUSER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:5432/${{PGDATABASE}}",
            RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "60",
            SSL_CERT_DAYS: "820",
          }, { signal: ctx.signal });
        }
        if (!imageSet) {
          await updateServiceInstance(client, pg.id, E, { source: { image: PG_IMAGE }, restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 10 }, { signal: ctx.signal });
          await recordBox(ctx.db, box.id, { pgImage: PG_IMAGE });
        } else if (!box.pgImage) {
          await recordBox(ctx.db, box.id, { pgImage: imageSet });
        }
        if (!deployed) {
          // Setting the image deployed by itself on Hobby, not in the Pro workspace (spike §9.2): deploy only if nothing started.
          await sleep(grace, ctx.signal);
          if (!(await latestDeployment(client, P, E, pg.id, { signal: ctx.signal }))) await deployService(client, pg.id, E, null, { signal: ctx.signal });
        }
      }),

      // 4. `web`, its Volume at /paperclip, and a Railway domain on 3100.
      step("web", 2 * 60_000, async (ctx, box) => {
        const P = need(box.projectId, "project_id");
        const E = need(box.environmentId, "environment_id");
        const p = await project(box, ctx.signal);
        const found = (box.webServiceId && p.services.find((s) => s.id === box.webServiceId)) || p.services.find((s) => s.name === "web") || null;
        let webId: string;
        if (!found) {
          webId = await createService(client, { projectId: P, environmentId: E, name: "web" }, { signal: ctx.signal });
          await recordBox(ctx.db, box.id, { webServiceId: webId });
        } else {
          webId = found.id;
          if (box.webServiceId !== webId) await recordBox(ctx.db, box.id, { webServiceId: webId });
        }
        let vol = volumeOn(p, webId, WEB_MOUNT);
        if (!vol) {
          await createVolume(client, { projectId: P, environmentId: E, serviceId: webId, mountPath: WEB_MOUNT }, { signal: ctx.signal });
          vol = await awaitVolume(() => project(box, ctx.signal), webId, WEB_MOUNT, ctx.signal, pollMs);
        }
        if (box.webVolumeId !== vol.id) await recordBox(ctx.db, box.id, { webVolumeId: vol.id });
        const web = { id: webId };
        let host = (await serviceDomains(client, P, E, web.id, { signal: ctx.signal }))[0];
        if (!host) host = await createServiceDomain(client, E, web.id, WEB_PORT, { signal: ctx.signal });
        if (box.upstreamHost !== host) await recordBox(ctx.db, box.id, { upstreamHost: host });
      }),

      // 5. Variables, including the secrets, set before the first deploy.
      step("variables", 2 * 60_000, async (ctx, box) => {
        const P = need(box.projectId, "project_id");
        const E = need(box.environmentId, "environment_id");
        const W = need(box.webServiceId, "web_service_id");
        const host = need(box.upstreamHost, "upstream_host");
        const releaseTag = need(box.releaseTag, "release_tag");
        // A failed read must never look like "no variables" (lib.sh): it throws, and nothing below runs.
        const names = new Set(await variableNames(client, P, E, W, { signal: ctx.signal }));
        const deployed = (await latestDeployment(client, P, E, W, { signal: ctx.signal })) !== null;
        if (deployed) {
          for (const secret of GUARDED_SECRETS) {
            if (!names.has(secret)) {
              throw new FatalJobError(
                `box has been deployed but ${secret} is missing; generating a new one would lock users out or make stored secrets unreadable. Restore it from escrow.`,
              );
            }
          }
        }
        const p = await project(box, ctx.signal);
        const pg = findPostgresService(p, box.pgServiceId);
        if (!pg) throw new Error("the box has no Postgres service");
        const [acct] = await ctx.db.select({ email: accounts.email }).from(accounts).where(eq(accounts.id, box.accountId));
        if (!acct) throw new FatalJobError(`box ${box.slug} has no account`);

        // Read the live master key for escrow BEFORE any write, so a failed read changes nothing.
        let liveMasterKey: string | null = null;
        if (names.has("PAPERCLIP_SECRETS_MASTER_KEY") && !box.masterKeyEscrow) {
          liveMasterKey = await variableValue(client, P, E, W, "PAPERCLIP_SECRETS_MASTER_KEY", { signal: ctx.signal });
          if (!liveMasterKey) throw new Error("PAPERCLIP_SECRETS_MASTER_KEY is listed but its value could not be read");
        }

        const vars = boxVariables({ slug: box.slug, edgeDomain: deps.edgeDomain, railwayHost: host, releaseTag, claimEmail: acct.email, postgresServiceName: pg.name });
        const boxPatch: Partial<typeof boxes.$inferInsert> = { publicUrl: `https://${publicHost(box.slug, deps.edgeDomain)}` };

        // Claim code and edge secret: the control plane keeps them encrypted (to re-send the link, to give the router),
        // written to the row FIRST so a crash after Railway has them can re-use, not lose, them.
        if (!deployed || !names.has("AGENTDASH_INVITE_CODES")) {
          let claim = box.claimCodeEnc ? decryptField(deps.dataKeys, box.claimCodeEnc, "boxes.claim_code_enc") : null;
          if (!claim) {
            claim = newClaimCode();
            await recordBox(ctx.db, box.id, {
              claimCodeEnc: encryptField(deps.dataKeys, claim, "boxes.claim_code_enc"),
              claimCodeHash: sha256Hex(claim),
              claimExpiresAt: new Date(Date.now() + CLAIM_DAYS * 86_400_000),
            });
          }
          vars.AGENTDASH_INVITE_CODES = claim;
        }
        if (!deployed || !names.has("AGENTDASH_EDGE_SECRET")) {
          let edge = box.edgeSecretEnc ? decryptField(deps.dataKeys, box.edgeSecretEnc, "boxes.edge_secret_enc") : null;
          if (!edge) {
            edge = newEdgeSecret();
            await recordBox(ctx.db, box.id, { edgeSecretEnc: encryptField(deps.dataKeys, edge, "boxes.edge_secret_enc") });
          }
          vars.AGENTDASH_EDGE_SECRET = edge;
        }
        let generatedMasterKey: string | null = null;
        if (!names.has("BETTER_AUTH_SECRET")) vars.BETTER_AUTH_SECRET = newAuthSecret();
        if (!names.has("PAPERCLIP_SECRETS_MASTER_KEY")) {
          generatedMasterKey = newMasterKey();
          vars.PAPERCLIP_SECRETS_MASTER_KEY = generatedMasterKey;
        }
        await upsertVariables(client, P, E, W, vars, { signal: ctx.signal });
        const toEscrow = generatedMasterKey ?? liveMasterKey;
        if (toEscrow && (!box.masterKeyEscrow || generatedMasterKey)) {
          boxPatch.masterKeyEscrow = await sealToEscrow(deps.escrowPublicKey!, toEscrow);
        }
        await recordBox(ctx.db, box.id, boxPatch);
        await ctx.db.insert(boxEvents).values({
          boxId: box.id,
          kind: "variables_converged",
          actor: "provisioner",
          detail: { names: Object.keys(vars).sort(), generated: Object.keys(vars).filter((k) => ["BETTER_AUTH_SECRET", "PAPERCLIP_SECRETS_MASTER_KEY"].includes(k)) },
        });
      }),

      // 7 (before the source is set, so a deploy the source triggers already has them). Daily and weekly snapshots, both volumes.
      step("snapshots", 60_000, async (ctx, box) => {
        // Re-derived from Railway (and re-recorded), so a job resumed here never depends on an earlier write.
        const p = await project(box, ctx.signal);
        const pgVol = volumeOn(p, need(box.pgServiceId, "pg_service_id"), PG_MOUNT);
        const webVol = volumeOn(p, need(box.webServiceId, "web_service_id"), WEB_MOUNT);
        if (!pgVol || !webVol) throw new Error("a box volume is not listed yet; retrying");
        if (box.pgVolumeId !== pgVol.id || box.webVolumeId !== webVol.id) await recordBox(ctx.db, box.id, { pgVolumeId: pgVol.id, webVolumeId: webVol.id });
        for (const v of [pgVol.id, webVol.id]) {
          await setBackupSchedule(client, v, ["DAILY", "WEEKLY"], { signal: ctx.signal });
        }
      }),

      // 6. Health check, restart policy, the Volume-ownership start command, and the source (last).
      step("service_settings", 60_000, async (ctx, box) => {
        const P = need(box.projectId, "project_id");
        const E = need(box.environmentId, "environment_id");
        const W = need(box.webServiceId, "web_service_id");
        const source =
          box.buildSource === "image"
            ? { image: `${deps.imageRepo}@${need(box.imageDigest, "image_digest")}` }
            : { repo: deps.sourceRepo };
        await updateServiceInstance(client, W, E, {
          healthcheckPath: "/api/health",
          healthcheckTimeout: 300,
          startCommand: START_COMMAND,
          restartPolicyType: "ON_FAILURE",
          restartPolicyMaxRetries: 3,
          numReplicas: 1,
          ...(box.buildSource === "source" ? { dockerfilePath: "Dockerfile" } : {}),
          source,
        }, { signal: ctx.signal });
        if (box.buildSource === "source") {
          // A source-built box must never redeploy on a push to the repository.
          for (const id of await deploymentTriggerIds(client, P, E, W, { signal: ctx.signal })) {
            await deleteDeploymentTrigger(client, id, { signal: ctx.signal });
          }
        }
      }),

      // 8a. Deploy, and wait for SUCCESS (15 min from an image; 25 min for the source fallback).
      step("deploy", 26 * 60_000, async (ctx, box) => {
        const P = need(box.projectId, "project_id");
        const E = need(box.environmentId, "environment_id");
        const W = need(box.webServiceId, "web_service_id");
        const cap = box.buildSource === "source" ? (deps.sourceDeployWaitMs ?? 25 * 60_000) : (deps.imageDeployWaitMs ?? 15 * 60_000);
        const since = ctx.job.startedAt ? ctx.job.startedAt.getTime() : 0;
        const ours = (d: { createdAt: string } | null) => d !== null && Date.parse(d.createdAt) >= since - 1000;
        let latest = await latestDeployment(client, P, E, W, { signal: ctx.signal });
        const started = Date.now();
        if (!(ours(latest) && (latest!.status === "SUCCESS" || DEPLOY_IN_PROGRESS.has(latest!.status)))) {
          // Setting the source may already have started one (Hobby did; Pro did not, spike §9.2). Never deploy twice.
          await sleep(grace, ctx.signal);
          latest = await latestDeployment(client, P, E, W, { signal: ctx.signal });
          if (!(ours(latest) && DEPLOY_IN_PROGRESS.has(latest!.status))) {
            await deployService(client, W, E, box.buildSource === "source" ? need(box.sourceCommit, "source_commit") : null, { signal: ctx.signal });
          }
        }
        for (;;) {
          latest = await latestDeployment(client, P, E, W, { signal: ctx.signal });
          if (latest && ours(latest)) {
            if (latest.status === "SUCCESS") break;
            if (DEPLOY_FAILED.has(latest.status)) throw new Error(`deployment ${latest.id} ended ${latest.status}`);
          }
          if (Date.now() - started > cap) throw new Error(`deployment did not succeed within ${Math.round(cap / 60_000)} min`);
          await sleep(pollMs, ctx.signal);
        }
        await ctx.db.insert(boxEvents).values({
          boxId: box.id,
          kind: "deployed",
          actor: "provisioner",
          detail: { deploymentId: latest.id, buildSource: box.buildSource, waitedMs: Date.now() - started },
        });
      }),

      // 8b. Healthy and `authenticated` on the Railway host (5 min), then through the router (2 min) once it exists.
      step("health", 8 * 60_000, async (ctx, box) => {
        const check = async (url: string, capMs: number) => {
          const started = Date.now();
          let last = "no answer";
          for (;;) {
            try {
              const res = await f(`${url}/api/health`, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]) });
              const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
              if (res.ok && body?.status === "ok") {
                if (body.deploymentMode !== "authenticated") {
                  throw new FatalJobError(`box is healthy but deploymentMode=${String(body.deploymentMode)}; refusing to hand it over`);
                }
                if (body.hostedBox !== true) throw new FatalJobError("box is healthy but not in hosted mode (hostedBox is not true); refusing to hand it over");
                return body;
              }
              last = `HTTP ${res.status}`;
            } catch (err) {
              if (err instanceof FatalJobError) throw err;
              if (ctx.signal.aborted) throw ctx.signal.reason;
              last = err instanceof Error ? err.name : String(err);
            }
            if (Date.now() - started > capMs) throw new Error(`${url} did not become healthy within ${Math.round(capMs / 60_000)} min (${last})`);
            await sleep(pollMs, ctx.signal);
          }
        };
        const health = await check(`https://${need(box.upstreamHost, "upstream_host")}`, deps.healthWaitMs ?? 5 * 60_000);
        await recordBox(ctx.db, box.id, { lastHealth: { ...health, checkedAt: new Date().toISOString() } });
        if (deps.edgeLive) await check(`https://${publicHost(box.slug, deps.edgeDomain)}`, deps.edgeHealthWaitMs ?? 2 * 60_000);
        else ctx.log.info("edge router not live yet (SC-4, DNS #758): skipped the health check through the slug host", { slug: box.slug });
      }),

      // 9. Publish: the box waits for its claim.
      step("publish", 30_000, async (ctx, box) => {
        await ctx.db.transaction(async (tx) => {
          await tx.update(boxes).set({ state: "awaiting_claim", updatedAt: new Date() }).where(and(eq(boxes.id, box.id), eq(boxes.state, "provisioning")));
          await tx.insert(boxEvents).values({ boxId: box.id, kind: "box_ready", actor: "provisioner", detail: { publicUrl: box.publicUrl, releaseTag: box.releaseTag, buildSource: box.buildSource } });
        });
        ctx.log.info("box ready; the ready email is sent by the front door (SC-7)", { slug: box.slug });
      }),
    ],
  };
}
