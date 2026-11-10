import http from "node:http";
import https from "node:https";
import type { Request } from "express";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authSessions, batchOperationItems, batchOperations, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import {
  BATCH_HEARTBEAT_INTERVAL_MS,
  BATCH_ITEM_TIMEOUT_MS,
  BATCH_REASON_CODES,
  BATCH_REASON_MAX_LENGTH,
  BATCH_TIME_BUDGET_MS,
  emptyBatchCounts,
  type BatchCounts,
  type BatchItemFinalOutcome,
  type BatchOrigin,
} from "@paperclipai/shared";
import { logActivity } from "../activity-log.js";
import { runWithBatchActivityContext } from "../../lib/batch-activity-context.js";
import { logger } from "../../middleware/logger.js";
import { configuredEdgeSecret, EDGE_SECRET_HEADER } from "../../middleware/edge-gate.js";
import type { AnyBatchKind } from "./kinds.js";
import {
  batchItemBodyDigest,
  canonicalJson,
  mintBatchItemCredential,
  revokeBatchItemCredential,
  sha256Hex,
  type BatchItemCredentialOrigin,
} from "./item-credential.js";

/**
 * AgentDash admin powers, part 2: runs a confirmed batch, one item at a time,
 * in ordinal order, each through the record's own single-record route.
 *
 * Per item: re-read the person's access (session, membership, instance-admin
 * role) and the record; refuse it if the record changed since the preview
 * (drift) or can no longer be seen; mark it `applying`; mint a single-use
 * `pcbx_` credential bound to exactly that request; send it over loopback;
 * map the answer to an outcome. A sent item with no answer is `unknown` and
 * is never retried. Heartbeats every 5 seconds let the sweeper tell a stopped
 * runner from a slow one, across replicas.
 */

export interface BatchRunnerContext {
  db: Db;
  kind: AnyBatchKind;
  batchId: string;
  companyId: string;
  origin: BatchOrigin;
  /** The confirming request's actor and the proof it authenticated with. */
  actor: Request["actor"];
  credential: BatchItemCredentialOrigin;
  /** `http(s)://127.0.0.1:<port>`: the listener the confirm arrived on. */
  loopbackOrigin: string;
  send?: BatchItemSender;
  timeBudgetMs?: number;
  itemTimeoutMs?: number;
  /** Read from the batch row when the runner starts. Never leaves the server. */
  itemKeyNonce?: string | null;
}

export type BatchSendResult =
  | { kind: "response"; status: number; body: unknown }
  /** The request never left: nothing could have changed. */
  | { kind: "not_sent"; error: string }
  /** The request was sent and no answer came back: it may or may not have landed. */
  | { kind: "no_answer"; error: string };

export type BatchItemSender = (input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}) => Promise<BatchSendResult>;

/** Node's own client, so "never sent" (connection refused) and "sent, no answer" (reset, timeout) stay distinct. */
export const sendBatchItemOverLoopback: BatchItemSender = ({ url, method, headers, body, timeoutMs }) =>
  new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      // Nothing left this process: an unparseable target is never "unknown".
      resolve({ kind: "not_sent", error: "invalid loopback address" });
      return;
    }
    const client = target.protocol === "https:" ? https : http;
    let written = false;
    let settled = false;
    const finish = (result: BatchSendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const request = client.request(target, {
      method,
      headers: { ...headers, "content-length": Buffer.byteLength(body).toString() },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        if (chunks.reduce((total, part) => total + part.length, 0) < 64 * 1024) chunks.push(chunk);
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
        finish({ kind: "response", status: response.statusCode ?? 0, body: parsed });
      });
      response.on("error", (err) => finish({ kind: "no_answer", error: err.message }));
    });
    const timer = setTimeout(() => {
      request.destroy(new Error("timeout"));
      finish(written ? { kind: "no_answer", error: "timeout" } : { kind: "not_sent", error: "timeout before sending" });
    }, timeoutMs);
    request.on("finish", () => { written = true; });
    request.on("error", (err) => {
      finish(written ? { kind: "no_answer", error: err.message } : { kind: "not_sent", error: err.message });
    });
    request.end(body);
  });

