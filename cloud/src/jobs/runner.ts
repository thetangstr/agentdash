// AgentDash: the control plane's Postgres job runner (spec §3.4, GH #764).
//
//   - Claim: one UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) takes a
//     queued job whose run_after has passed, or a running job whose lease
//     expired (its worker crashed). A transaction-scoped advisory lock makes
//     the global max_concurrent_jobs check and the claim atomic.
//   - Lease: 5 minutes in locked_until, renewed by a heartbeat. Every write a
//     worker makes is conditioned on `locked_by = me AND state = 'running'`,
//     so a worker that lost its lease can never clobber the new owner.
//   - Steps: a handler is an ordered list of idempotent steps. `jobs.step` is
//     written before each step runs, so a resumed job starts at that step.
//   - Failure: per-step timeouts; retries at 15 s, 1 min, 4 min, 10 min (5
//     attempts); Railway 429s wait for Retry-After and do not use an attempt;
//     a per-kind total cap (30 minutes for provision); FatalJobError goes
//     straight to `dead`. A job that gives up alerts ops with the redacted
//     error and writes a box event.
//   - Kill switch: while provisioning_enabled is false the runner claims no
//     provision job (other kinds keep running).
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { boxEvents, boxes, jobs, type JobKind } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { redactString } from "../logger.js";
import { settingsService, type Settings } from "../settings.js";
import type { Alerter } from "./alerts.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  FatalJobError,
  JobCapExceededError,
  LeaseLostError,
  retryDecision,
  StepTimeoutError,
} from "./errors.js";

export type JobRow = typeof jobs.$inferSelect;
export type BoxRow = typeof boxes.$inferSelect;

export interface JobContext {
  db: CloudDb;
  job: JobRow;
  log: Logger;
  /** Aborted on step timeout, lease loss or shutdown. Pass it to every network call. */
  signal: AbortSignal;
  /** A fresh read of the job's box. */
  box(): Promise<BoxRow>;
}

export interface JobStep {
  name: string;
  timeoutMs: number;
  run(ctx: JobContext): Promise<void>;
}

export interface JobHandler {
  kind: JobKind;
  steps: JobStep[];
  /** Total cap from the job's first start, across retries. */
  maxDurationMs?: number;
  /** Called once when the job ends `failed` or `dead`; box state changes belong here. Must not throw. */
  onGiveUp?(ctx: Omit<JobContext, "signal">, outcome: "failed" | "dead", error: string): Promise<void>;
}

export interface JobRunnerOptions {
  db: CloudDb;
  log: Logger;
  handlers: JobHandler[];
  alerter?: Alerter;
  workerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
}

export const DEFAULT_LEASE_MS = 5 * 60_000;
const CLAIM_LOCK_KEY = 764_001;

class ShutdownError extends Error {
  constructor() {
    super("worker shutting down");
    this.name = "ShutdownError";
  }
}

function describe(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return redactString(text).slice(0, 2000);
}

export class JobRunner {
  readonly workerId: string;
  readonly #db: CloudDb;
  readonly #log: Logger;
  readonly #handlers: Map<JobKind, JobHandler>;
  readonly #alerter: Alerter | undefined;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  readonly #pollMs: number;
  readonly #active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  #timer: NodeJS.Timeout | null = null;
  #stopping = false;
  #ticking = false;

  constructor(opts: JobRunnerOptions) {
    this.#db = opts.db;
    this.#log = opts.log.child({ component: "job-runner" });
    this.#handlers = new Map(opts.handlers.map((h) => [h.kind, h]));
    this.#alerter = opts.alerter;
    this.workerId = opts.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.#leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    this.#heartbeatMs = opts.heartbeatMs ?? Math.min(60_000, Math.floor(this.#leaseMs / 3));
    this.#pollMs = opts.pollMs ?? 2_000;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  start(): void {
    if (this.#timer) return;
    this.#stopping = false;
    this.#timer = setInterval(() => void this.#tick(), this.#pollMs);
    this.#timer.unref();
    this.#log.info("job runner started", { workerId: this.workerId, kinds: [...this.#handlers.keys()] });
  }

  /**
   * Stop claiming, abort in-flight steps, and hand their leases back at once
   * (without using up an attempt) so another worker resumes them.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const { controller } of this.#active.values()) controller.abort(new ShutdownError());
    await Promise.allSettled([...this.#active.values()].map((a) => a.done));
  }

  async #tick(): Promise<void> {
    if (this.#ticking || this.#stopping) return;
    this.#ticking = true;
    try {
      for (;;) {
        const id = await this.claim();
        if (!id) break;
        this.#launch(id);
      }
    } catch (err) {
      this.#log.error("job claim failed", { err });
    } finally {
      this.#ticking = false;
    }
  }

  /** Claim one job and run it to the end of this attempt. Returns its id, or null if none was claimable. */
  async runOnce(): Promise<string | null> {
    const id = await this.claim();
    if (!id) return null;
    await this.#launch(id);
    return id;
  }

  #launch(id: string): Promise<void> {
    const controller = new AbortController();
    const done = this.#run(id, controller).finally(() => this.#active.delete(id));
    this.#active.set(id, { controller, done });
    return done;
  }

