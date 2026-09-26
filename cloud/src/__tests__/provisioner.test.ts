// SC-2 (GH #763): the Railway provisioner against a fake Railway API and
// embedded Postgres. Ports every scenario of scripts/hosted/provision-box.test.mjs
// that applies to the control plane (the CLI-only ones, xtrace, --redeploy,
// --close-signup, are noted where they map to other issues).
import { randomUUID } from "node:crypto";
import sodium from "libsodium-wrappers";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decryptField, parseKeyring, sha256Hex } from "../crypto.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { boxEvents, boxes, jobs } from "../db/schema.js";
import type { Alert } from "../jobs/alerts.js";
import { FatalJobError } from "../jobs/errors.js";
import { BoxOpError, createBoxForOperator } from "../jobs/ops.js";
import { type JobContext, type JobRow, JobRunner } from "../jobs/runner.js";
import { createLogger } from "../logger.js";
import { VariablesUnreadable } from "../railway/api.js";
import { assertBoxProjectName, projectTag, ProjectNameRefused } from "../railway/names.js";
import { PG_IMAGE, provisionHandler, START_COMMAND, type ProvisionerDeps } from "../railway/provisioner.js";
import { settingsService } from "../settings.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";
import { FAKE_TOKEN, FAKE_WORKSPACE } from "./fake-railway.js";
import { type BoxFakeOptions, FakeRailwayBoxes } from "./fake-railway-boxes.js";

const TAG = "v2026.930.0";
const KEYS = parseKeyring("44".repeat(32));
let pg: TestDatabase;
let db: CloudDb;
let close: () => Promise<void>;
let escrow: { publicKey: Uint8Array; privateKey: Uint8Array };
const logLines: string[] = [];
const log = createLogger({ write: (l) => logLines.push(l), level: "debug" });
const alerts: Alert[] = [];
let n = 0;

beforeAll(async () => {
  pg = await startTestDatabase();
  await migrateCloudDb(pg.url);
  ({ db, close } = createCloudDb(pg.url));
  await sodium.ready;
  escrow = sodium.crypto_box_keypair();
});

afterAll(async () => {
  await close?.();
  await pg?.stop();
});

beforeEach(async () => {
  alerts.length = 0;
  await db.execute(sql`truncate settings`);
  await db.execute(sql`update jobs set state = 'dead' where state in ('queued', 'running', 'failed')`);
  const s = settingsService(db);
  await s.set("provisioning_enabled", true, "test");
  await s.set("daily_cap", 1000, "test");
});

function setup(opts: BoxFakeOptions = {}, extra: Partial<ProvisionerDeps> = {}) {
  const fake = new FakeRailwayBoxes({ ghcrTags: [TAG], ...opts });
  const deps: ProvisionerDeps = {
    client: fake.client({ log }),
    workspaceId: FAKE_WORKSPACE,
    dataKeys: KEYS,
    escrowPublicKey: escrow.publicKey,
    edgeDomain: "agentdash.cloud",
    imageRepo: "ghcr.io/thetangstr/agentdash",
    sourceRepo: "thetangstr/agentdash",
    edgeLive: false,
    fetch: fake.http,
    pollMs: 5,
    autoDeployGraceMs: 0,
    ...extra,
  };
  const handler = provisionHandler(deps);
  const runner = new JobRunner({ db, log, handlers: [handler], alerter: { send: async (a) => void alerts.push(a) } });
  return { fake, deps, handler, runner };
}

async function newBox(slug = `b${++n}x${Date.now() % 10000}`) {
  const r = await createBoxForOperator(db, { slug, email: `founder-${slug}@example.test`, releaseTag: TAG }, "test");
  expect(r.provisioning.outcome).toBe("queued");
  return { slug, boxId: r.boxId, jobId: (r.provisioning as { jobId: string }).jobId };
}

async function boxRow(id: string) {
  return (await db.select().from(boxes).where(eq(boxes.id, id)))[0]!;
}