function clip(text: string): string {
  return text.length > BATCH_REASON_MAX_LENGTH ? `${text.slice(0, BATCH_REASON_MAX_LENGTH - 3)}...` : text;
}

function routeReason(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    for (const key of ["error", "reason", "message"] as const) {
      const value = (body as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return clip(value.trim());
    }
  }
  return status === 404 ? "This record could not be found." : `The change was refused (HTTP ${status}).`;
}

function plainValue(value: unknown): string {
  if (value === null || value === undefined) return "none";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** "status is in_review, not done; assigneeAgentId is …, not none" — only the fields that differ. */
function describeDifference(previewed: Record<string, unknown>, actual: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(previewed)) {
    if (canonicalJson(previewed[key]) !== canonicalJson(actual[key])) {
      parts.push(`${key} is ${plainValue(actual[key])}, not ${plainValue(previewed[key])}`);
    }
  }
  for (const key of Object.keys(actual)) {
    if (!(key in previewed)) parts.push(`${key} is ${plainValue(actual[key])}`);
  }
  return parts.join("; ") || "it differs from the preview";
}

/**
 * The idempotency key an item's request carries where the route takes one.
 * Derived from a per-batch secret that no route ever returns, so a person who
 * can read a batch's item ids cannot spend the key first on another record.
 */
export function batchItemIdempotencyKey(nonce: string | null, batchId: string, itemId: string): string {
  return `batch:${sha256Hex(`${nonce ?? batchId}:${itemId}`).slice(0, 48)}`;
}

export function fingerprintOf(before: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(before));
}

/** Recomputes the counts from the items, so they are always the items' truth. */
export async function recountBatch(db: Pick<Db, "select" | "update">, batchId: string): Promise<BatchCounts> {
  const rows = await db
    .select({ outcome: batchOperationItems.outcome, count: sql<number>`count(*)::int` })
    .from(batchOperationItems)
    .where(eq(batchOperationItems.batchId, batchId))
    .groupBy(batchOperationItems.outcome);
  const counts = emptyBatchCounts();
  for (const row of rows) {
    if (row.outcome === "applied" || row.outcome === "refused" || row.outcome === "failed" || row.outcome === "unknown") {
      counts[row.outcome] = Number(row.count);
    }
  }
  const [different] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(batchOperationItems)
    .where(and(
      eq(batchOperationItems.batchId, batchId),
      eq(batchOperationItems.outcome, "applied"),
      eq(batchOperationItems.reasonCode, BATCH_REASON_CODES.appliedDifferently),
    ));
  counts.appliedDifferently = Number(different?.count ?? 0);
  await db.update(batchOperations).set({ counts }).where(eq(batchOperations.id, batchId));
  return counts;
}

type RefreshedAccess = { ok: true; actor: Request["actor"] } | { ok: false };

/** The person's access as it is now, not as it was at confirm. */
async function refreshAccess(db: Db, ctx: BatchRunnerContext): Promise<RefreshedAccess> {
  if (ctx.credential.kind === "local_implicit") return { ok: true, actor: { ...ctx.actor } };
  const { sessionId, userId } = ctx.credential;
  const [session] = await db
    .select({ userId: authSessions.userId, expiresAt: authSessions.expiresAt })
    .from(authSessions)
    .where(eq(authSessions.id, sessionId));
  if (!session || session.userId !== userId || session.expiresAt.getTime() <= Date.now()) return { ok: false };
  const [membership] = await db
    .select({ membershipRole: companyMemberships.membershipRole, status: companyMemberships.status })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, ctx.companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
      eq(companyMemberships.status, "active"),
    ));
  const [admin] = await db
    .select({ id: instanceUserRoles.id })
    .from(instanceUserRoles)
    .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));
  if (!membership && !admin) return { ok: false };
  return {
    ok: true,
    actor: {
      ...ctx.actor,
      // A batch is bound to one company: the item actor carries no other.
      companyIds: membership ? [ctx.companyId] : [],
      memberships: membership ? [{ companyId: ctx.companyId, membershipRole: membership.membershipRole, status: membership.status }] : [],
      isInstanceAdmin: Boolean(admin),
    },
  };
}

type ItemRow = typeof batchOperationItems.$inferSelect;

