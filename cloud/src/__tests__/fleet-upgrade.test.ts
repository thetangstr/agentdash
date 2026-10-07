// SC-12 (GH #773) fleet upgrade and GH #861 box purpose, against the fake
// Railway and an embedded Postgres. Boxes are provisioned for real through
// the SC-2 provisioner on the fake, then upgraded by the upgrade job and the
// rollout orchestrator.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import sodium from "libsodium-wrappers";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAdmin } from "../admin/run.js";
import { parseKeyring } from "../crypto.js";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { boxEvents, boxes, boxUpgrades, jobs, rollouts, type BoxPurpose } from "../db/schema.js";
import type { Alert } from "../jobs/alerts.js";
import { createBoxForOperator } from "../jobs/ops.js";
import {
  cancelRollout,
  planWaves,
  resumeRollout,
  RolloutError,
  rolloutStatus,
  startRollout,
  tickRollout,
  upgradeOneBox,
} from "../jobs/rollout.js";
import { type JobContext, JobRunner } from "../jobs/runner.js";
import { judgeHealth, upgradeHandler } from "../jobs/upgrade.js";
import { inWindow, nextWindowStart, parseWindow } from "../jobs/upgrade-window.js";
import { createLogger } from "../logger.js";
import { deployService } from "../railway/api.js";
import { BackupPruneExhaustedError, BackupPruneTimeoutError, makeRoomForVolumeBackup, planBackupPrune } from "../railway/upgrade-api.js";
import { provisionHandler } from "../railway/provisioner.js";
import { internalRoutes } from "../routes/internal.js";
import { parseSettingValue, SettingValidationError, settingsService } from "../settings.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";
import { FAKE_WORKSPACE } from "./fake-railway.js";
import type { BoxFakeOptions, FakeVolume } from "./fake-railway-boxes.js";
import { digestFor, FakeRailwayUpgrade } from "./fake-railway-upgrade.js";

const caps = vi.hoisted(() => ({ claimTrackingReady: true }));
vi.mock("../capabilities.js", () => ({ capabilities: caps }));

const OLD = "v2026.930.0";
const NEW = "v2026.1001.0";
const NEW_COMMIT = "c".repeat(40);
const IMAGE_REPO = "ghcr.io/thetangstr/agentdash";
const SOURCE_REPO = "thetangstr/agentdash";
const KEYS = parseKeyring("55".repeat(32));
let pg: TestDatabase;
let db: CloudDb;
let close: () => Promise<void>;
let escrowPublicKey: Uint8Array;
const log = createLogger({ write: () => {}, level: "debug" });
const alerts: Alert[] = [];
let n = 0;

beforeAll(async () => {
  pg = await startTestDatabase();
  await migrateCloudDb(pg.url);
  ({ db, close } = createCloudDb(pg.url));
  await sodium.ready;
  escrowPublicKey = sodium.crypto_box_keypair().publicKey;
});

afterAll(async () => {
  await close?.();
  await pg?.stop();
});

beforeEach(async () => {
  alerts.length = 0;
  // Each test owns its boxes: earlier tests' boxes are held (rollouts skip them) and their work is closed.
  await db.execute(sql`update rollouts set state = 'cancelled', finished_at = now() where state = 'running'`);
  await db.execute(sql`update box_upgrades set state = 'failed' where state in ('planned', 'queued', 'running', 'rolling_back')`);
  await db.execute(sql`update jobs set state = 'dead' where state in ('queued', 'running', 'failed')`);
  await db.execute(sql`update boxes set hold_upgrades = true`);
  await db.execute(sql`truncate settings`);
  const s = settingsService(db);
  await s.set("provisioning_enabled", true, "test");
  await s.set("daily_cap", 1000, "test");
  await s.set("target_release", NEW, "test");
});

function setup(fakeOpts: BoxFakeOptions = {}) {
  const fake = new FakeRailwayUpgrade({ ghcrTags: [OLD, NEW], githubTags: { [NEW]: NEW_COMMIT }, ...fakeOpts });
  const client = fake.client({ log });
  const provision = provisionHandler({
    client,
    workspaceId: FAKE_WORKSPACE,
    dataKeys: KEYS,
    escrowPublicKey,
    edgeDomain: "agentdash.cloud",
    imageRepo: IMAGE_REPO,
    sourceRepo: SOURCE_REPO,
    edgeLive: false,
    fetch: fake.upgradeHttp,
    pollMs: 5,
    autoDeployGraceMs: 0,
  });
  const upgrade = upgradeHandler({
    client,
    workspaceId: FAKE_WORKSPACE,
    edgeDomain: "agentdash.cloud",
    imageRepo: IMAGE_REPO,
    sourceRepo: SOURCE_REPO,
    edgeLive: true,
    alerter: { send: async (a) => void alerts.push(a) },
    fetch: fake.upgradeHttp,
    pollMs: 5,
    deployWaitMs: 2_000,
    healthWaitMs: 300,
    edgeHealthWaitMs: 300,
  });
  const runner = new JobRunner({ db, log, handlers: [provision, upgrade], alerter: { send: async (a) => void alerts.push(a) } });
  const resolver = { imageRepo: IMAGE_REPO, sourceRepo: SOURCE_REPO, fetch: fake.upgradeHttp };
  return { fake, runner, upgrade, resolver };
}

async function drain(runner: JobRunner): Promise<number> {
  let ran = 0;
  while (await runner.runOnce()) ran += 1;
  return ran;
}

/** A provisioned, claimed, active box on OLD. */
async function activeBox(env: ReturnType<typeof setup>, opts: { purpose?: BoxPurpose; ageDays?: number } = {}) {
  const slug = `u${++n}x${randomUUID().slice(0, 6)}`;
  const r = await createBoxForOperator(db, { slug, email: `founder-${slug}@example.test`, releaseTag: OLD, ...(opts.purpose ? { purpose: opts.purpose } : {}) }, "test");
  expect(r.provisioning.outcome).toBe("queued");
  await drain(env.runner);
  const created = new Date(Date.now() - (opts.ageDays ?? 0) * 86_400_000);
  await db.update(boxes).set({ state: "active", claimedAt: new Date(), createdAt: created }).where(eq(boxes.id, r.boxId));
  const box = await boxRow(r.boxId);
  expect(box.state).toBe("active");
  expect(box.imageDigest).toBe(digestFor(OLD));
  return box;
}

async function boxRow(id: string) {
  return (await db.select().from(boxes).where(eq(boxes.id, id)))[0]!;
}

async function upgradeOf(boxId: string) {
  return (await db.select().from(boxUpgrades).where(eq(boxUpgrades.boxId, boxId)).orderBy(asc(boxUpgrades.createdAt))).at(-1)!;
}

async function eventKinds(boxId: string) {
  return (await db.select().from(boxEvents).where(eq(boxEvents.boxId, boxId))).map((e) => e.kind);
}

// ---- Pure parts ------------------------------------------------------------

