// SC-3 (GH #764): the job queue and the box state machine, against embedded
// Postgres and a fake Railway API.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCloudDb, migrateCloudDb, type CloudDb } from "../db/client.js";
import { accounts, boxEvents, boxes, jobs, settings, waitlist, type BoxState } from "../db/schema.js";
import type { Alert, Alerter } from "../jobs/alerts.js";
import { deleteHandler, sweepCleanup } from "../jobs/cleanup.js";
import { FatalJobError } from "../jobs/errors.js";
import { abandonBox, BoxOpError, retryBox } from "../jobs/ops.js";
import { enqueueJob, requestProvision } from "../jobs/queue.js";
import { type JobHandler, JobRunner } from "../jobs/runner.js";
import { createLogger } from "../logger.js";
import { RailwayApiError } from "../railway/client.js";
import { projectTag } from "../railway/names.js";
import { settingsService } from "../settings.js";
import { startTestDatabase, type TestDatabase } from "./embedded-pg.js";
import { FAKE_WORKSPACE, FakeRailway } from "./fake-railway.js";

let pg: TestDatabase;
let db: CloudDb;
let close: () => Promise<void>;
const logLines: string[] = [];
const log = createLogger({ write: (l) => logLines.push(l), level: "debug" });
const alerts: Alert[] = [];
const alerter: Alerter = { send: async (a) => void alerts.push(a) };
let seq = 0;

beforeAll(async () => {
  pg = await startTestDatabase();
  await migrateCloudDb(pg.url);
  ({ db, close } = createCloudDb(pg.url));
});

afterAll(async () => {
  await close?.();
  await pg?.stop();
});

beforeEach(async () => {
  alerts.length = 0;
  await db.execute(sql`truncate settings`);
  // Jobs from earlier tests must not be claimable by this test's runners.
  await db.execute(sql`update jobs set state = 'dead' where state in ('queued', 'running', 'failed')`);
});

async function setSetting(key: Parameters<ReturnType<typeof settingsService>["set"]>[0], value: unknown) {
  await settingsService(db).set(key, value, "test");
}

/** A box walked to `state` through legal transitions. */
async function makeBox(state: BoxState = "requested", extra: Partial<typeof boxes.$inferInsert> = {}) {
  const n = ++seq;
  const [acct] = await db.insert(accounts).values({ email: `user${n}-${Date.now()}@example.test` }).returning();
  const [box] = await db.insert(boxes).values({ accountId: acct!.id, slug: `box${n}x${Date.now() % 100000}` }).returning();
  const path: Record<BoxState, BoxState[]> = {
    requested: [],
    waitlisted: ["waitlisted"],
    provisioning: ["provisioning"],
    awaiting_claim: ["provisioning", "awaiting_claim"],
    failed: ["provisioning", "failed"],
    cleanup: ["provisioning", "awaiting_claim", "cleanup"],
    active: ["provisioning", "awaiting_claim", "active"],
    suspended: ["provisioning", "awaiting_claim", "active", "suspended"],
    pending_delete: ["provisioning", "awaiting_claim", "active", "pending_delete"],
    deleted: ["deleted"],
  };
  for (const s of path[state]) await db.update(boxes).set({ state: s }).where(eq(boxes.id, box!.id));
  if (Object.keys(extra).length) await db.update(boxes).set(extra).where(eq(boxes.id, box!.id));
  const [fresh] = await db.select().from(boxes).where(eq(boxes.id, box!.id));
  return fresh!;
}

async function jobRow(id: string) {
  const [j] = await db.select().from(jobs).where(eq(jobs.id, id));
  return j!;
}

async function boxRow(id: string) {
  const [b] = await db.select().from(boxes).where(eq(boxes.id, id));
  return b!;
}

/** Seconds from the database's now() until the job's run_after. */
async function delaySeconds(id: string): Promise<number> {
  const rows = (await db.execute(sql`select extract(epoch from (run_after - now()))::float as s from jobs where id = ${id}`)) as unknown as Array<{ s: number }>;
  return rows[0]!.s;
}