  #kinds(settings: Settings): JobKind[] {
    return [...this.#handlers.keys()].filter((k) => k !== "provision" || settings.provisioning_enabled);
  }

  /** The claim: returns the claimed job's id, or null. */
  async claim(): Promise<string | null> {
    if (this.#stopping) return null;
    const settings = await settingsService(this.#db).getAll();
    const kinds = this.#kinds(settings);
    if (!kinds.length) return null;
    return await this.#db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${CLAIM_LOCK_KEY})`);
      const running = (await tx.execute(
        sql`select count(*)::int as n from jobs where state = 'running' and locked_until > now()`,
      )) as unknown as Array<{ n: number }>;
      if ((running[0]?.n ?? 0) >= settings.max_concurrent_jobs) return null;
      const kindList = sql.join(kinds.map((k) => sql`${k}`), sql`, `);
      const rows = (await tx.execute(sql`
        update jobs set
          state = 'running',
          locked_by = ${this.workerId},
          locked_until = now() + ${this.#leaseMs} * interval '1 millisecond',
          heartbeat_at = now(),
          attempt = attempt + 1,
          started_at = coalesce(started_at, now()),
          updated_at = now()
        where id = (
          select id from jobs
           where kind in (${kindList})
             and ((state = 'queued' and run_after <= now()) or (state = 'running' and locked_until < now()))
           order by run_after, created_at
           limit 1
           for update skip locked
        )
        returning id`)) as unknown as Array<{ id: string }>;
      return rows[0]?.id ?? null;
    });
  }

  async #owned(q: ReturnType<typeof sql>): Promise<boolean> {
    const rows = (await this.#db.execute(q)) as unknown as unknown[];
    return rows.length > 0;
  }