describe("planWaves", () => {
  const at = (days: number) => new Date(Date.UTC(2026, 0, 1) + days * 86_400_000);
  it("puts canaries first, then 10 percent of the rest oldest-first, then batches of 5", () => {
    const customers = Array.from({ length: 23 }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, purpose: "customer" as const, createdAt: at(i) }));
    const canary = [{ id: "k1", purpose: "canary" as const, createdAt: at(100) }];
    const internal = [{ id: "i1", purpose: "internal" as const, createdAt: at(-1) }];
    const w = planWaves([...customers.reverse(), ...canary, ...internal]);
    expect(w.get("k1")).toBe(0);
    // 24 non-canary boxes: ceil(2.4) = 3 in the 10 percent wave, the oldest ones.
    expect([...w].filter(([, v]) => v === 1).map(([k]) => k).sort()).toEqual(["c00", "c01", "i1"]);
    expect([...w].filter(([, v]) => v === 2).map(([k]) => k).sort()).toEqual(["c02", "c03", "c04", "c05", "c06"]);
    expect(Math.max(...w.values())).toBe(2 + Math.ceil(21 / 5) - 1);
  });
  it("gives a small fleet at least one box in the 10 percent wave", () => {
    const w = planWaves([{ id: "a", purpose: "customer", createdAt: at(1) }, { id: "b", purpose: "customer", createdAt: at(2) }]);
    expect(w.get("a")).toBe(1);
    expect(w.get("b")).toBe(2);
  });
});

describe("the upgrade window", () => {
  const w = parseWindow("02:00-05:00", "America/Los_Angeles");
  it("is 02:00 to 05:00 Pacific, across daylight saving", () => {
    expect(inWindow(new Date("2026-10-01T09:30:00Z"), w)).toBe(true); // 02:30 PDT
    expect(inWindow(new Date("2026-10-01T12:00:00Z"), w)).toBe(false); // 05:00 PDT
    expect(inWindow(new Date("2026-12-01T10:30:00Z"), w)).toBe(true); // 02:30 PST
    expect(inWindow(new Date("2026-12-01T09:30:00Z"), w)).toBe(false); // 01:30 PST
    expect(nextWindowStart(new Date("2026-10-01T19:00:00Z"), w).toISOString()).toBe("2026-10-02T09:00:00.000Z");
  });
  it("wraps midnight, and null means always open", () => {
    const wrap = parseWindow("23:00-01:00", "UTC");
    expect(inWindow(new Date("2026-10-01T23:30:00Z"), wrap)).toBe(true);
    expect(inWindow(new Date("2026-10-01T00:30:00Z"), wrap)).toBe(true);
    expect(inWindow(new Date("2026-10-01T01:30:00Z"), wrap)).toBe(false);
    expect(inWindow(new Date(), null)).toBe(true);
  });
  it("is validated as a setting", () => {
    expect(parseSettingValue("upgrade_window", "01:30-04:00")).toBe("01:30-04:00");
    expect(parseSettingValue("upgrade_window", "always")).toBeNull();
    expect(() => parseSettingValue("upgrade_window", "2-5")).toThrow(SettingValidationError);
    expect(() => parseSettingValue("upgrade_window", "03:00-03:00")).toThrow(SettingValidationError);
    expect(parseSettingValue("upgrade_window_tz", "Europe/Paris")).toBe("Europe/Paris");
    expect(() => parseSettingValue("upgrade_window_tz", "Mars/Olympus")).toThrow(SettingValidationError);
  });
});

describe("judgeHealth", () => {
  const want = { tag: NEW, commit: NEW_COMMIT };
  const base = { status: "ok", deploymentMode: "authenticated", hostedBox: true };
  it("wants the exact release tag, and the commit when the box reports one", () => {
    expect(judgeHealth(200, { ...base, releaseTag: NEW }, want).ok).toBe(true);
    expect(judgeHealth(200, { ...base, status: "degraded", releaseTag: NEW, releaseCommit: NEW_COMMIT.slice(0, 12) }, want).ok).toBe(true);
    expect(judgeHealth(200, { ...base, releaseTag: OLD }, want)).toMatchObject({ ok: false, definitive: false });
    expect(judgeHealth(200, { ...base, releaseTag: NEW, releaseCommit: "d".repeat(40) }, want)).toMatchObject({ ok: false, definitive: true });
    expect(judgeHealth(200, { ...base, releaseTag: NEW, hostedBox: false }, want)).toMatchObject({ ok: false, definitive: true });
    expect(judgeHealth(503, { status: "unhealthy" }, want)).toMatchObject({ ok: false, definitive: false });
  });
});

describe("admin CLI", () => {
  async function cli(argv: string[]) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const io = {
      out: () => {},
      err: () => {},
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    };
    const code = await runAdmin(argv, { CLOUD_ADMIN_TOKEN: "t" }, io);
    return { code, calls };
  }
  it("maps the fleet and purpose commands onto /internal", async () => {
    const at = "http://localhost:3200/internal";
    expect((await cli(["boxes", "create", "demo-acme", "a@b.co", OLD, "--purpose", "demo"])).calls[0]).toEqual({ method: "POST", url: `${at}/boxes`, body: { slug: "demo-acme", email: "a@b.co", releaseTag: OLD, purpose: "demo" } });
    expect((await cli(["boxes", "list", "--purpose", "canary"])).calls[0]).toMatchObject({ method: "GET", url: `${at}/boxes?purpose=canary` });
    expect((await cli(["boxes", "upgrade", "acme", "--now"])).calls[0]).toEqual({ method: "POST", url: `${at}/boxes/acme/upgrade`, body: { now: true } });
    expect((await cli(["boxes", "upgrade", "acme", NEW])).calls[0]).toEqual({ method: "POST", url: `${at}/boxes/acme/upgrade`, body: { releaseTag: NEW, now: false } });
    expect((await cli(["boxes", "hold", "acme"])).calls[0]).toMatchObject({ method: "POST", url: `${at}/boxes/acme/hold` });
    expect((await cli(["boxes", "purpose", "acme", "canary"])).calls[0]).toEqual({ method: "POST", url: `${at}/boxes/acme/purpose`, body: { purpose: "canary" } });
    expect((await cli(["rollout", "start", "--now"])).calls[0]).toEqual({ method: "POST", url: `${at}/rollout/start`, body: { now: true } });
    expect((await cli(["rollout", "status"])).calls[0]).toMatchObject({ method: "GET", url: `${at}/rollout` });
    for (const a of ["pause", "resume", "cancel", "tick"]) expect((await cli(["rollout", a])).calls[0]).toMatchObject({ method: "POST", url: `${at}/rollout/${a}` });
    expect((await cli(["boxes", "list", "--purpose"])).code).toBe(64);
    expect((await cli(["rollout", "start", "extra"])).code).toBe(64);
  });
});

// ---- One box ---------------------------------------------------------------