async function settleItem(
  ctx: BatchRunnerContext,
  item: ItemRow,
  outcome: BatchItemFinalOutcome,
  detail: { reasonCode?: string | null; reason?: string | null; httpStatus?: number | null; actual?: Record<string, unknown> | null },
) {
  const { db } = ctx;
  const updated = await db
    .update(batchOperationItems)
    .set({
      outcome,
      reasonCode: detail.reasonCode ?? null,
      reason: detail.reason ? clip(detail.reason) : null,
      httpStatus: detail.httpStatus ?? null,
      actual: detail.actual ?? null,
      appliedAt: outcome === "applied" ? new Date() : null,
      updatedAt: new Date(),
    })
    // Only an item still in flight: a settled item is never rewritten.
    .where(and(eq(batchOperationItems.id, item.id), inArray(batchOperationItems.outcome, ["pending", "applying"])))
    .returning({ id: batchOperationItems.id });
  if (updated.length === 0) return;
  // An applied record's row is the route's own (it carries details.batch).
  // The engine writes a row only for what the route did not record, or did
  // differently from the preview.
  const differently = outcome === "applied" && detail.reasonCode === BATCH_REASON_CODES.appliedDifferently;
  if (outcome !== "applied" || differently) {
    await runWithBatchActivityContext({ batchId: ctx.batchId, itemId: item.id, companyId: ctx.companyId, origin: ctx.origin }, () =>
      logActivity(db, {
        companyId: ctx.companyId,
        actorType: "user",
        actorId: ctx.actor.userId ?? "board",
        action: differently
          ? "batch.item_applied_differently"
          : outcome === "refused" ? "batch.item_refused" : outcome === "failed" ? "batch.item_failed" : "batch.item_unknown",
        entityType: item.entityType,
        entityId: item.entityId,
        details: {
          kind: ctx.kind.key,
          label: item.label,
          reasonCode: detail.reasonCode ?? null,
          reason: detail.reason ? clip(detail.reason) : null,
          httpStatus: detail.httpStatus ?? null,
          ...(differently ? { previewed: item.after, actual: detail.actual ?? null } : {}),
        },
      }));
  }
  await recountBatch(db, ctx.batchId);
}

async function refuseRemaining(ctx: BatchRunnerContext, items: ItemRow[], reasonCode: string, reason: string) {
  for (const item of items) await settleItem(ctx, item, "refused", { reasonCode, reason });
}

function itemRequestView(actor: Request["actor"]): Request {
  // Only `actor` is read by the visibility helpers the kinds use at apply.
  return { actor } as unknown as Request;
}