async function makeRunnable(id: string) {
  await db.update(jobs).set({ runAfter: new Date(Date.now() - 1000) }).where(eq(jobs.id, id));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function recordingHandler(kind: "provision" | "delete", calls: string[], overrides: Partial<Record<string, () => Promise<void>>> = {}): JobHandler {
  return {
    kind,
    maxDurationMs: 30 * 60_000,
    steps: ["reserve", "project", "deploy"].map((name) => ({
      name,
      timeoutMs: 5_000,
      async run() {
        calls.push(name);
        await overrides[name]?.();
      },
    })),
    async onGiveUp(ctx, outcome) {
      const box = await ctx.box();
      if (box.state === "provisioning") await ctx.db.update(boxes).set({ state: "failed" }).where(eq(boxes.id, box.id));
      calls.push(`gaveUp:${outcome}`);
    },
  };
}

async function queuedProvision(boxState: BoxState = "provisioning") {
  const box = await makeBox(boxState);
  const { id } = await enqueueJob(db, { boxId: box.id, kind: "provision" });
  return { box, jobId: id };
}

describe("enqueue: kill switch, waitlist mode and daily cap", () => {
  it("the kill switch (off by default) routes a request to the waitlist", async () => {
    const box = await makeBox("requested");
    const r = await requestProvision(db, box.id, { actor: "test" });
    expect(r).toEqual({ outcome: "waitlisted", reason: "kill_switch" });
    expect((await boxRow(box.id)).state).toBe("waitlisted");
    const w = await db.select().from(waitlist).where(eq(waitlist.accountId, box.accountId));
    expect(w).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.boxId, box.id))).toHaveLength(0);
  });

  it("waitlist mode holds a request until an operator approves it", async () => {
    await setSetting("provisioning_enabled", true);
    const box = await makeBox("requested");
    expect(await requestProvision(db, box.id, { actor: "test" })).toEqual({ outcome: "waitlisted", reason: "waitlist_mode" });
    const approved = await requestProvision(db, box.id, { actor: "op", approved: true });
    expect(approved.outcome).toBe("queued");
    expect((await boxRow(box.id)).state).toBe("provisioning");
  });

  it("the daily cap sends overflow to the waitlist, even for approved requests", async () => {
    await setSetting("provisioning_enabled", true);
    await setSetting("waitlist_mode", false);
    const already = Number(((await db.execute(sql`select count(*)::int as n from jobs where kind = 'provision' and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`)) as unknown as Array<{ n: number }>)[0]!.n);
    await setSetting("daily_cap", already + 1);
    const a = await makeBox("requested");
    const b = await makeBox("requested");
    expect((await requestProvision(db, a.id, { actor: "test" })).outcome).toBe("queued");
    expect(await requestProvision(db, b.id, { actor: "op", approved: true })).toEqual({ outcome: "waitlisted", reason: "daily_cap" });
  });

  it("two concurrent requests cannot both take the last slot under the cap", async () => {
    await setSetting("provisioning_enabled", true);
    await setSetting("waitlist_mode", false);
    const already = Number(((await db.execute(sql`select count(*)::int as n from jobs where kind = 'provision' and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`)) as unknown as Array<{ n: number }>)[0]!.n);
    await setSetting("daily_cap", already + 1);
    const boxesList = await Promise.all([makeBox("requested"), makeBox("requested"), makeBox("requested")]);
    const results = await Promise.all(boxesList.map((b) => requestProvision(db, b.id, { actor: "test" })));
    expect(results.filter((r) => r.outcome === "queued")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "waitlisted")).toHaveLength(2);
  });

  it("keeps one live job per box and kind", async () => {
    const box = await makeBox("provisioning");
    const first = await enqueueJob(db, { boxId: box.id, kind: "provision" });
    const second = await enqueueJob(db, { boxId: box.id, kind: "provision" });
    expect(second).toEqual({ id: first.id, created: false });
  });
});