describe("upgrading one box", () => {
  it("snapshots both volumes, points at the new digest, deploys once, and verifies the exact release", async () => {
    const env = setup();
    const box = await activeBox(env);
    const web = env.fake.webOf(box.slug);
    const deploysBefore = web.deployments.length;
    const r = await upgradeOneBox(db, env.resolver, { slug: box.slug, now: true }, "test");
    expect(r).toMatchObject({ toTag: NEW, imageDigest: digestFor(NEW) });
    expect(await drain(env.runner)).toBe(1);

    const up = await upgradeOf(box.id);
    expect(up.state, up.error ?? "").toBe("succeeded");
    expect(up).toMatchObject({ fromTag: OLD, fromDigest: digestFor(OLD), toTag: NEW, toDigest: digestFor(NEW), toCommit: NEW_COMMIT });
    expect(up.fromDeploymentId).toBe(web.deployments[deploysBefore - 1]!.id);
    expect(env.fake.backupsTaken.sort()).toEqual([box.pgVolumeId, box.webVolumeId].sort());
    expect(web.source).toEqual({ image: `${IMAGE_REPO}@${digestFor(NEW)}` });
    expect(web.deployments).toHaveLength(deploysBefore + 1);
    expect(env.fake.running(web)!.variables.AGENTDASH_RELEASE_TAG).toBe(NEW);
    // Verified on the Railway host and through the router.
    expect(env.fake.httpCalls).toEqual(expect.arrayContaining([`GET https://${box.upstreamHost}/api/health`, `GET https://${box.slug}.agentdash.cloud/api/health`]));
    expect(await boxRow(box.id)).toMatchObject({ releaseTag: NEW, imageDigest: digestFor(NEW), buildSource: "image", holdUpgrades: false });
    expect(await eventKinds(box.id)).toEqual(expect.arrayContaining(["upgrade_requested", "upgrade_started", "pre_upgrade_snapshot", "upgrade_deployed", "upgraded"]));
    expect(alerts).toHaveLength(0);
  });

  it("carries pending variable changes (set with skipDeploys, e.g. close-signup) into the new deployment", async () => {
    const env = setup();
    const box = await activeBox(env);
    const web = env.fake.webOf(box.slug);
    web.variables.PAPERCLIP_AUTH_DISABLE_SIGN_UP = "true";
    expect(env.fake.running(web)!.variables.PAPERCLIP_AUTH_DISABLE_SIGN_UP).toBeUndefined();
    await upgradeOneBox(db, env.resolver, { slug: box.slug, now: true }, "test");
    await drain(env.runner);
    expect(env.fake.running(web)!.variables.PAPERCLIP_AUTH_DISABLE_SIGN_UP).toBe("true");
  });

  it("rolls back and holds the box when health keeps reporting the old release", async () => {
    const env = setup();
    const box = await activeBox(env);
    const web = env.fake.webOf(box.slug);
    // The new deployment "succeeds" but the box still answers with the old release.
    env.fake.healthHook = () => ({ status: "ok", deploymentMode: "authenticated", hostedBox: true, releaseTag: OLD });
    await upgradeOneBox(db, env.resolver, { slug: box.slug, now: true }, "test");
    await drain(env.runner);

    const up = await upgradeOf(box.id);
    expect(up.state, up.error ?? "").toBe("rolled_back");
    expect(up.error).toMatch(/releaseTag=v2026\.930\.0, expected v2026\.1001\.0/);
    expect(up.rollbackDeploymentId).toBeTruthy();
    expect(env.fake.snapshots.get(up.rollbackDeploymentId!)!.rollbackOf).toBe(up.fromDeploymentId);
    expect(web.source).toEqual({ image: `${IMAGE_REPO}@${digestFor(OLD)}` });
    expect(web.variables.AGENTDASH_RELEASE_TAG).toBe(OLD);
    expect(env.fake.running(web)!.variables.AGENTDASH_RELEASE_TAG).toBe(OLD);
    const after = await boxRow(box.id);
    expect(after).toMatchObject({ holdUpgrades: true, releaseTag: OLD, imageDigest: digestFor(OLD) });
    // A single-box upgrade holds the box but does not pause rollouts.
    expect(await settingsService(db).get("rollout_paused")).toBe(false);
    expect(alerts.map((a) => a.subject)).toEqual([expect.stringMatching(/failed and was rolled back; box held$/)]);
    expect(await eventKinds(box.id)).toEqual(expect.arrayContaining(["upgrade_rolling_back", "upgrade_failed"]));
  });

  it("rolls back at once when health reports a different commit than the release's", async () => {
    const env = setup();
    const box = await activeBox(env);
    env.fake.healthHook = (_svc, run) =>
      run.variables.AGENTDASH_RELEASE_TAG === NEW
        ? { status: "ok", deploymentMode: "authenticated", hostedBox: true, releaseTag: NEW, releaseCommit: "d".repeat(40) }
        : null;
    await upgradeOneBox(db, env.resolver, { slug: box.slug, now: true }, "test");
    await drain(env.runner);
    const up = await upgradeOf(box.id);
    expect(up.state).toBe("rolled_back");
    expect(up.error).toMatch(/releaseCommit=d{40}, expected c{40}/);
  });

  it("rolls back a deployment that fails, to the previous deployment", async () => {
    const env = setup();
    const box = await activeBox(env);
    const web = env.fake.webOf(box.slug);
    env.fake.nextOutcomes.push("FAILED");
    await upgradeOneBox(db, env.resolver, { slug: box.slug, now: true }, "test");
    await drain(env.runner);
    const up = await upgradeOf(box.id);
    expect(up.state).toBe("rolled_back");
    expect(up.error).toMatch(/ended FAILED/);
    expect(web.deployments.map((d) => d.status).slice(-2)).toEqual(["FAILED", "SUCCESS"]);
    expect(env.fake.running(web)!.image).toBe(`${IMAGE_REPO}@${digestFor(OLD)}`);
    expect((await boxRow(box.id)).holdUpgrades).toBe(true);
  });

  it("marks a rollback that does not come back healthy as failed, and pages ops", async () => {
    const env = setup();
    const box = await activeBox(env);
    env.fake.nextOutcomes.push("FAILED", "CRASHED");
    await upgradeOneBox(db, env.resolver, { slug: box.slug, now: true }, "test");
    await drain(env.runner);
    const up = await upgradeOf(box.id);
    expect(up.state).toBe("failed");
    expect(up.error).toMatch(/ended FAILED; rollback deployment .* ended CRASHED/);
    expect(alerts[0]!.subject).toMatch(/NOT rolled back cleanly/);
  });

  it("refuses a held box, a demo box, a release without a GHCR image, and a box already upgrading", async () => {
    const env = setup();
    const held = await activeBox(env);
    await db.update(boxes).set({ holdUpgrades: true }).where(eq(boxes.id, held.id));
    await expect(upgradeOneBox(db, env.resolver, { slug: held.slug, now: true }, "test")).rejects.toThrow(/hold_upgrades is set/);
    const demo = await activeBox(env, { purpose: "demo" });
    expect(demo).toMatchObject({ purpose: "demo", holdUpgrades: true });
    await expect(upgradeOneBox(db, env.resolver, { slug: demo.slug, now: true }, "test")).rejects.toThrow(RolloutError);
    const box = await activeBox(env);
    await expect(upgradeOneBox(db, env.resolver, { slug: box.slug, releaseTag: "v2026.1002.0", now: true }, "test")).rejects.toThrow(/no GHCR image/);
    await upgradeOneBox(db, env.resolver, { slug: box.slug, now: true }, "test");
    await expect(upgradeOneBox(db, env.resolver, { slug: box.slug, now: true }, "test")).rejects.toThrow(/already has an upgrade in flight/);
  });

  it("waits for the window unless told now", async () => {
    const env = setup();
    const box = await activeBox(env);
    // A window that is closed right now: it opened and closed an hour ago (UTC).
    const h = new Date().getUTCHours();
    const pad = (x: number) => String((x + 24) % 24).padStart(2, "0");
    await settingsService(db).set("upgrade_window", `${pad(h - 2)}:00-${pad(h - 1)}:00`, "test");
    await settingsService(db).set("upgrade_window_tz", "Etc/UTC", "test");
    const r = await upgradeOneBox(db, env.resolver, { slug: box.slug }, "test");
    expect(Date.parse(String(r.runAfter))).toBeGreaterThan(Date.now() + 20 * 3_600_000);
    expect(await drain(env.runner)).toBe(0);
  });

  it("resumes after a control-plane restart without deploying twice", async () => {
    const env = setup();
    const box = await activeBox(env);
    const web = env.fake.webOf(box.slug);
    const deploysBefore = web.deployments.length;
    const r = await upgradeOneBox(db, env.resolver, { slug: box.slug, now: true }, "test");
    // The first worker runs prepare..variables, calls deploy, and dies before recording the deployment.
    const [job] = await db.select().from(jobs).where(eq(jobs.id, String(r.jobId)));
    const ctx: JobContext = { db, job: job!, log, signal: new AbortController().signal, box: () => boxRow(box.id) };
    for (const name of ["prepare", "snapshot", "point", "variables"]) await env.upgrade.steps.find((s) => s.name === name)!.run(ctx);
    await deployService(env.fake.client(), box.webServiceId!, box.environmentId!, null);
    await db.update(jobs).set({ step: "deploy" }).where(eq(jobs.id, job!.id));
    // A new worker takes the job over at the recorded step.
    expect(await drain(env.runner)).toBe(1);
    const up = await upgradeOf(box.id);
    expect(up.state, up.error ?? "").toBe("succeeded");
    expect(web.deployments).toHaveLength(deploysBefore + 1);
    expect(up.deploymentId).toBe(web.deployments.at(-1)!.id);
    expect(env.fake.backupsTaken).toHaveLength(2);
  });
});