async function jobRow(id: string) {
  return (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
}

/** Run named steps directly (not through the runner) against a box that stays `provisioning`. */
async function runSteps(handler: ReturnType<typeof provisionHandler>, boxId: string, names: string[], jobPatch: Partial<JobRow> = {}) {
  await db.update(jobs).set({ state: "dead" }).where(eq(jobs.boxId, boxId));
  const job = { id: randomUUID(), boxId, kind: "provision", payload: null, startedAt: new Date(Date.now() - 60_000), ...jobPatch } as JobRow;
  const ctx: JobContext = { db, job, log, signal: new AbortController().signal, box: () => boxRow(boxId) };
  for (const name of names) {
    const s = handler.steps.find((x) => x.name === name);
    if (!s) throw new Error(`no step ${name}`);
    await s.run(ctx);
  }
}

const ALL_BUT_PUBLISH = ["reserve", "project", "postgres", "web", "variables", "snapshots", "service_settings", "deploy", "health"];

function upserts(fake: FakeRailwayBoxes, serviceId: string): Array<Record<string, string>> {
  return fake.calls
    .filter((c) => c.op === "variableCollectionUpsert" && (c.variables.i as { serviceId: string }).serviceId === serviceId)
    .map((c) => (c.variables.i as { variables: Record<string, string> }).variables);
}

describe("a fresh box, from nothing to awaiting_claim", () => {
  it("provisions from the GHCR image by digest, records every ID, and escrows the master key", async () => {
    const { fake, runner } = setup();
    const { slug, boxId, jobId } = await newBox();
    expect(await runner.runOnce()).toBe(jobId);
    const job = await jobRow(jobId);
    expect(job.state, job.lastError ?? "").toBe("succeeded");

    const box = await boxRow(boxId);
    expect(box.state).toBe("awaiting_claim");
    const project = fake.projects.get(box.projectId!)!;
    expect(project.name).toBe(`agentdash-box-${slug}`);
    expect(project.description).toContain(projectTag(boxId));
    expect(project.workspaceId).toBe(FAKE_WORKSPACE);
    const web = fake.byName(project.id, "web")!;
    const pgSvc = fake.byName(project.id, "Postgres")!;
    expect(box).toMatchObject({
      webServiceId: web.id,
      pgServiceId: pgSvc.id,
      environmentId: fake.envs.get(project.id),
      upstreamHost: web.domains[0],
      publicUrl: `https://${slug}.agentdash.cloud`,
      releaseTag: TAG,
      buildSource: "image",
      imageDigest: `sha256:${"ab".repeat(32)}`,
      pgImage: PG_IMAGE,
    });

    // Postgres: its own volume, an in-memory password, the pinned image, deployed.
    expect(pgSvc.source).toEqual({ image: PG_IMAGE });
    expect(pgSvc.variables.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(pgSvc.deployments).toHaveLength(1);

    // web: image by digest, service settings, one deployment.
    expect(web.source).toEqual({ image: `ghcr.io/thetangstr/agentdash@sha256:${"ab".repeat(32)}` });
    expect(web.settings).toMatchObject({ healthcheckPath: "/api/health", startCommand: START_COMMAND, restartPolicyType: "ON_FAILURE", numReplicas: 1 });
    expect(web.deployments).toHaveLength(1);

    // Volumes with daily and weekly snapshots.
    const vols = [...fake.volumes.values()].filter((v) => v.projectId === project.id);
    expect(vols.map((v) => v.mountPath).sort()).toEqual(["/paperclip", "/var/lib/postgresql/data"]);
    for (const v of vols) expect(v.backups).toEqual(["DAILY", "WEEKLY"]);
    expect([box.webVolumeId, box.pgVolumeId].sort()).toEqual(vols.map((v) => v.instanceId).sort());

    // Variables: the hosted boot-guard set, public URLs on the slug host from the first boot, trial off.
    const v = web.variables;
    expect(v).toMatchObject({
      PAPERCLIP_DEPLOYMENT_MODE: "authenticated",
      PAPERCLIP_PUBLIC_URL: `https://${slug}.agentdash.cloud`,
      PAPERCLIP_AUTH_PUBLIC_BASE_URL: `https://${slug}.agentdash.cloud`,
      BILLING_PUBLIC_BASE_URL: `https://${slug}.agentdash.cloud`,
      PAPERCLIP_ALLOWED_HOSTNAMES: `${slug}.agentdash.cloud,${web.domains[0]}`,
      DATABASE_URL: "${{Postgres.DATABASE_URL}}",
      AGENTDASH_DEPLOYMENT_KIND: "hosted",
      AGENTDASH_HERMES_MANAGED_PROFILES: "true",
      AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE: "true",
      AGENTDASH_TRIAL_ANONYMOUS: "false",
      AGENTDASH_RELEASE_TAG: TAG,
      AGENTDASH_BOX_SLUG: slug,
      AGENTDASH_CLAIM_EMAIL: `founder-${slug}@example.test`,
    });
    expect(v.AGENTDASH_INVITE_CODES).toMatch(/^AGD-[0-9A-F]{26}$/);
    expect(v.BETTER_AUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(v.PAPERCLIP_SECRETS_MASTER_KEY!, "base64")).toHaveLength(32);
    expect(v.AGENTDASH_EDGE_SECRET).toMatch(/^[0-9a-f]{64}$/);

    // The control plane keeps the claim code and edge secret encrypted, the claim hash, and only the sealed master key.
    expect(decryptField(KEYS, box.claimCodeEnc!, "boxes.claim_code_enc")).toBe(v.AGENTDASH_INVITE_CODES);
    expect(box.claimCodeHash).toBe(sha256Hex(v.AGENTDASH_INVITE_CODES!));
    expect(box.claimExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(decryptField(KEYS, box.edgeSecretEnc!, "boxes.edge_secret_enc")).toBe(v.AGENTDASH_EDGE_SECRET);
    const opened = sodium.crypto_box_seal_open(Buffer.from(box.masterKeyEscrow!, "base64"), escrow.publicKey, escrow.privateKey);
    expect(sodium.to_string(opened)).toBe(v.PAPERCLIP_SECRETS_MASTER_KEY);
    expect(box.lastHealth).toMatchObject({ status: "ok", deploymentMode: "authenticated", hostedBox: true });
    const events = (await db.select().from(boxEvents).where(eq(boxEvents.boxId, boxId))).map((e) => e.kind);
    expect(events).toEqual(expect.arrayContaining(["project_created", "variables_converged", "deployed", "box_ready"]));
  });

  it("re-running every step converges: nothing is duplicated and no secret changes", async () => {
    const { fake, handler } = setup();
    const { boxId } = await newBox();
    await runSteps(handler, boxId, ALL_BUT_PUBLISH);
    const box = await boxRow(boxId);
    const web = fake.svc(box.webServiceId);
    const before = { ...web.variables, pg: fake.svc(box.pgServiceId).variables.POSTGRES_PASSWORD, escrow: box.masterKeyEscrow, claim: box.claimCodeHash };
    const counts = () => ({
      projects: fake.projects.size,
      services: fake.services.size,
      volumes: fake.volumes.size,
      domains: web.domains.length,
      webDeploys: web.deployments.length,
      pgDeploys: fake.svc(box.pgServiceId).deployments.length,
    });
    const first = counts();
    await runSteps(handler, boxId, ALL_BUT_PUBLISH);
    expect(counts()).toEqual(first);
    const after = await boxRow(boxId);
    expect({ ...web.variables, pg: fake.svc(box.pgServiceId).variables.POSTGRES_PASSWORD, escrow: after.masterKeyEscrow, claim: after.claimCodeHash }).toEqual(before);
    expect(first).toEqual({ projects: 1, services: 2, volumes: 2, domains: 1, webDeploys: 1, pgDeploys: 1 });
  });

  it("resumes after a crash between steps without creating anything twice", async () => {
    const { fake, handler, runner } = setup();
    const { boxId } = await newBox();
    await runSteps(handler, boxId, ["reserve", "project", "postgres"]);
    // A job recorded at "web", as a worker picking up a crashed job finds it.
    const [resumed] = await db.insert(jobs).values({ boxId, kind: "provision", step: "web" }).returning();
    const jobId = resumed!.id;
    await runner.runOnce();
    expect((await jobRow(jobId)).state).toBe("succeeded");
    expect(fake.projects.size).toBe(1);
    expect(fake.services.size).toBe(2);
    expect(fake.ops().filter((o) => o === "projectCreate")).toHaveLength(1);
  });
});

describe("secret safety (lib.sh rules)", () => {
  async function deployedBox(fakeOpts: BoxFakeOptions = {}) {
    const t = setup(fakeOpts);
    const { boxId } = await newBox();
    await runSteps(t.handler, boxId, ALL_BUT_PUBLISH);
    const box = await boxRow(boxId);
    return { ...t, boxId, box, web: t.fake.svc(box.webServiceId) };
  }

  it("a failed variable-NAME read stops before any write", async () => {
    const { fake, handler, boxId, web } = await deployedBox();
    const snapshot = { ...web.variables };
    const writesBefore = upserts(fake, web.id).length;
    fake.failVariablesRead = "names";
    await expect(runSteps(handler, boxId, ["variables"])).rejects.toBeInstanceOf(VariablesUnreadable);
    expect(upserts(fake, web.id)).toHaveLength(writesBefore);
    expect(web.variables).toEqual(snapshot);
  });

  it("a failed variable-VALUE read (escrowing a live master key) stops before any write", async () => {
    const { fake, handler, boxId, web } = await deployedBox();
    await db.update(boxes).set({ masterKeyEscrow: null }).where(eq(boxes.id, boxId));
    const writesBefore = upserts(fake, web.id).length;
    fake.failVariablesRead = "values";
    await expect(runSteps(handler, boxId, ["variables"])).rejects.toBeInstanceOf(VariablesUnreadable);
    expect(upserts(fake, web.id)).toHaveLength(writesBefore);
    expect((await boxRow(boxId)).masterKeyEscrow).toBeNull();
    // Once the read works, the live key is escrowed, not a new one.
    fake.failVariablesRead = null;
    await runSteps(handler, boxId, ["variables"]);
    const opened = sodium.crypto_box_seal_open(Buffer.from((await boxRow(boxId)).masterKeyEscrow!, "base64"), escrow.publicKey, escrow.privateKey);
    expect(sodium.to_string(opened)).toBe(web.variables.PAPERCLIP_SECRETS_MASTER_KEY);
  });

  for (const missing of ["PAPERCLIP_SECRETS_MASTER_KEY", "BETTER_AUTH_SECRET", "AGENTDASH_INVITE_CODES"]) {
    it(`a deployed box missing ${missing} is never given a new one (the job goes dead)`, async () => {
      const { fake, handler, runner, boxId, web } = await deployedBox();
      delete web.variables[missing];
      const writesBefore = upserts(fake, web.id).length;
      await expect(runSteps(handler, boxId, ["variables"])).rejects.toThrow(new RegExp(`${missing} is missing`));
      expect(upserts(fake, web.id)).toHaveLength(writesBefore);
      expect(web.variables[missing]).toBeUndefined();
      // Through the runner: dead, and ops is paged.
      const [job] = await db.insert(jobs).values({ boxId, kind: "provision", step: "variables" }).returning();
      await runner.runOnce();
      expect((await jobRow(job!.id)).state).toBe("dead");
      expect(alerts.at(-1)).toMatchObject({ kind: "job_dead", step: "variables" });
    });
  }

  it("an existing box's secrets are never rewritten, and Postgres is found by image, not by name", async () => {
    const { fake, handler, boxId, box, web } = await deployedBox();
    fake.svc(box.pgServiceId).name = "Database";
    const live = { ...web.variables };
    await runSteps(handler, boxId, ["variables"]);
    const sent = upserts(fake, web.id).at(-1)!;
    for (const k of ["BETTER_AUTH_SECRET", "PAPERCLIP_SECRETS_MASTER_KEY", "AGENTDASH_INVITE_CODES", "AGENTDASH_EDGE_SECRET"]) {
      expect(sent[k], `${k} must not be rewritten`).toBeUndefined();
      expect(web.variables[k]).toBe(live[k]);
    }
    expect(sent.AGENTDASH_DEPLOYMENT_KIND).toBe("hosted");
    expect(sent.AGENTDASH_TRIAL_ANONYMOUS).toBe("false");
    expect(sent.DATABASE_URL).toBe("${{Database.DATABASE_URL}}");
  });

  it("a deployed Postgres missing its password is never given a new one", async () => {
    const { fake, handler, boxId, box } = await deployedBox();
    delete fake.svc(box.pgServiceId).variables.POSTGRES_PASSWORD;
    await expect(runSteps(handler, boxId, ["postgres"])).rejects.toBeInstanceOf(FatalJobError);
  });

  it("no generated secret or the Railway token reaches a log line, the job table or a box event", async () => {
    const { fake, runner } = setup();
    logLines.length = 0;
    const { boxId, jobId } = await newBox();
    await runner.runOnce();
    expect((await jobRow(jobId)).state).toBe("succeeded");
    const box = await boxRow(boxId);
    const web = fake.svc(box.webServiceId);
    const secrets = [
      web.variables.BETTER_AUTH_SECRET!,
      web.variables.PAPERCLIP_SECRETS_MASTER_KEY!,
      web.variables.AGENTDASH_INVITE_CODES!,
      web.variables.AGENTDASH_EDGE_SECRET!,
      fake.svc(box.pgServiceId).variables.POSTGRES_PASSWORD!,
      FAKE_TOKEN,
    ];
    for (const s of secrets) expect(s.length).toBeGreaterThan(20);
    const stored = JSON.stringify({
      logs: logLines,
      jobs: await db.select().from(jobs).where(eq(jobs.boxId, boxId)),
      events: await db.select().from(boxEvents).where(eq(boxEvents.boxId, boxId)),
    });
    for (const s of secrets) expect(stored.includes(s), "a secret leaked").toBe(false);
    expect(logLines.join("\n")).toContain("provision step done");
  });
});

describe("names, slugs and images", () => {
  it("box slugs are capped at 16 and reserved names are refused, before any Railway call", async () => {
    const { fake } = setup();
    await expect(createBoxForOperator(db, { slug: "acme-corporation-eu", email: "a@example.test" }, "test")).rejects.toThrow(/at most 16/);
    await expect(createBoxForOperator(db, { slug: "admin", email: "a@example.test" }, "test")).rejects.toThrow(/reserved/);
    await expect(createBoxForOperator(db, { slug: "Bad_Slug", email: "a@example.test" }, "test")).rejects.toBeInstanceOf(BoxOpError);
    expect(fake.calls).toHaveLength(0);
    const ok = await createBoxForOperator(db, { slug: `acme-corp-${n++}`.slice(0, 16), email: "ok@example.test" }, "test");
    expect(ok.provisioning.outcome).toBe("queued");
  });

  it("protected and non-prefixed project names are refused", () => {
    for (const name of ["agentdash", "agentdash-demo", "yarda-backend-v2", "perceptive-integrity", "acme", "box-acme"]) {
      expect(() => assertBoxProjectName(name), name).toThrow(ProjectNameRefused);
    }
    expect(() => assertBoxProjectName("agentdash-box-acme")).not.toThrow();
  });

  it("a project with the box's name that this box did not create is never adopted", async () => {
    const { fake, runner } = setup();
    const { slug, jobId } = await newBox();
    fake.addProject({ name: `agentdash-box-${slug}`, description: "made by hand" });
    await runner.runOnce();
    const job = await jobRow(jobId);
    expect(job.state).toBe("dead");
    expect(job.lastError).toMatch(/not created for this box/);
    expect(fake.ops()).not.toContain("projectCreate");
    expect(fake.services.size).toBe(0);
  });

  it("a missing image stops before any Railway call and names the fallback; the v-prefixed tag is the one checked", async () => {
    const { fake, runner } = setup({ ghcrTags: ["2026.930.0"] });
    const { boxId, jobId } = await newBox();
    await runner.runOnce();
    const job = await jobRow(jobId);
    expect(job.state).toBe("queued");
    expect(job.lastError).toMatch(/no image at ghcr\.io\/thetangstr\/agentdash:v2026\.930\.0 and allow_source_fallback is off/);
    expect(fake.httpCalls.join("\n")).toMatch(/manifests\/v2026\.930\.0/);
    expect(fake.calls).toHaveLength(0);
    expect((await boxRow(boxId)).projectId).toBeNull();
  });

  it("with the fallback allowed, it builds the release tag's commit and removes auto-deploy triggers", async () => {
    await settingsService(db).set("allow_source_fallback", true, "test");
    const sha = "9f4d41850e562c6f582e4767843c0e225cf9e8b7";
    const { fake, runner } = setup({ ghcrTags: [], githubTags: { [TAG]: sha } });
    const { boxId, jobId } = await newBox();
    await runner.runOnce();
    expect((await jobRow(jobId)).state).toBe("succeeded");
    const box = await boxRow(boxId);
    expect(box).toMatchObject({ buildSource: "source", sourceCommit: sha, imageDigest: null });
    const web = fake.svc(box.webServiceId);
    expect(web.source).toEqual({ repo: "thetangstr/agentdash" });
    expect(web.settings.dockerfilePath).toBe("Dockerfile");
    expect(web.deployments.map((d) => d.commitSha)).toEqual([sha]);
    expect(web.triggers).toEqual([]);
  });

  it("when setting the source starts a deployment by itself, it is not deployed a second time", async () => {
    const { fake, runner } = setup({ autoDeployOnSource: true });
    const { boxId, jobId } = await newBox();
    await runner.runOnce();
    expect((await jobRow(jobId)).state).toBe("succeeded");
    const box = await boxRow(boxId);
    expect(fake.svc(box.webServiceId).deployments).toHaveLength(1);
    expect(fake.ops().filter((o) => o === "serviceInstanceDeployV2")).toHaveLength(0);
  });
});

describe("deploy and health", () => {
  it("a failed deployment is retried; the box stays provisioning", async () => {
    const { runner } = setup({ deployOutcome: "FAILED" });
    const { boxId, jobId } = await newBox();
    await runner.runOnce();
    const job = await jobRow(jobId);
    expect(job).toMatchObject({ state: "queued", step: "deploy" });
    expect(job.lastError).toMatch(/ended FAILED/);
    expect((await boxRow(boxId)).state).toBe("provisioning");
  });

  it("a box that comes up in the wrong mode is never handed over", async () => {
    const { runner } = setup({ health: { status: "ok", deploymentMode: "local_trusted", hostedBox: true } });
    const { boxId, jobId } = await newBox();
    await runner.runOnce();
    expect((await jobRow(jobId)).state).toBe("dead");
    expect((await jobRow(jobId)).lastError).toMatch(/deploymentMode=local_trusted/);
    expect((await boxRow(boxId)).state).toBe("failed");
  });

  it("refuses to start without an escrow key", async () => {
    const { fake, runner } = setup({}, { escrowPublicKey: null });
    const { jobId } = await newBox();
    await runner.runOnce();
    expect((await jobRow(jobId)).state).toBe("dead");
    expect(fake.calls).toHaveLength(0);
  });
});