describe("runner", () => {
  beforeEach(async () => {
    await setSetting("provisioning_enabled", true);
  });

  it("runs the steps in order and marks the job succeeded", async () => {
    const calls: string[] = [];
    const { jobId } = await queuedProvision();
    const runner = new JobRunner({ db, log, alerter, handlers: [recordingHandler("provision", calls)] });
    expect(await runner.runOnce()).toBe(jobId);
    expect(calls).toEqual(["reserve", "project", "deploy"]);
    const j = await jobRow(jobId);
    expect(j).toMatchObject({ state: "succeeded", step: "deploy", attempt: 1, lockedBy: null });
    expect(j.finishedAt).not.toBeNull();
  });

  it("a job killed mid-step resumes AT THAT STEP in another worker, and the dead worker cannot clobber it", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    let first = true;
    const { jobId } = await queuedProvision();
    // Worker A: short lease, no heartbeat in time; its "project" step hangs (a crash, as far as the queue can tell).
    const a = new JobRunner({
      db, log, alerter, workerId: "worker-a", leaseMs: 400, heartbeatMs: 60_000,
      handlers: [recordingHandler("provision", calls, { project: async () => { if (first) { first = false; await hang; } } })],
    });
    const aDone = a.runOnce();
    for (let i = 0; i < 50 && (await jobRow(jobId)).step !== "project"; i++) await sleep(20);
    expect((await jobRow(jobId)).step).toBe("project");
    await sleep(500); // the lease expires
    const b = new JobRunner({ db, log, alerter, workerId: "worker-b", handlers: [recordingHandler("provision", calls)] });
    expect(await b.runOnce()).toBe(jobId);
    // B started at "project", not at "reserve".
    expect(calls).toEqual(["reserve", "project", "project", "deploy"]);
    expect(await jobRow(jobId)).toMatchObject({ state: "succeeded", attempt: 2 });
    // A wakes up: its next write is refused (lease lost), so the job stays succeeded and "deploy" is not re-run by A.
    release();
    await aDone;
    expect(calls.filter((c) => c === "deploy")).toHaveLength(1);
    expect((await jobRow(jobId)).state).toBe("succeeded");
  });

  it("two workers with SKIP LOCKED run every job exactly once and respect max_concurrent_jobs", async () => {
    await setSetting("max_concurrent_jobs", 2);
    const ids = await Promise.all(Array.from({ length: 6 }, () => queuedProvision().then((q) => q.jobId)));
    const runs = new Map<string, number>();
    let inFlight = 0;
    let peak = 0;
    const handler: JobHandler = {
      kind: "provision",
      steps: [{ name: "only", timeoutMs: 5_000, async run(ctx) {
        inFlight += 1; peak = Math.max(peak, inFlight);
        runs.set(ctx.job.id, (runs.get(ctx.job.id) ?? 0) + 1);
        await sleep(60);
        inFlight -= 1;
      } }],
    };
    const w1 = new JobRunner({ db, log, handlers: [handler], workerId: "w1" });
    const w2 = new JobRunner({ db, log, handlers: [handler], workerId: "w2" });
    const drain = async (w: JobRunner) => { for (let i = 0; i < 20; i++) { const r = await Promise.all([w.runOnce(), w.runOnce()]); if (r.every((x) => x === null)) { if (ids.every((id) => runs.has(id))) break; await sleep(20); } } };
    await Promise.all([drain(w1), drain(w2)]);
    for (const id of ids) expect(runs.get(id), id).toBe(1);
    expect(peak).toBeLessThanOrEqual(2);
    for (const id of ids) expect((await jobRow(id)).state).toBe("succeeded");
  });

  it("retries at 15 s, 1 min, 4 min, 10 min, then fails the box and alerts ops with the redacted error", async () => {
    const calls: string[] = [];
    const { box, jobId } = await queuedProvision();
    const runner = new JobRunner({ db, log, alerter, handlers: [recordingHandler("provision", calls, { project: async () => { throw new Error("railway said no to claim AGD-0123456789ABCDEF0123456789 token=abc123secret"); } })] });
    const expected = [15, 60, 240, 600];
    for (let attempt = 1; attempt <= 4; attempt++) {
      await makeRunnable(jobId);
      expect(await runner.runOnce()).toBe(jobId);
      const j = await jobRow(jobId);
      expect(j).toMatchObject({ state: "queued", attempt, step: "project" });
      expect(Math.abs((await delaySeconds(jobId)) - expected[attempt - 1]!)).toBeLessThan(5);
      expect(j.lastError).toContain("railway said no");
      expect(j.lastError).not.toContain("0123456789ABCDEF");
      expect(j.lastError).not.toContain("abc123secret");
    }
    await makeRunnable(jobId);
    await runner.runOnce();
    expect(await jobRow(jobId)).toMatchObject({ state: "failed", attempt: 5 });
    expect((await boxRow(box.id)).state).toBe("failed");
    expect(calls).toContain("gaveUp:failed");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "job_failed", jobId, step: "project", slug: box.slug });
    expect(JSON.stringify(alerts[0])).not.toContain("0123456789ABCDEF");
    const events = await db.select().from(boxEvents).where(eq(boxEvents.boxId, box.id));
    expect(events.map((e) => e.kind)).toContain("job_failed");
    // Steps before the failing one ran once per attempt only up to where it failed; resumed attempts start at "project".
    expect(calls.filter((c) => c === "reserve")).toHaveLength(1);
  });

  it("a Railway 429 backs off by Retry-After and does not use up an attempt", async () => {
    const { jobId } = await queuedProvision();
    const runner = new JobRunner({ db, log, alerter, handlers: [recordingHandler("provision", [], { reserve: async () => { throw new RailwayApiError({ operation: "projectCreate", status: 429, messages: ["Too many requests"], retryAfterMs: 42_000 }); } })] });
    await runner.runOnce();
    const j = await jobRow(jobId);
    expect(j).toMatchObject({ state: "queued", attempt: 0 });
    expect(Math.abs((await delaySeconds(jobId)) - 42)).toBeLessThan(5);
    expect(j.lastError).toContain("Too many requests");
  });

  it("a step that runs past its timeout is aborted and retried", async () => {
    const { jobId } = await queuedProvision();
    let sawAbort = false;
    const handler: JobHandler = {
      kind: "provision",
      steps: [{ name: "slow", timeoutMs: 100, run: (ctx) => new Promise<void>((resolve) => { ctx.signal.addEventListener("abort", () => { sawAbort = true; resolve(); }); }) }],
    };
    await new JobRunner({ db, log, alerter, handlers: [handler] }).runOnce();
    expect(sawAbort).toBe(true);
    const j = await jobRow(jobId);
    expect(j.state).toBe("queued");
    expect(j.lastError).toMatch(/timed out/);
  });

  it("a provision job past its 30-minute cap fails without another retry", async () => {
    const calls: string[] = [];
    const { box, jobId } = await queuedProvision();
    await db.update(jobs).set({ startedAt: new Date(Date.now() - 31 * 60_000), attempt: 2 }).where(eq(jobs.id, jobId));
    await new JobRunner({ db, log, alerter, handlers: [recordingHandler("provision", calls)] }).runOnce();
    const j = await jobRow(jobId);
    expect(j.state).toBe("failed");
    expect(j.lastError).toMatch(/30-minute cap/);
    expect(calls).toEqual(["gaveUp:failed"]);
    expect((await boxRow(box.id)).state).toBe("failed");
  });

  it("a safety refusal (FatalJobError) goes straight to dead and pages ops", async () => {
    const { jobId } = await queuedProvision();
    await new JobRunner({ db, log, alerter, handlers: [recordingHandler("provision", [], { project: async () => { throw new FatalJobError("deployed box is missing BETTER_AUTH_SECRET; refusing to generate a new one"); } })] }).runOnce();
    expect(await jobRow(jobId)).toMatchObject({ state: "dead", attempt: 1 });
    expect(alerts[0]).toMatchObject({ kind: "job_dead" });
  });

  it("while the kill switch is off no provision job is claimed; other kinds still run", async () => {
    await setSetting("provisioning_enabled", false);
    const { jobId: provisionId } = await queuedProvision();
    const cleanupBox = await makeBox("cleanup");
    const { id: deleteId } = await enqueueJob(db, { boxId: cleanupBox.id, kind: "delete" });
    const runner = new JobRunner({ db, log, handlers: [recordingHandler("provision", []), recordingHandler("delete", [])] });
    expect(await runner.runOnce()).toBe(deleteId);
    expect(await runner.runOnce()).toBeNull();
    expect((await jobRow(provisionId)).state).toBe("queued");
  });

  it("stop() hands an in-flight job back at once without using an attempt", async () => {
    const { jobId } = await queuedProvision();
    const handler: JobHandler = { kind: "provision", steps: [{ name: "wait", timeoutMs: 10_000, run: (ctx) => new Promise<void>((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason))) }] };
    const runner = new JobRunner({ db, log, handlers: [handler], pollMs: 20 });
    runner.start();
    for (let i = 0; i < 100 && (await jobRow(jobId)).state !== "running"; i++) await sleep(20);
    await runner.stop();
    const j = await jobRow(jobId);
    expect(j).toMatchObject({ state: "running", attempt: 0, step: "wait" });
    const other = new JobRunner({ db, log, handlers: [recordingHandler("provision", [])] });
    expect(await other.runOnce()).toBe(jobId); // claimable immediately
  });
});