async function runItem(ctx: BatchRunnerContext, change: unknown, item: ItemRow, actor: Request["actor"]) {
  const { db, kind } = ctx;
  const records = await kind.load({ db, req: itemRequestView(actor), companyId: ctx.companyId }, [item.entityId], change);
  const record = records.get(item.entityId);
  if (!record) {
    await settleItem(ctx, item, "refused", {
      reasonCode: BATCH_REASON_CODES.noLongerVisible,
      reason: `${item.label} no longer exists or you can no longer see it; nothing was done to it.`,
    });
    return;
  }
  const described = kind.describe(record, change);
  // Drift: the record, or what the change would make of it (for example who
  // the route would hand it to), is not what the preview showed.
  if (fingerprintOf(described.before) !== item.fingerprint || canonicalJson(described.after) !== canonicalJson(item.after)) {
    await settleItem(ctx, item, "refused", {
      reasonCode: BATCH_REASON_CODES.changedSincePreview,
      reason: `This ${kind.noun} changed after you previewed it, so nothing was done to it.`,
    });
    return;
  }
  // The record's own rules now decide this change (for example a review step
  // was added after the preview): not sent, with the same plain reason.
  if (described.notDecidable) {
    await settleItem(ctx, item, "refused", { reasonCode: described.notDecidable.reasonCode, reason: described.notDecidable.reason });
    return;
  }
  const request = kind.request(record, change, {
    itemId: item.id,
    before: item.before,
    idempotencyKey: batchItemIdempotencyKey(ctx.itemKeyNonce ?? null, ctx.batchId, item.id),
  });
  const body = JSON.stringify(request.body);
  const claimed = await db
    .update(batchOperationItems)
    .set({ outcome: "applying", updatedAt: new Date() })
    .where(and(eq(batchOperationItems.id, item.id), eq(batchOperationItems.outcome, "pending")))
    .returning({ id: batchOperationItems.id });
  if (claimed.length === 0) return; // settled elsewhere (sweeper); never send twice
  const token = mintBatchItemCredential({
    batchId: ctx.batchId,
    itemId: item.id,
    companyId: ctx.companyId,
    origin: ctx.origin,
    credential: ctx.credential,
    actor,
    binding: { method: request.method, path: request.path, bodyDigest: batchItemBodyDigest(request.body) },
  });
  const edgeSecret = configuredEdgeSecret();
  const send = ctx.send ?? sendBatchItemOverLoopback;
  let result: BatchSendResult;
  try {
    result = await send({
      url: `${ctx.loopbackOrigin}${request.path}`,
      method: request.method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
        // Behind the edge router the box answers only requests carrying its
        // edge secret; this request goes from the box to itself.
        ...(edgeSecret ? { [EDGE_SECRET_HEADER]: edgeSecret } : {}),
      },
      body,
      timeoutMs: ctx.itemTimeoutMs ?? BATCH_ITEM_TIMEOUT_MS,
    });
  } catch (err) {
    result = { kind: "no_answer", error: err instanceof Error ? err.message : String(err) };
  } finally {
    revokeBatchItemCredential(token);
  }
  if (result.kind === "not_sent") {
    await settleItem(ctx, item, "failed", {
      reasonCode: BATCH_REASON_CODES.notSent,
      reason: `${item.label} could not be sent, so nothing was done to it.`,
    });
    return;
  }
  if (result.kind === "no_answer") {
    await settleItem(ctx, item, "unknown", {
      reasonCode: BATCH_REASON_CODES.noAnswer,
      reason: `No answer came back for ${item.label}. It may or may not have changed; check it before trying again.`,
    });
    return;
  }
  const { status } = result;
  if (status >= 200 && status < 300) {
    // A 2xx says the route accepted the request, not that it did what the
    // preview showed: an execution policy can send a "done" to review and
    // hand it to the reviewer. Re-read the record; if the touched fields are
    // not what the preview said, the item says so, with the actual values.
    // The answer itself can show the change was not this batch's (for an
    // approval: someone else decided it first, and the route answers 200).
    const notOurs = kind.checkResponse?.(result.body, { actorUserId: actor.userId ?? null, request }) ?? null;
    const after = await kind.load({ db, req: itemRequestView(actor), companyId: ctx.companyId }, [item.entityId], change);
    const current = after.get(item.entityId);
    // A record that is gone after a delete is what a delete kind expects.
    const actual = current
      ? (kind.observe ? kind.observe(current) : kind.describe(current, change).before)
      : kind.observeMissing ? { ...kind.observeMissing } : null;
    if (notOurs) {
      await settleItem(ctx, item, "applied", {
        httpStatus: status,
        actual,
        reasonCode: BATCH_REASON_CODES.notThisBatchsDecision,
        reason: `${item.label}: ${notOurs}`,
      });
      return;
    }
    // Compare the observed fields against the same keys of the preview.
    const expected = actual ? Object.fromEntries(Object.keys(actual).map((key) => [key, item.after[key]])) : null;
    if (actual && canonicalJson(actual) === canonicalJson(expected)) {
      await settleItem(ctx, item, "applied", { httpStatus: status, actual });
    } else {
      await settleItem(ctx, item, "applied", {
        httpStatus: status,
        actual,
        reasonCode: BATCH_REASON_CODES.appliedDifferently,
        reason: actual
          ? `${item.label} was changed, but not as previewed: ${describeDifference(item.after, actual)}.`
          : `${item.label} was changed, but you can no longer see it to check how.`,
      });
    }
    return;
  }
  if (status >= 400 && status < 500) {
    await settleItem(ctx, item, "refused", {
      reasonCode: BATCH_REASON_CODES.routeRefused,
      reason: routeReason(result.body, status),
      httpStatus: status,
    });
    return;
  }
  // A server error may come after the change was accepted (some routes answer
  // 500 when follow-up effects are unresolved). Only an unchanged record is
  // reported as failed; anything else is unknown, never "failed".
  const reread = await kind.load({ db, req: itemRequestView(actor), companyId: ctx.companyId }, [item.entityId], change);
  const now = reread.get(item.entityId);
  const unchanged = now ? fingerprintOf(kind.describe(now, change).before) === item.fingerprint : false;
  if (unchanged) {
    await settleItem(ctx, item, "failed", {
      reasonCode: BATCH_REASON_CODES.routeFailed,
      reason: `${item.label} was not changed: the server reported an error.`,
      httpStatus: status,
    });
  } else {
    await settleItem(ctx, item, "unknown", {
      reasonCode: BATCH_REASON_CODES.routeFailed,
      reason: `The server reported an error for ${item.label}, and it may have changed. Check it before trying again.`,
      httpStatus: status,
    });
  }
}