// ---- The Railway backup quota (P0: upgrades broke at 10 backups) -------------
// This code deletes production backups: every test pins exactly which backups
// were deleted (or that none were), not just the outcome.

describe("the Railway backup quota", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 8, 1) - n * 86_400_000).toISOString();
  const manual = (id: string, daysAgo: number, locked = false) => ({ id, name: "Manual", createdAt: day(daysAgo), expiresAt: null, scheduleId: null, locked });
  const scheduled = (id: string, daysAgo: number) => ({ id, name: "Daily", createdAt: day(daysAgo), expiresAt: day(-daysAgo), scheduleId: "sched-daily" });
  const volOf = (env: ReturnType<typeof setup>, instanceId: string | null) =>
    [...env.fake.volumes.values()].find((v) => v.instanceId === instanceId)!;
  /** Every volumeInstanceBackupDelete sent (refused ones included), by backup id. */
  const deletes = (env: { fake: FakeRailwayUpgrade }) => env.fake.calls.filter((c) => c.op === "volumeInstanceBackupDelete").map((c) => String(c.variables.b));
  const run = async (env: ReturnType<typeof setup>, slug: string) => {
    const r = await upgradeOneBox(db, env.resolver, { slug, now: true }, "test");
    await drain(env.runner);
    return r;
  };

  it("does not delete anything when the volume is under the limit", async () => {
    const env = setup();
    const box = await activeBox(env);
    const pg = volOf(env, box.pgVolumeId);
    // 9 of 10: the snapshot fits. Old manual backups are NOT pruned pre-emptively,
    // and 9 scheduled ones do not fail an upgrade Railway would accept.
    pg.backupRecords.push(...Array.from({ length: 5 }, (_, i) => manual(`m${i}`, 40 - i)), ...Array.from({ length: 4 }, (_, i) => scheduled(`s${i}`, i + 1)));
    await run(env, box.slug);
    const up = await upgradeOf(box.id);
    expect(up.state, up.error ?? "").toBe("succeeded");
    expect(deletes(env)).toEqual([]);
    expect(pg.backupRecords).toHaveLength(10);
    expect(env.fake.backupsTaken.sort()).toEqual([box.pgVolumeId, box.webVolumeId].sort());
  });

  it("at the limit deletes only the oldest prunable manual backup, waits for it to go, then snapshots", async () => {
    // The deletion is asynchronous: it is still listed for two more polls.
    const env = setup({ backupDeleteClearsAfterLists: 3 });
    const box = await activeBox(env);
    const pg = volOf(env, box.pgVolumeId);
    pg.backupRecords.push(...Array.from({ length: 8 }, (_, i) => manual(`m${i}`, 40 - i)), scheduled("d1", 1), scheduled("w1", 3));
    await run(env, box.slug);
    const up = await upgradeOf(box.id);
    expect(up.state, up.error ?? "").toBe("succeeded");
    // Exactly one delete — the oldest manual — and it was never re-sent while in flight.
    expect(deletes(env)).toEqual(["m0"]);
    const ids = pg.backupRecords.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "d1", "w1"]));
    expect(pg.backupRecords).toHaveLength(10);
    expect(pg.backupRecords.at(-1)).toMatchObject({ name: "Manual" });
    // The create came only after the list stopped showing m0.
    const pgCalls = env.fake.calls.filter((c) => c.variables.v === pg.instanceId).map((c) => c.op);
    const del = pgCalls.indexOf("volumeInstanceBackupDelete");
    const create = pgCalls.indexOf("volumeInstanceBackupCreate");
    expect(pgCalls.slice(del + 1, create)).toEqual(["volumeInstanceBackupList", "volumeInstanceBackupList", "volumeInstanceBackupList", "volumeInstanceBackupList"]);
    const pruned = await db.select().from(boxEvents).where(and(eq(boxEvents.boxId, box.id), eq(boxEvents.kind, "pre_upgrade_backups_pruned")));
    expect(pruned.map((e) => (e.detail as { backupIds: string[] }).backupIds)).toEqual([["m0"]]);
    expect(alerts).toHaveLength(0);
  });

  it("at the limit without enough prunable backups deletes nothing and fails dead, naming the volume", async () => {
    const env = setup();
    const box = await activeBox(env);
    const pg = volOf(env, box.pgVolumeId);
    // 10 of 10: one must go. The only manual backup outside the newest two (kept) is
    // locked, and the other 7 are scheduled: nothing is eligible.
    pg.backupRecords.push(manual("old", 20, true), manual("keep-a", 5), manual("keep-b", 2), ...Array.from({ length: 7 }, (_, i) => scheduled(`s${i}`, i + 1)));
    const before = pg.backupRecords.map((b) => b.id);
    const r = await run(env, box.slug);
    const up = await upgradeOf(box.id);
    expect(up.state).toBe("failed");
    expect(up.error).toContain(pg.instanceId);
    expect(up.error).toMatch(/none was deleted/);
    expect(deletes(env)).toEqual([]);
    expect(pg.backupRecords.map((b) => b.id)).toEqual(before);
    expect(env.fake.backupsTaken).toEqual([]);
    const [job] = await db.select().from(jobs).where(eq(jobs.id, String(r.jobId)));
    expect(job!.state).toBe("dead");
    expect(alerts.map((a) => a.kind)).toContain("job_dead");
    expect((await boxRow(box.id)).holdUpgrades).toBe(true);
  });

  it("over the limit with fewer prunable backups than needed deletes nothing", async () => {
    const env = setup();
    const box = await activeBox(env);
    const pg = volOf(env, box.pgVolumeId);
    // 11 of 10 (a plan downgrade): two must go, only one ("old") may. Do not delete it.
    pg.backupRecords.push(manual("old", 20), manual("keep-a", 5), manual("keep-b", 2), ...Array.from({ length: 8 }, (_, i) => scheduled(`s${i}`, i + 1)));
    await run(env, box.slug);
    expect((await upgradeOf(box.id)).state).toBe("failed");
    expect(deletes(env)).toEqual([]);
    expect(pg.backupRecords.map((b) => b.id)).toContain("old");
    expect(pg.backupRecords).toHaveLength(11);
  });

  it("never prunes a locked backup, whether the schema exposes the lock or only Railway refuses", async () => {
    for (const backupLockField of ["locked", null] as const) {
      const env = setup({ backupLockField });
      const box = await activeBox(env);
      const pg = volOf(env, box.pgVolumeId);
      pg.backupRecords.push(manual("m0", 40, true), ...Array.from({ length: 7 }, (_, i) => manual(`m${i + 1}`, 30 - i)), scheduled("d1", 1), scheduled("w1", 3));
      await run(env, box.slug);
      const up = await upgradeOf(box.id);
      expect(up.state, `${backupLockField}: ${up.error ?? ""}`).toBe("succeeded");
      expect(pg.backupRecords.map((b) => b.id)).toContain("m0");
      expect(pg.backupRecords.map((b) => b.id)).not.toContain("m1");
      // With the field selected, the locked backup is never even asked for.
      expect(deletes(env)).toEqual(backupLockField ? ["m1"] : ["m0", "m1"]);
    }
  });

  it("never deletes a backup named \"Manual\" that a schedule took (it has a scheduleId), even with no expiry", async () => {
    const env = setup();
    const box = await activeBox(env);
    const pg = volOf(env, box.pgVolumeId);
    // The oldest "Manual" is really a scheduled backup: no expiresAt, but a scheduleId.
    pg.backupRecords.push({ ...manual("m0", 40), scheduleId: "sched-x" }, ...Array.from({ length: 7 }, (_, i) => manual(`m${i + 1}`, 30 - i)), scheduled("d1", 1), scheduled("w1", 3));
    await run(env, box.slug);
    const up = await upgradeOf(box.id);
    expect(up.state, up.error ?? "").toBe("succeeded");
    expect(deletes(env)).toEqual(["m1"]);
    expect(pg.backupRecords.map((b) => b.id)).toContain("m0");
  });

  it("fails without deleting when the only old \"Manual\" backup has a scheduleId", async () => {
    const env = setup();
    const box = await activeBox(env);
    const pg = volOf(env, box.pgVolumeId);
    pg.backupRecords.push({ ...manual("old", 20), scheduleId: "sched-x" }, manual("keep-a", 5), manual("keep-b", 2), ...Array.from({ length: 7 }, (_, i) => scheduled(`s${i}`, i + 1)));
    await run(env, box.slug);
    expect((await upgradeOf(box.id)).state).toBe("failed");
    expect(deletes(env)).toEqual([]);
    expect(pg.backupRecords).toHaveLength(10);
  });

  it("waits out another actor's deletion and re-plans, so it deletes nothing once there is room", async () => {
    const env = setup();
    const box = await activeBox(env);
    const pg = volOf(env, box.pgVolumeId);
    pg.backupRecords.push(...Array.from({ length: 10 }, (_, i) => manual(`m${i}`, 30 - i)));
    // Someone is already deleting m5 in Railway; it clears after three list polls.
    pg.deleting = { backupId: "m5", clearsAfterLists: 3 };
    await run(env, box.slug);
    const up = await upgradeOf(box.id);
    expect(up.state, up.error ?? "").toBe("succeeded");
    // Our delete of m0 was refused ("in progress") and, once m5 went, never needed again.
    expect(pg.backupRecords.map((b) => b.id)).toContain("m0");
    expect(pg.backupRecords.map((b) => b.id)).not.toContain("m5");
    expect(env.fake.backupsTaken).toContain(box.pgVolumeId);
  });

  it("the snapshot step's budget covers both volumes' prune windows", () => {
    const env = setup();
    const snapshot = env.upgrade.steps.find((s) => s.name === "snapshot")!;
    // Default 5-minute prune window per volume; two volumes, plus room for the creates.
    expect(snapshot.timeoutMs).toBeGreaterThan(2 * 5 * 60_000);
  });

  describe("makeRoomForVolumeBackup (bounded waits)", () => {
    function volume(fake: FakeRailwayUpgrade): FakeVolume {
      const vol: FakeVolume = { id: "vol-x", instanceId: "volinst-x", projectId: "p", serviceId: "s", mountPath: "/data", backups: [], backupRecords: [], deleting: null, hiddenReads: 0 };
      fake.volumes.set(vol.id, vol);
      return vol;
    }
    function clock() {
      let t = 0;
      return { now: () => t, sleep: async (ms: number) => void (t += ms) };
    }

    it("gives up with a retryable timeout when its own deletion never finishes, without re-sending the delete", async () => {
      const fake = new FakeRailwayUpgrade({ backupDeleteClearsAfterLists: 1_000_000 });
      const vol = volume(fake);
      vol.backupRecords.push(...Array.from({ length: 10 }, (_, i) => manual(`m${i}`, 30 - i)));
      const c = clock();
      const err = await makeRoomForVolumeBackup(fake.client({ log }), vol.instanceId, { pollMs: 1_000, waitMs: 60_000, ...c }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BackupPruneTimeoutError);
      expect(String((err as Error).message)).toContain(vol.instanceId);
      expect(deletes({ fake })).toEqual(["m0"]);
      expect(c.now()).toBeLessThanOrEqual(61_000);
    });

    it("gives up with a retryable timeout when another deletion never finishes", async () => {
      const fake = new FakeRailwayUpgrade();
      const vol = volume(fake);
      vol.backupRecords.push(...Array.from({ length: 10 }, (_, i) => manual(`m${i}`, 30 - i)));
      vol.deleting = { backupId: "elsewhere", clearsAfterLists: 1_000_000 };
      const c = clock();
      const err = await makeRoomForVolumeBackup(fake.client({ log }), vol.instanceId, { pollMs: 1_000, waitMs: 60_000, ...c }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BackupPruneTimeoutError);
      expect(c.now()).toBeLessThanOrEqual(61_000);
      expect(vol.backupRecords).toHaveLength(10);
    });

    it("refuses a limit that leaves nothing prunable", async () => {
      const fake = new FakeRailwayUpgrade();
      const vol = volume(fake);
      await expect(makeRoomForVolumeBackup(fake.client({ log }), vol.instanceId, { limit: 3 })).rejects.toBeInstanceOf(BackupPruneExhaustedError);
      expect(deletes({ fake })).toEqual([]);
    });

    it("plans: scheduled (expiry or scheduleId), locked and the newest two manual backups are never eligible", () => {
      const all = [manual("a", 9), manual("b", 8, true), manual("c", 7), manual("d", 2), manual("e", 1), { ...scheduled("s", 3), locked: false }, { id: "x", name: "Manual", createdAt: day(10), expiresAt: day(-1), scheduleId: null, locked: false }, { id: "y", name: "Manual", createdAt: day(11), expiresAt: null, scheduleId: "sched-y", locked: false }];
      const plan = planBackupPrune(all, { limit: 6, keepManual: 2 });
      expect(plan.need).toBe(3);
      expect(plan.eligible.map((b) => b.id)).toEqual(["a", "c"]);
      expect(planBackupPrune(all, { limit: 10, keepManual: 2 }).need).toBe(0);
    });
  });
});

