// SC-3 (GH #764): the job queue and the box state machine, against embedded
// Postgres and a fake Railway API.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

// The capabilities module is frozen in production; this suite swaps in a mutable stand-in.
const caps = vi.hoisted(() => ({ claimTrackingReady: true }));
vi.mock("../capabilities.js", () => ({ capabilities: caps }));

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

/** A fetch that answers every box's /api/health with `body`. */
function health(body: Record<string, unknown>): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
}

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

  it("promotes a preexisting waiting row when an approved request is still deferred", async () => {
    const box = await makeBox("requested");
    await requestProvision(db, box.id, { actor: "test" });
    const [entry] = await db.select().from(waitlist).where(eq(waitlist.accountId, box.accountId));
    expect(entry!.state).toBe("waiting");
    expect(await requestProvision(db, box.id, { actor: "op", approved: true })).toEqual({ outcome: "waitlisted", reason: "kill_switch" });
    const [approved] = await db.select().from(waitlist).where(eq(waitlist.id, entry!.id));
    expect(approved).toMatchObject({ state: "approved", approvedBy: "op" });
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

  it("aborts the job itself once its lease lapses locally because renewals keep failing (fake clock, GH #799)", async () => {
    const { jobId } = await queuedProvision();
    // The runner gets its own connection, which we cut mid-step so every heartbeat write fails.
    const own = createCloudDb(pg.url, { max: 2 });
    let now = 1_000_000;
    let reason: unknown = null;
    const handler: JobHandler = {
      kind: "provision",
      steps: [{ name: "create_project", timeoutMs: 60_000, run: (ctx) => new Promise<void>((resolve) => {
        ctx.signal.addEventListener("abort", () => { reason = ctx.signal.reason; resolve(); });
      }) }],
    };
    const runner = new JobRunner({ db: own.db, log, handlers: [handler], leaseMs: 60_000, heartbeatMs: 20, clock: () => now });
    const done = runner.runOnce();
    for (let i = 0; i < 100 && (await jobRow(jobId)).step !== "create_project"; i++) await sleep(20);
    // Renewals succeed while the connection is up: the clock can pass one lease without an abort.
    now += 45_000;
    await sleep(80);
    now += 45_000;
    await sleep(80);
    expect(reason).toBeNull();
    await own.close();
    now += 61_000;
    await done;
    expect((reason as Error | null)?.name).toBe("LeaseLostError");
    // The job is left for another worker: still running, reclaimable once the DB lease expires.
    expect((await jobRow(jobId)).state).toBe("running");
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

  it("the sweep moves boxes past their claim window to cleanup only on positive evidence they are unclaimed", async () => {
    const stale = await makeBox("awaiting_claim", { claimExpiresAt: new Date(Date.now() - 60_000), upstreamHost: "stale.up.railway.app" });
    const fresh = await makeBox("awaiting_claim", { claimExpiresAt: new Date(Date.now() + 86_400_000), upstreamHost: "fresh.up.railway.app" });
    const claimed = await makeBox("awaiting_claim", { claimExpiresAt: new Date(Date.now() - 60_000), claimedAt: new Date(), upstreamHost: "claimed.up.railway.app" });
    const r = await sweepCleanup(db, log, { fetch: health({ status: "ok", claimed: false, bootstrapStatus: "bootstrap_pending" }) });
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect((await boxRow(stale.id)).state).toBe("cleanup");
    expect((await boxRow(fresh.id)).state).toBe("awaiting_claim");
    expect((await boxRow(claimed.id)).state).toBe("awaiting_claim");
    const del = await db.select().from(jobs).where(eq(jobs.boxId, stale.id));
    expect(del.map((j) => j.kind)).toEqual(["delete"]);
    // Idempotent: a second sweep adds nothing for that box.
    await sweepCleanup(db, log, { fetch: health({ status: "ok", claimed: false }) });
    expect(await db.select().from(jobs).where(eq(jobs.boxId, stale.id))).toHaveLength(1);
  });

  // GH #800 security review, HIGH: nothing sets claimed_at yet, so the claim window alone must never delete a box.
  it("an in-use box past its claim window is NEVER deleted when its claim state is unknown; an operator is flagged once", async () => {
    const inUse = await makeBox("awaiting_claim", { claimExpiresAt: new Date(Date.now() - 86_400_000), upstreamHost: "inuse.up.railway.app" });
    // Today's release: health has no `claimed` field, and stays bootstrap_pending after the founder signed up.
    const today = health({ status: "ok", deploymentMode: "authenticated", hostedBox: true, bootstrapStatus: "bootstrap_pending" });
    for (let i = 0; i < 3; i++) await sweepCleanup(db, log, { fetch: today, alerter });
    expect((await boxRow(inUse.id)).state).toBe("awaiting_claim");
    expect(await db.select().from(jobs).where(eq(jobs.boxId, inUse.id))).toHaveLength(0);
    const flags = (await db.select().from(boxEvents).where(eq(boxEvents.boxId, inUse.id))).filter((e) => e.kind === "cleanup_needs_operator");
    expect(flags).toHaveLength(1);
    expect(alerts.filter((a) => a.kind === "cleanup_refused" && a.slug === inUse.slug)).toHaveLength(1);
    // Unreachable is unknown too.
    await sweepCleanup(db, log, { fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    expect((await boxRow(inUse.id)).state).toBe("awaiting_claim");
  });

  it("a box whose health reports a claim becomes active and is never cleaned up", async () => {
    const box = await makeBox("awaiting_claim", { claimExpiresAt: new Date(Date.now() - 86_400_000), upstreamHost: "used.up.railway.app" });
    await sweepCleanup(db, log, { fetch: health({ status: "ok", bootstrapStatus: "ready", instanceHasCompany: true }) });
    const b = await boxRow(box.id);
    expect(b.state).toBe("active");
    expect(b.claimedAt).not.toBeNull();
    await sweepCleanup(db, log, { fetch: health({ status: "ok", claimed: false }) });
    expect((await boxRow(box.id)).state).toBe("active");
  });

  it("the delete job re-checks a handed-over box right before deleting and refuses if it is now in use", async () => {
    const fake = new FakeRailway();
    const box = await makeBox("cleanup", { upstreamHost: "late.up.railway.app" });
    await db.insert(boxEvents).values({ boxId: box.id, kind: "box_ready", actor: "test" });
    const p = fake.addProject({ name: `agentdash-box-${box.slug}`, description: projectTag(box.id) });
    await db.update(boxes).set({ projectId: p.id }).where(eq(boxes.id, box.id));
    const { id } = await enqueueJob(db, { boxId: box.id, kind: "delete" });
    const runner = new JobRunner({ db, log, alerter, handlers: [deleteHandler({ client: fake.client({ log }), workspaceId: FAKE_WORKSPACE, fetch: health({ status: "ok", bootstrapStatus: "bootstrap_pending" }) })] });
    await runner.runOnce();
    expect((await jobRow(id)).state).toBe("dead");
    expect((await jobRow(id)).lastError).toMatch(/positive evidence/);
    expect(fake.ops()).not.toContain("projectDelete");
    expect(fake.projects.has(p.id)).toBe(true);
  });

  it("refuses a project whose workspace is not reported (fail closed)", async () => {
    const fake = new FakeRailway();
    const box = await makeBox("cleanup");
    const p = fake.addProject({ name: `agentdash-box-${box.slug}`, description: projectTag(box.id) });
    (p as { workspaceId: string | null }).workspaceId = null;
    fake.projectNode = (x) => ({ ...x });
    // The workspace listing still returns it (as a Railway answer without the field would).
    fake.resolvers.push({ match: /projects\(workspaceId/, op: "projects", resolve: () => ({ projects: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [{ node: { ...p } }] } }) });
    const { id } = await enqueueJob(db, { boxId: box.id, kind: "delete" });
    await new JobRunner({ db, log, alerter, handlers: [deleteHandler({ client: fake.client({ log }), workspaceId: FAKE_WORKSPACE })] }).runOnce();
    expect((await jobRow(id)).lastError).toMatch(/not in the boxes workspace/);
    expect(fake.ops()).not.toContain("projectDelete");
  });
});

describe("the claimTrackingReady gate (GH #800)", () => {
  it("refuses to turn provisioning on, and keeps it off, until claim tracking is ready", async () => {
    caps.claimTrackingReady = false;
    try {
      await expect(settingsService(db).set("provisioning_enabled", true, "op")).rejects.toThrow(/claimTrackingReady/);
      // Even a stored true (set before the gate existed) provisions nothing.
      await db.insert(settings).values({ key: "provisioning_enabled", value: true }).onConflictDoUpdate({ target: settings.key, set: { value: true } });
      await db.insert(settings).values({ key: "waitlist_mode", value: false }).onConflictDoUpdate({ target: settings.key, set: { value: false } });
      const box = await makeBox("requested");
      expect(await requestProvision(db, box.id, { actor: "test" })).toEqual({ outcome: "waitlisted", reason: "kill_switch" });
      const { jobId } = await queuedProvision();
      expect(await new JobRunner({ db, log, handlers: [recordingHandler("provision", [])] }).runOnce()).toBeNull();
      expect((await jobRow(jobId)).state).toBe("queued");
    } finally {
      caps.claimTrackingReady = true;
    }
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