/** Runs the batch to the end. Never throws: an unexpected error interrupts the batch the way the sweeper would. */
export async function runBatch(ctx: BatchRunnerContext): Promise<void> {
  const { db } = ctx;
  const startedAt = Date.now();
  const budget = ctx.timeBudgetMs ?? BATCH_TIME_BUDGET_MS;
  const heartbeat = setInterval(() => {
    void db
      .update(batchOperations)
      .set({ executorHeartbeatAt: new Date() })
      .where(and(eq(batchOperations.id, ctx.batchId), eq(batchOperations.status, "running")))
      .catch((err) => logger.warn({ err, batchId: ctx.batchId }, "batch heartbeat failed"));
  }, BATCH_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  try {
    const [stored] = await db.select({ change: batchOperations.change, itemKeyNonce: batchOperations.itemKeyNonce }).from(batchOperations).where(eq(batchOperations.id, ctx.batchId));
    ctx.itemKeyNonce = stored?.itemKeyNonce ?? null;
    const change = ctx.kind.parseChange(stored?.change ?? {});
    const items = await db
      .select()
      .from(batchOperationItems)
      .where(and(eq(batchOperationItems.batchId, ctx.batchId), eq(batchOperationItems.outcome, "pending")))
      .orderBy(asc(batchOperationItems.ordinal));
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      const [batch] = await db.select({ status: batchOperations.status }).from(batchOperations).where(eq(batchOperations.id, ctx.batchId));
      if (batch?.status !== "running") return; // the sweeper interrupted it
      if (Date.now() - startedAt >= budget) {
        await refuseRemaining(ctx, items.slice(index), BATCH_REASON_CODES.timeBudget,
          "The batch ran out of time before reaching this record; nothing was done to it.");
        break;
      }
      const access = await refreshAccess(db, ctx);
      if (!access.ok) {
        await refuseRemaining(ctx, items.slice(index), BATCH_REASON_CODES.accessEnded,
          "Your sign-in or your access to this company ended, so this record was not sent.");
        break;
      }
      await runItem(ctx, change, item, access.actor);
    }
    const finished = await db
      .update(batchOperations)
      .set({ status: "completed", completedAt: new Date(), executorHeartbeatAt: new Date() })
      .where(and(eq(batchOperations.id, ctx.batchId), eq(batchOperations.status, "running")))
      .returning({ id: batchOperations.id });
    if (finished.length > 0) {
      const counts = await recountBatch(db, ctx.batchId);
      await runWithBatchActivityContext({ batchId: ctx.batchId, companyId: ctx.companyId, origin: ctx.origin }, () =>
        logActivity(db, {
          companyId: ctx.companyId,
          actorType: "user",
          actorId: ctx.actor.userId ?? "board",
          action: "batch.completed",
          entityType: "batch",
          entityId: ctx.batchId,
          details: { kind: ctx.kind.key, counts },
        }));
    }
  } catch (err) {
    logger.error({ err, batchId: ctx.batchId }, "batch runner stopped unexpectedly");
    const { interruptBatch } = await import("./sweeper.js");
    await interruptBatch(db, ctx.batchId).catch((inner) => logger.error({ err: inner, batchId: ctx.batchId }, "could not interrupt batch"));
  } finally {
    clearInterval(heartbeat);
  }
}