  async #run(id: string, controller: AbortController): Promise<void> {
    const [job] = await this.#db.select().from(jobs).where(eq(jobs.id, id));
    if (!job) return;
    const handler = this.#handlers.get(job.kind);
    const log = this.#log.child({ jobId: job.id, jobKind: job.kind, boxId: job.boxId, attempt: job.attempt });
    const ctxBase = {
      db: this.#db,
      job,
      log,
      box: async () => {
        const [b] = await this.#db.select().from(boxes).where(eq(boxes.id, job.boxId));
        if (!b) throw new FatalJobError(`box ${job.boxId} no longer exists`);
        return b;
      },
    };
    const heartbeat = setInterval(() => {
      void this.#owned(sql`
        update jobs set locked_until = now() + ${this.#leaseMs} * interval '1 millisecond', heartbeat_at = now()
         where id = ${id} and locked_by = ${this.workerId} and state = 'running' returning id`)
        .then((ok) => {
          if (!ok) controller.abort(new LeaseLostError(id));
        })
        .catch((err: unknown) => log.warn("heartbeat failed", { err }));
    }, this.#heartbeatMs);
    heartbeat.unref();
    try {
      if (!handler) throw new FatalJobError(`no handler for job kind ${job.kind}`);
      log.info("job attempt started", { step: job.step });
      await this.#execute(job, handler, controller.signal, ctxBase);
      const ok = await this.#owned(sql`
        update jobs set state = 'succeeded', finished_at = now(), locked_by = null, locked_until = null, last_error = null, updated_at = now()
         where id = ${id} and locked_by = ${this.workerId} and state = 'running' returning id`);
      if (!ok) throw new LeaseLostError(id);
      log.info("job succeeded");
    } catch (err) {
      await this.#handleFailure(job, handler, err, controller.signal, ctxBase, log).catch((e: unknown) =>
        log.error("could not record job failure", { err: e }),
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  async #execute(job: JobRow, handler: JobHandler, signal: AbortSignal, ctxBase: Omit<JobContext, "signal">): Promise<void> {
    let start = job.step ? handler.steps.findIndex((s) => s.name === job.step) : 0;
    if (start < 0) {
      ctxBase.log.warn("recorded step is not in the handler; starting from the first step", { step: job.step });
      start = 0;
    }
    for (let i = start; i < handler.steps.length; i++) {
      const step = handler.steps[i]!;
      if (signal.aborted) throw signal.reason;
      if (handler.maxDurationMs) {
        const rows = (await this.#db.execute(
          sql`select (extract(epoch from (now() - started_at)) * 1000)::bigint as ms from jobs where id = ${job.id}`,
        )) as unknown as Array<{ ms: string | number | null }>;
        if (Number(rows[0]?.ms ?? 0) > handler.maxDurationMs) throw new JobCapExceededError(job.kind, handler.maxDurationMs);
      }
      const marked = await this.#owned(sql`
        update jobs set step = ${step.name}, updated_at = now()
         where id = ${job.id} and locked_by = ${this.workerId} and state = 'running' returning id`);
      if (!marked) throw new LeaseLostError(job.id);
      await this.#runStep(step, signal, ctxBase);
    }
  }

  async #runStep(step: JobStep, parent: AbortSignal, ctxBase: Omit<JobContext, "signal">): Promise<void> {
    const child = new AbortController();
    const signal = AbortSignal.any([parent, child.signal]);
    let timer: NodeJS.Timeout | undefined;
    let timedOut: StepTimeoutError | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = new StepTimeoutError(step.name, step.timeoutMs);
        reject(timedOut);
        child.abort(timedOut);
      }, step.timeoutMs);
    });
    const aborted = new Promise<never>((_, reject) => {
      if (parent.aborted) reject(parent.reason);
      else parent.addEventListener("abort", () => reject(parent.reason), { once: true });
    });
    try {
      await Promise.race([step.run({ ...ctxBase, signal }), timeout, aborted]);
    } finally {
      clearTimeout(timer);
    }
    // A step that returns as soon as it sees the abort still timed out.
    if (timedOut) throw timedOut;
  }

  async #handleFailure(
    job: JobRow,
    handler: JobHandler | undefined,
    err: unknown,
    signal: AbortSignal,
    ctxBase: Omit<JobContext, "signal">,
    log: Logger,
  ): Promise<void> {
    const reason = signal.aborted ? signal.reason : null;
    if (err instanceof LeaseLostError || reason instanceof LeaseLostError) {
      log.warn("lease lost; another worker owns the job now");
      return;
    }
    if (err instanceof ShutdownError || reason instanceof ShutdownError) {
      // Not a failure: hand the job straight back without using an attempt.
      await this.#owned(sql`
        update jobs set locked_until = now(), attempt = greatest(attempt - 1, 0), updated_at = now()
         where id = ${job.id} and locked_by = ${this.workerId} and state = 'running' returning id`);
      log.info("job released for another worker (shutdown)");
      return;
    }
    const message = describe(err);
    if (err instanceof FatalJobError) return this.#giveUp(job, handler, "dead", message, ctxBase, log);
    if (err instanceof JobCapExceededError) return this.#giveUp(job, handler, "failed", message, ctxBase, log);
    const decision = retryDecision(err, job.attempt);
    const attempt = decision.countsAsAttempt ? job.attempt : Math.max(job.attempt - 1, 0);
    if (attempt >= (job.maxAttempts || DEFAULT_MAX_ATTEMPTS)) return this.#giveUp(job, handler, "failed", message, ctxBase, log);
    const ok = await this.#owned(sql`
      update jobs set state = 'queued', attempt = ${attempt},
             run_after = now() + ${decision.delayMs} * interval '1 millisecond',
             last_error = ${message}, locked_by = null, locked_until = null, updated_at = now()
       where id = ${job.id} and locked_by = ${this.workerId} and state = 'running' returning id`);
    if (!ok) return log.warn("lease lost before the retry was recorded");
    log.warn("job attempt failed; will retry", { error: message, retryInMs: decision.delayMs, countsAsAttempt: decision.countsAsAttempt });
  }

  async #giveUp(
    job: JobRow,
    handler: JobHandler | undefined,
    outcome: "failed" | "dead",
    message: string,
    ctxBase: Omit<JobContext, "signal">,
    log: Logger,
  ): Promise<void> {
    const rows = (await this.#db.execute(sql`
      update jobs set state = ${outcome}, finished_at = now(), last_error = ${message}, locked_by = null, locked_until = null, updated_at = now()
       where id = ${job.id} and locked_by = ${this.workerId} and state = 'running' returning step`)) as unknown as Array<{ step: string | null }>;
    if (!rows.length) return log.warn("lease lost before the failure was recorded");
    const step = rows[0]!.step;
    log.error(`job ${outcome}`, { error: message, step });
    await this.#db.insert(boxEvents).values({
      boxId: job.boxId,
      kind: `job_${outcome}`,
      actor: this.workerId,
      detail: { jobId: job.id, jobKind: job.kind, step, attempt: job.attempt, error: message },
    });
    if (handler?.onGiveUp) {
      await handler.onGiveUp(ctxBase, outcome, message).catch((err: unknown) => log.error("onGiveUp failed", { err }));
    }
    const [box] = await this.#db.select({ slug: boxes.slug }).from(boxes).where(eq(boxes.id, job.boxId));
    await this.#alerter
      ?.send({
        kind: outcome === "dead" ? "job_dead" : "job_failed",
        subject: `${job.kind} job ${outcome} for box ${box?.slug ?? job.boxId}${step ? ` at step ${step}` : ""}`,
        boxId: job.boxId,
        slug: box?.slug ?? null,
        jobId: job.id,
        jobKind: job.kind,
        step,
        attempt: job.attempt,
        error: message,
      })
      .catch((err: unknown) => log.error("alert failed", { err }));
  }
}