// ---- Review fixes (#898) -----------------------------------------------------

const MUTATIONS = ["serviceInstanceUpdate", "variableCollectionUpsert", "volumeInstanceBackupCreate", "serviceInstanceDeployV2", "deploymentRollback"];

describe("upgrade guards", () => {
  it.each([
    ["a project without this box's tag", (p: { description: string | null }) => void (p.description = "someone else's project")],
    ["a protected project", (p: { name: string }) => void (p.name = "agentdash")],
  ])("refuses %s before changing anything", async (_label, tamper) => {
    const env = setup();
    const box = await activeBox(env);
    tamper(env.fake.projects.get(box.projectId!)! as never);
    const from = env.fake.calls.length;
    await upgradeOneBox(db, env.resolver, { slug: box.slug, now: true }, "test");
    await drain(env.runner);
    const up = await upgradeOf(box.id);
    expect(up.state).toBe("failed");
    expect(up.error).toMatch(/refusing/);
    expect(env.fake.calls.slice(from).map((c) => c.op).filter((op) => MUTATIONS.includes(op))).toEqual([]);
    expect(env.fake.backupsTaken).toEqual([]);
    expect((await boxRow(box.id)).holdUpgrades).toBe(true);
  });

  it("rolls back when Railway's record of the deployment names another image than the release's digest", async () => {
    const env = setup();
    const box = await activeBox(env);
    // Health would report the new tag (the job set the variable), but the deployment runs the old image.
    env.fake.metaHook = (meta) => (String(meta.image ?? "").includes(digestFor(NEW)) ? { image: `${IMAGE_REPO}@${digestFor(OLD)}` } : null);
    await upgradeOneBox(db, env.resolver, { slug: box.slug, now: true }, "test");
    await drain(env.runner);
    const up = await upgradeOf(box.id);
    expect(up.state, up.error ?? "").toBe("rolled_back");
    expect(up.error).toBe(`deployment ${up.deploymentId} runs ${digestFor(OLD)}, expected ${digestFor(NEW)}`);
    expect((await boxRow(box.id)).releaseTag).toBe(OLD);
  });

  it("rolls a box that reported no release tag back to no tag, and verifies it by digest", async () => {
    const env = setup();
    const box = await activeBox(env);
    const web = env.fake.webOf(box.slug);
    delete web.variables.AGENTDASH_RELEASE_TAG;
    env.fake.deploy(web, null);
    await db.update(boxes).set({ releaseTag: null }).where(eq(boxes.id, box.id));
    env.fake.nextOutcomes.push("FAILED");
    await upgradeOneBox(db, env.resolver, { slug: box.slug, now: true }, "test");
    await drain(env.runner);
    const up = await upgradeOf(box.id);
    expect(up.state, up.error ?? "").toBe("rolled_back");
    expect(web.variables.AGENTDASH_RELEASE_TAG).toBe("");
    expect(env.fake.running(web)!.image).toBe(`${IMAGE_REPO}@${digestFor(OLD)}`);
  });

  it("rolls a source-built box back to its pinned commit, never the repository's HEAD", async () => {
    const env = setup();
    const box = await activeBox(env);
    const web = env.fake.webOf(box.slug);
    const commit = "a".repeat(40);
    web.source = { repo: SOURCE_REPO };
    env.fake.deploy(web, commit);
    await db.update(boxes).set({ buildSource: "source", sourceCommit: commit, imageDigest: null }).where(eq(boxes.id, box.id));
    env.fake.nextOutcomes.push("FAILED");
    await upgradeOneBox(db, env.resolver, { slug: box.slug, now: true }, "test");
    await drain(env.runner);
    const up = await upgradeOf(box.id);
    expect(up.state, up.error ?? "").toBe("rolled_back");
    expect(web.source).toEqual({ repo: SOURCE_REPO });
    expect(web.triggers).toEqual([]);
    expect(web.deployments.at(-1)).toMatchObject({ id: up.rollbackDeploymentId, commitSha: commit, status: "SUCCESS" });
    expect(env.fake.calls.some((c) => c.op === "deploymentRollback")).toBe(false);
  });

  it("asks Railway for a rollback once, and again only after the grace period", async () => {
    const env = setup();
    const box = await activeBox(env);
    const web = env.fake.webOf(box.slug);
    const r = await upgradeOneBox(db, env.resolver, { slug: box.slug, now: true }, "test");
    const [job] = await db.select().from(jobs).where(eq(jobs.id, String(r.jobId)));
    const ctx: JobContext = { db, job: job!, log, signal: new AbortController().signal, box: () => boxRow(box.id) };
    const run = (name: string) => env.upgrade.steps.find((s) => s.name === name)!.run(ctx);
    for (const name of ["prepare", "snapshot", "point", "variables"]) await run(name);
    const up = await upgradeOf(box.id);
    const dep = env.fake.deploy(web, null);
    // A rollback was asked for a moment ago and Railway does not list it yet: do not ask again.
    await db.update(boxUpgrades).set({ state: "rolling_back", deploymentId: dep, rollbackRequestedAt: new Date() }).where(eq(boxUpgrades.id, up.id));
    await expect(run("rollback")).rejects.toThrow(/does not list the rollback deployment yet/);
    expect(env.fake.calls.filter((c) => c.op === "deploymentRollback")).toHaveLength(0);
    await db.update(boxUpgrades).set({ rollbackRequestedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(boxUpgrades.id, up.id));
    await run("rollback");
    await run("rollback");
    expect(env.fake.calls.filter((c) => c.op === "deploymentRollback")).toHaveLength(1);
    expect((await upgradeOf(box.id)).rollbackDeploymentId).toBe(web.deployments.at(-1)!.id);
  });

  it("serialises jobs per box: nothing else runs on a box mid-upgrade, or while another of its jobs holds a lease", async () => {
    const env = setup();
    const box = await activeBox(env);
    let ran = 0;
    const runner = new JobRunner({ db, log, handlers: [{ kind: "close_signup", steps: [{ name: "x", timeoutMs: 5_000, run: async () => void (ran += 1) }] }] });
    const [up] = await db.insert(boxUpgrades).values({ boxId: box.id, state: "running", toTag: NEW, toDigest: digestFor(NEW) }).returning();
    const { enqueueJob } = await import("../jobs/queue.js");
    await enqueueJob(db, { boxId: box.id, kind: "close_signup" });
    expect(await runner.runOnce()).toBeNull();
    await db.update(boxUpgrades).set({ state: "succeeded" }).where(eq(boxUpgrades.id, up!.id));
    const other = await enqueueJob(db, { boxId: box.id, kind: "delete" });
    await db.update(jobs).set({ state: "running", lockedBy: "w-other", lockedUntil: new Date(Date.now() + 60_000) }).where(eq(jobs.id, other.id));
    expect(await runner.runOnce()).toBeNull();
    await db.update(jobs).set({ state: "dead" }).where(eq(jobs.id, other.id));
    expect(await runner.runOnce()).not.toBeNull();
    expect(ran).toBe(1);
  });
});

// ---- Rollouts --------------------------------------------------------------

describe("a fleet rollout", () => {
  it("refuses without a target release image, while paused, and while another rollout runs", async () => {
    const env = setup();
    await settingsService(db).set("target_release", "v2026.1002.0", "test");
    await expect(startRollout(db, env.resolver, { actor: "test" })).rejects.toThrow(/no GHCR image/);
    await settingsService(db).set("target_release", null, "test");
    await expect(startRollout(db, env.resolver, { actor: "test" })).rejects.toThrow(/target_release is not set/);
    await settingsService(db).set("target_release", NEW, "test");
    await settingsService(db).set("rollout_paused", true, "test");
    await expect(startRollout(db, env.resolver, { actor: "test" })).rejects.toThrow(/rollout_paused is on/);
    await settingsService(db).set("rollout_paused", false, "test");
    await startRollout(db, env.resolver, { actor: "test" });
    await expect(startRollout(db, env.resolver, { actor: "test" })).rejects.toThrow(/still running/);
    await cancelRollout(db, "test");
  });

  it("goes canary → 10% oldest-first → batches of 5, skips held boxes, pauses on the first failure, and resumes", async () => {
    const env = setup();
    // Seven customers (oldest first a1..a7), a canary (newest), a demo box and a held customer.
    const customers = [];
    for (let i = 0; i < 7; i++) customers.push(await activeBox(env, { ageDays: 30 - i }));
    const canary = await activeBox(env, { purpose: "canary" });
    const demo = await activeBox(env, { purpose: "demo", ageDays: 60 });
    const held = await activeBox(env, { ageDays: 90 });
    await db.update(boxes).set({ holdUpgrades: true }).where(eq(boxes.id, held.id));
    const ours = new Set([...customers, canary, demo, held].map((b) => b.slug));
    const slugs = customers.map((b) => b.slug);

    const started = await startRollout(db, env.resolver, { actor: "test", now: true });
    const waves = (started.waves as Array<{ wave: number; slugs: string[] }>).map((w) => ({ wave: w.wave, slugs: w.slugs.filter((s) => ours.has(s)) }));
    expect(waves).toEqual([
      { wave: 0, slugs: [canary.slug] },
      { wave: 1, slugs: [slugs[0]] },
      { wave: 2, slugs: slugs.slice(1, 6) },
      { wave: 3, slugs: [slugs[6]] },
    ]);
    const skipped = (started.skipped as Array<{ slug: string; reason: string }>).filter((s) => ours.has(s.slug));
    expect(skipped.map((s) => s.slug).sort()).toEqual([demo.slug, held.slug].sort());
    expect(skipped.every((s) => s.reason === "hold_upgrades is set")).toBe(true);

    // Wave 0, then wave 1: one wave in flight at a time.
    expect(await tickRollout(db)).toMatchObject({ action: "started_wave", wave: 0, queued: [canary.slug] });
    expect(await tickRollout(db)).toMatchObject({ action: "waiting", wave: 1, inFlight: 1 });
    await drain(env.runner);
    expect((await boxRow(canary.id)).releaseTag).toBe(NEW);
    expect(await tickRollout(db)).toMatchObject({ action: "started_wave", wave: 1, queued: [slugs[0]] });
    await drain(env.runner);

    // Wave 2: the second box's deployment fails. It rolls back, the box is held,
    // the rollout pauses, ops is paged, and the rest of the wave waits.
    expect(await tickRollout(db)).toMatchObject({ action: "started_wave", wave: 2, queued: slugs.slice(1, 6) });
    env.fake.nextOutcomes.push("SUCCESS", "FAILED");
    await drain(env.runner);
    const failed = customers[2]!;
    expect((await upgradeOf(failed.id)).state).toBe("rolled_back");
    expect(await boxRow(failed.id)).toMatchObject({ holdUpgrades: true, releaseTag: OLD });
    expect(await settingsService(db).get("rollout_paused")).toBe(true);
    expect(alerts.map((a) => a.subject)).toEqual([expect.stringMatching(new RegExp(`^upgrade of ${failed.slug} .* box held, rollout paused$`))]);
    expect((await upgradeOf(customers[1]!.id)).state).toBe("succeeded");
    for (const b of customers.slice(3, 6)) expect((await upgradeOf(b.id)).state).toBe("planned");
    expect(await tickRollout(db)).toMatchObject({ action: "paused" });
    expect(await drain(env.runner)).toBe(0);
    const status = (await rolloutStatus(db)) as { rolloutPaused: boolean; rollout: { pausedReason: string; counts: Record<string, number> } };
    expect(status.rolloutPaused).toBe(true);
    expect(status.rollout.pausedReason).toMatch(new RegExp(`^${failed.slug}: deployment .* ended FAILED`));

    // Resume: the failed box stays held; the rest of wave 2, then wave 3, then done.
    expect(await resumeRollout(db, "test", { now: true })).toMatchObject({ rolloutPaused: false, stillHeld: [failed.slug] });
    expect(await tickRollout(db)).toMatchObject({ action: "started_wave", wave: 2, queued: slugs.slice(3, 6) });
    await drain(env.runner);
    expect(await tickRollout(db)).toMatchObject({ action: "started_wave", wave: 3, queued: [slugs[6]] });
    await drain(env.runner);
    expect(await tickRollout(db)).toMatchObject({ action: "completed" });
    expect(await tickRollout(db)).toEqual({ action: "idle" });

    for (const b of [canary, ...customers.filter((c) => c.id !== failed.id)]) expect((await boxRow(b.id)).releaseTag).toBe(NEW);
    for (const b of [demo, held, failed]) expect((await boxRow(b.id)).releaseTag).toBe(OLD);
    // Order: every box of a wave started after every box of the wave before it finished.
    const rows = await db
      .select({ boxId: boxUpgrades.boxId, wave: boxUpgrades.wave, startedAt: boxUpgrades.startedAt, finishedAt: boxUpgrades.finishedAt })
      .from(boxUpgrades)
      .where(and(inArray(boxUpgrades.boxId, [canary, ...customers].map((b) => b.id)), eq(boxUpgrades.rolloutId, String(started.rolloutId))));
    for (const a of rows) for (const b of rows) if (a.wave < b.wave) expect(a.finishedAt!.getTime()).toBeLessThanOrEqual(b.startedAt!.getTime());
  });

  it("starts waves only inside the nightly window, unless started with now", async () => {
    const env = setup();
    const box = await activeBox(env);
    await settingsService(db).set("upgrade_window", "02:00-05:00", "test");
    await startRollout(db, env.resolver, { actor: "test" });
    const noonPdt = new Date("2026-10-01T19:00:00Z");
    expect(await tickRollout(db, { now: noonPdt })).toMatchObject({ action: "outside_window", opensAt: "2026-10-02T09:00:00.000Z" });
    expect(await tickRollout(db, { now: new Date("2026-10-02T09:30:00Z") })).toMatchObject({ action: "started_wave", wave: 1, queued: [box.slug] });
    await cancelRollout(db, "test");
    await db.execute(sql`update jobs set state = 'dead' where state = 'queued'`);
    await db.update(boxUpgrades).set({ state: "failed" }).where(eq(boxUpgrades.boxId, box.id));

    await startRollout(db, env.resolver, { actor: "test", now: true });
    expect(await tickRollout(db, { now: noonPdt })).toMatchObject({ action: "started_wave" });
  });

  it("is resumable from the database: a box held after planning is skipped, and a job that gave up pauses the rollout", async () => {
    const env = setup();
    const a = await activeBox(env, { ageDays: 2 });
    const b = await activeBox(env, { ageDays: 1 });
    const started = await startRollout(db, env.resolver, { actor: "test", now: true });
    await db.update(boxes).set({ holdUpgrades: true }).where(eq(boxes.id, a.id));
    // A brand-new orchestrator (nothing in memory) picks the plan up from the rows.
    expect(await tickRollout(db)).toMatchObject({ action: "started_wave", wave: 1, queued: [], skipped: [a.slug] });
    expect(await tickRollout(db)).toMatchObject({ action: "started_wave", wave: 2, queued: [b.slug] });
    // Its job dies without settling the upgrade (a crash in the give-up path).
    const up = await upgradeOf(b.id);
    await db.update(jobs).set({ state: "dead", lastError: "boom" }).where(eq(jobs.id, up.jobId!));
    expect(await tickRollout(db)).toMatchObject({ action: "paused", rolloutId: started.rolloutId });
    expect((await upgradeOf(b.id)).state).toBe("failed");
    expect((await boxRow(b.id)).holdUpgrades).toBe(true);
    expect(await settingsService(db).get("rollout_paused")).toBe(true);
    const [r] = await db.select().from(rollouts).where(eq(rollouts.id, String(started.rolloutId)));
    expect(r!.pausedReason).toMatch(/ended dead without settling: boom/);
    // Started with "now", but a plain resume sends the rest back to the nightly window.
    expect(r!.ignoreWindow).toBe(true);
    await resumeRollout(db, "test");
    const [after] = await db.select().from(rollouts).where(eq(rollouts.id, String(started.rolloutId)));
    expect(after).toMatchObject({ ignoreWindow: false, pausedReason: null });
  });
});

// ---- The operator surface (GH #861) ----------------------------------------

describe("operator routes for purpose, hold, upgrade and rollout", () => {
  it("creates demo boxes held, lists by purpose, sets purpose and hold, and reports rollout status", async () => {
    const env = setup();
    const app = express();
    app.use(express.json());
    // What requireAdmin records for an allow-listed caller.
    app.use((_req, res, next) => {
      res.locals.adminIp = "10.0.0.9";
      next();
    });
    app.use("/internal", internalRoutes(db, log, { fleet: env.resolver }));
    const slug = `demo-${randomUUID().slice(0, 6)}`;
    const created = await request(app).post("/internal/boxes").send({ slug, email: `${slug}@example.test`, purpose: "demo" });
    expect(created.status).toBe(201);
    expect(await request(app).post("/internal/boxes").send({ slug: "zz-bad", email: "x@example.test", purpose: "staging" })).toHaveProperty("status", 400);
    const demos = await request(app).get("/internal/boxes?purpose=demo");
    expect(demos.body.boxes.find((b: { slug: string }) => b.slug === slug)).toMatchObject({ purpose: "demo", holdUpgrades: true });
    expect((await request(app).get("/internal/boxes?purpose=staging")).status).toBe(400);
    expect((await request(app).post(`/internal/boxes/${slug}/purpose`).send({ purpose: "canary" })).body).toMatchObject({ purpose: "canary", previous: "demo" });
    expect((await request(app).post(`/internal/boxes/${slug}/unhold`)).body).toEqual({ holdUpgrades: false });
    expect((await request(app).post(`/internal/boxes/${slug}/hold`)).body).toEqual({ holdUpgrades: true });
    const [held] = await db.select().from(boxEvents).where(and(eq(boxEvents.kind, "upgrades_held"), eq(boxEvents.actor, "admin-cli@10.0.0.9")));
    expect(held).toBeTruthy();
    expect((await request(app).post(`/internal/boxes/no-such-box/hold`)).status).toBe(404);
    // The box is still provisioning, so it cannot be upgraded.
    expect((await request(app).post(`/internal/boxes/${slug}/upgrade`).send({ now: true })).status).toBe(409);
    const status = await request(app).get("/internal/rollout");
    expect(status.body).toMatchObject({ targetRelease: NEW, rolloutPaused: false, window: { window: "02:00-05:00", tz: "America/Los_Angeles" } });
    expect((await request(app).post("/internal/rollout/pause").send({ reason: "investigating" })).body).toEqual({ rolloutPaused: true, reason: "investigating" });
    expect((await request(app).post("/internal/rollout/cancel")).status).toBe(404);
  });
});