describe("operator retry and abandon", () => {
  beforeEach(async () => {
    await setSetting("provisioning_enabled", true);
  });

  async function failedAt(step: string) {
    const calls: string[] = [];
    const { box, jobId } = await queuedProvision();
    const runner = new JobRunner({ db, log, alerter, handlers: [recordingHandler("provision", calls, { [step]: async () => { throw new Error("nope"); } })] });
    for (let i = 0; i < 5; i++) {
      await makeRunnable(jobId);
      await runner.runOnce();
    }
    expect((await jobRow(jobId)).state).toBe("failed");
    return { box: await boxRow(box.id), jobId };
  }

  it("retry resumes at the failed step with fresh attempts", async () => {
    const { box, jobId } = await failedAt("deploy");
    const r = await retryBox(db, box.slug, "op");
    expect(r).toEqual({ jobId, step: "deploy" });
    expect(await jobRow(jobId)).toMatchObject({ state: "queued", attempt: 0, startedAt: null });
    expect((await boxRow(box.id)).state).toBe("provisioning");
    const calls: string[] = [];
    await new JobRunner({ db, log, handlers: [recordingHandler("provision", calls)] }).runOnce();
    expect(calls).toEqual(["deploy"]);
    expect((await jobRow(jobId)).state).toBe("succeeded");
  });

  it("retry refuses a dead job and a box that is not failed", async () => {
    const { box, jobId } = await failedAt("project");
    await db.update(jobs).set({ state: "dead" }).where(eq(jobs.id, jobId));
    await expect(retryBox(db, box.slug, "op")).rejects.toThrow(/dead/);
    const ok = await makeBox("awaiting_claim");
    await expect(retryBox(db, ok.slug, "op")).rejects.toBeInstanceOf(BoxOpError);
  });

  it("abandon sends a failed box to cleanup with a delete job, and refuses a claimed box", async () => {
    const { box, jobId } = await failedAt("project");
    const r = await abandonBox(db, box.slug, "op");
    expect((await boxRow(box.id)).state).toBe("cleanup");
    expect((await jobRow(jobId)).state).toBe("dead");
    expect((await jobRow(r.deleteJobId)).kind).toBe("delete");
    const claimed = await failedAt("project");
    await db.update(boxes).set({ claimedAt: new Date() }).where(eq(boxes.id, claimed.box.id));
    await expect(abandonBox(db, claimed.box.slug, "op")).rejects.toThrow(/claimed/);
  });
});

describe("cleanup and the guarded delete", () => {
  async function cleanupJob(opts: { projectId?: string | null; claimedAt?: Date | null } = {}) {
    const box = await makeBox("cleanup", { projectId: opts.projectId ?? null, claimedAt: opts.claimedAt ?? null });
    const { id } = await enqueueJob(db, { boxId: box.id, kind: "delete" });
    return { box, jobId: id };
  }

  function runnerFor(fake: FakeRailway) {
    return new JobRunner({ db, log, alerter, handlers: [deleteHandler({ client: fake.client({ log }), workspaceId: FAKE_WORKSPACE })] });
  }

  it("deletes an unclaimed box's tagged project and marks the box deleted", async () => {
    const fake = new FakeRailway();
    const { box, jobId } = await cleanupJob();
    const p = fake.addProject({ name: `agentdash-box-${box.slug}`, description: `managed ${projectTag(box.id)}` });
    await db.update(boxes).set({ projectId: p.id }).where(eq(boxes.id, box.id));
    await runnerFor(fake).runOnce();
    expect((await jobRow(jobId)).state).toBe("succeeded");
    expect(fake.ops()).toContain("projectDelete");
    expect(fake.projects.has(p.id)).toBe(false);
    expect((await boxRow(box.id)).state).toBe("deleted");
  });

  it("refuses a claimed box", async () => {
    const fake = new FakeRailway();
    const { box, jobId } = await cleanupJob({ claimedAt: new Date() });
    fake.addProject({ name: `agentdash-box-${box.slug}`, description: projectTag(box.id) });
    await runnerFor(fake).runOnce();
    expect((await jobRow(jobId)).state).toBe("dead");
    expect((await jobRow(jobId)).lastError).toMatch(/claimed/);
    expect(fake.ops()).not.toContain("projectDelete");
    expect((await boxRow(box.id)).state).toBe("cleanup");
    expect(alerts[0]?.kind).toBe("job_dead");
  });

  it("refuses a project name mismatch (the row's project is not agentdash-box-<slug>)", async () => {
    const fake = new FakeRailway();
    const protectedProject = fake.addProject({ name: "agentdash", description: "the founder's app" });
    const { box, jobId } = await cleanupJob({ projectId: protectedProject.id });
    await runnerFor(fake).runOnce();
    expect((await jobRow(jobId)).lastError).toMatch(/name mismatch/);
    expect(fake.ops()).not.toContain("projectDelete");
    expect(fake.projects.has(protectedProject.id)).toBe(true);
    expect((await boxRow(box.id)).state).toBe("cleanup");
  });

  it("refuses a project ID mismatch", async () => {
    const fake = new FakeRailway();
    const { box, jobId } = await cleanupJob({ projectId: "proj-recorded" });
    fake.addProject({ id: "proj-other", name: `agentdash-box-${box.slug}`, description: projectTag(box.id) });
    await runnerFor(fake).runOnce();
    expect((await jobRow(jobId)).lastError).toMatch(/ID mismatch/);
    expect(fake.ops()).not.toContain("projectDelete");
  });

  it("refuses a project without this box's control-plane tag", async () => {
    const fake = new FakeRailway();
    const { box, jobId } = await cleanupJob();
    fake.addProject({ name: `agentdash-box-${box.slug}`, description: "made by hand" });
    await runnerFor(fake).runOnce();
    expect((await jobRow(jobId)).lastError).toMatch(/tag/);
    expect(fake.ops()).not.toContain("projectDelete");
  });

  it("a box whose project never existed is simply marked deleted", async () => {
    const fake = new FakeRailway();
    const { box, jobId } = await cleanupJob();
    await runnerFor(fake).runOnce();
    expect((await jobRow(jobId)).state).toBe("succeeded");
    expect((await boxRow(box.id)).state).toBe("deleted");
  });

  it("the sweep moves boxes unclaimed for 7 days to cleanup and queues their delete", async () => {
    const stale = await makeBox("awaiting_claim", { claimExpiresAt: new Date(Date.now() - 60_000) });
    const fresh = await makeBox("awaiting_claim", { claimExpiresAt: new Date(Date.now() + 86_400_000) });
    const claimed = await makeBox("awaiting_claim", { claimExpiresAt: new Date(Date.now() - 60_000), claimedAt: new Date() });
    const r = await sweepCleanup(db, log);
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect((await boxRow(stale.id)).state).toBe("cleanup");
    expect((await boxRow(fresh.id)).state).toBe("awaiting_claim");
    expect((await boxRow(claimed.id)).state).toBe("awaiting_claim");
    const del = await db.select().from(jobs).where(eq(jobs.boxId, stale.id));
    expect(del.map((j) => j.kind)).toEqual(["delete"]);
    // Idempotent: a second sweep adds nothing for that box.
    await sweepCleanup(db, log);
    expect(await db.select().from(jobs).where(eq(jobs.boxId, stale.id))).toHaveLength(1);
  });
});

describe("secrets never reach the job table or the logs", () => {
  it("last_error and log lines are redacted", async () => {
    await setSetting("provisioning_enabled", true);
    const { jobId } = await queuedProvision();
    logLines.length = 0;
    await new JobRunner({ db, log, alerter, handlers: [recordingHandler("provision", [], { reserve: async () => { throw new Error("upsert failed: whsec_fakewebhooksecret1 and Bearer abcdef.123"); } })] }).runOnce();
    const j = await jobRow(jobId);
    expect(j.lastError).not.toContain("fakewebhooksecret1");
    expect(j.lastError).not.toContain("abcdef.123");
    expect(logLines.join("\n")).not.toContain("fakewebhooksecret1");
    void settings;
  });
});
