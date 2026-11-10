import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { batchOperationItems, batchOperations } from "@paperclipai/db";
import {
  isUuidLike,
  BATCH_MAX_CONFIRMED_RECORDS_PER_HOUR,
  BATCH_MAX_OPEN_PREVIEWS_PER_USER,
  BATCH_PREVIEW_TTL_MS,
  emptyBatchCounts,
  type BatchConfirmRequest,
  type BatchCounts,
  type BatchItemOutcome,
  type BatchItemView,
  type BatchOrigin,
  type BatchPreviewRequest,
  type BatchPreviewResult,
  type BatchReconcileRequest,
  type BatchReconcileVerdict,
  type BatchStatus,
  type BatchView,
} from "@paperclipai/shared";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../../errors.js";
import { assertBoard, assertCompanyAccess, isCompanyAdministrator } from "../../routes/authz.js";
import { accessService } from "../access.js";
import { logActivity } from "../activity-log.js";
import { runWithBatchActivityContext } from "../../lib/batch-activity-context.js";
import { logger } from "../../middleware/logger.js";
import { BATCH_KINDS, type AnyBatchKind } from "./kinds.js";
import { canonicalJson, sha256Hex, type BatchItemCredentialOrigin } from "./item-credential.js";
import { fingerprintOf, runBatch, type BatchItemSender } from "./runner.js";

/**
 * AgentDash admin powers, part 2: the one batch engine.
 *
 * preview → exact records and the exact change to each, a single-use confirm
 * handle bound to that preview (15 minutes, only its hash stored);
 * confirm → spends the handle with a conditional UPDATE (of two parallel
 * confirms exactly one wins), checks the preview digest, starts the runner
 * and answers 202; the runner sends each item through the record's own
 * single-record route (runner.ts). A batch is bound to one company and one
 * person, and every item is re-checked by that route for that person.
 */

export interface BatchServiceOptions {
  kinds?: Readonly<Record<string, AnyBatchKind>>;
  /** Tests only: replace the loopback client. */
  send?: BatchItemSender;
  timeBudgetMs?: number;
  itemTimeoutMs?: number;
}

const BATCH_SOURCES_MESSAGE = "Batch changes need you signed in to AgentDash in the browser.";

function tooMany(message: string) {
  return new HttpError(429, message);
}

/** Which proof the confirming request carries. Batches start only from a signed-in person (or the local operator). */
function credentialOrigin(req: Request): BatchItemCredentialOrigin {
  if (req.actor.type === "board" && req.actor.source === "local_implicit") return { kind: "local_implicit" };
  const verified = req.verifiedCredential;
  if (
    req.actor.type === "board"
    && req.actor.source === "session"
    && req.actor.userId
    && verified?.kind === "session"
    && verified.userId === req.actor.userId
  ) {
    return { kind: "session", sessionId: verified.sessionId, userId: verified.userId };
  }
  throw forbidden(BATCH_SOURCES_MESSAGE);
}

function actorUserId(req: Request): string {
  return req.actor.userId ?? "local-board";
}

/**
 * The origin of the listener this request arrived on: its own local address
 * and port, never an assumed 127.0.0.1. A server bound to one address (a
 * tailnet IP, a custom host) is reached on that address, so no other local
 * process that happens to hold 127.0.0.1:<port> can receive an item's
 * credential. Unspecified addresses map to loopback; IPv4-mapped IPv6 is
 * unwrapped; IPv6 is bracketed.
 */
export function loopbackOriginFor(socket: { encrypted?: boolean; localAddress?: string; localPort?: number } | undefined): string {
  if (!socket?.localPort || !socket.localAddress) throw new HttpError(500, "The batch could not be started on this server.");
  let host = socket.localAddress;
  // A link-local IPv6 address with a zone id (fe80::1%en0) has no valid URL
  // form here; refuse plainly before anything is spent or sent.
  if (host.includes("%")) {
    throw new HttpError(503, "Batch changes are not available while this server listens on a link-local network address.");
  }
  if (host.startsWith("::ffff:") && host.includes(".")) host = host.slice("::ffff:".length);
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  const authority = host.includes(":") ? `[${host}]` : host;
  return `${socket.encrypted ? "https" : "http"}://${authority}:${socket.localPort}`;
}

function loopbackOrigin(req: Request): string {
  return loopbackOriginFor(req.socket as { encrypted?: boolean; localAddress?: string; localPort?: number } | undefined);
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

type BatchRow = typeof batchOperations.$inferSelect;
type ItemRow = typeof batchOperationItems.$inferSelect;

function batchView(row: BatchRow, items?: ItemRow[]): BatchView {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind,
    change: row.change,
    origin: row.origin as BatchOrigin,
    status: row.status as BatchStatus,
    createdByUserId: row.createdByUserId,
    itemCount: row.itemCount,
    counts: (row.counts as BatchCounts | null) ?? emptyBatchCounts(),
    expiresAt: row.expiresAt.toISOString(),
    confirmedAt: iso(row.confirmedAt),
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
    ...(items
      ? {
          items: items.map((item): BatchItemView => ({
            itemId: item.id,
            ordinal: item.ordinal,
            entityType: item.entityType,
            entityId: item.entityId,
            label: item.label,
            before: item.before,
            after: item.after,
            outcome: item.outcome as BatchItemOutcome,
            reasonCode: item.reasonCode,
            reason: item.reason,
            httpStatus: item.httpStatus,
            actual: item.actual ?? null,
            appliedAt: iso(item.appliedAt),
            reconciledVerdict: (item.reconciledVerdict as BatchReconcileVerdict | null) ?? null,
            reconciledAt: iso(item.reconciledAt),
          })),
        }
      : {}),
  };
}

export function batchService(db: Db, options: BatchServiceOptions = {}) {
  const kinds = options.kinds ?? BATCH_KINDS;
  const access = accessService(db);
  const running = new Map<string, Promise<void>>();

  function kindFor(key: string): AnyBatchKind {
    const kind = Object.prototype.hasOwnProperty.call(kinds, key) ? kinds[key] : undefined;
    if (!kind) throw badRequest("This kind of batch change is not available.");
    return kind;
  }

  async function loadOwnBatch(req: Request, companyId: string, batchId: string): Promise<BatchRow> {
    if (!isUuidLike(batchId)) throw notFound("Batch not found");
    const [row] = await db
      .select()
      .from(batchOperations)
      .where(and(eq(batchOperations.id, batchId), eq(batchOperations.companyId, companyId)));
    // Another person's batch is not named: the same 404 as a missing one.
    if (!row || row.createdByUserId !== actorUserId(req)) throw notFound("Batch not found");
    return row;
  }

  return {
    async preview(req: Request, companyId: string, input: BatchPreviewRequest): Promise<BatchPreviewResult> {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      credentialOrigin(req);
      // Fail here, before a preview is stored, if items could not be sent.
      loopbackOrigin(req);
      const kind = kindFor(input.kind);
      await kind.previewGuard?.({ db, req, companyId });
      const change = kind.parseChange(input.change);
      const ids = [...new Set(input.ids)];
      if (ids.length > kind.maxPerBatch) throw badRequest(`A batch of this kind holds at most ${kind.maxPerBatch} records.`);
      const userId = actorUserId(req);

      const records = await kind.load({ db, req, companyId }, ids, change);
      const omitted = { notFound: 0, noop: 0, notDecidable: 0 };
      const notDecidable: BatchPreviewResult["notDecidable"] = [];
      const planned: Array<{ entityType: string; entityId: string; label: string; before: Record<string, unknown>; after: Record<string, unknown>; notes?: string[] }> = [];
      for (const id of ids) {
        const record = records.get(id);
        if (!record) { omitted.notFound++; continue; }
        const described = kind.describe(record, change);
        if (described.noop) { omitted.noop++; continue; }
        if (described.notDecidable) {
          omitted.notDecidable++;
          notDecidable.push({ entityType: record.entityType, entityId: record.entityId, label: record.label, ...described.notDecidable });
          continue;
        }
        planned.push({
          entityType: record.entityType, entityId: record.entityId, label: record.label, before: described.before, after: described.after,
          ...(described.notes?.length ? { notes: described.notes } : {}),
        });
      }
      if (planned.length === 0) {
        return { batchId: null, previewDigest: null, confirmHandle: null, expiresAt: null, kind: kind.key, items: [], omitted, notDecidable };
      }

      const previewDigest = sha256Hex(canonicalJson({
        companyId,
        kind: kind.key,
        change,
        items: planned.map((item) => [item.entityType, item.entityId, item.before, item.after]),
      }));
      const confirmHandle = randomBytes(32).toString("base64url");
      const notesByEntity = new Map(planned.filter((item) => item.notes).map((item) => [`${item.entityType}:${item.entityId}`, item.notes!]));
      const expiresAt = new Date(Date.now() + BATCH_PREVIEW_TTL_MS);

      const created = await db.transaction(async (tx) => {
        // One person's open previews are counted under a per-person lock, so
        // two tabs cannot both slip past the cap.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`batch-preview:${userId}`}))`);
        const [{ open }] = await tx
          .select({ open: sql<number>`count(*)::int` })
          .from(batchOperations)
          .where(and(
            eq(batchOperations.createdByUserId, userId),
            eq(batchOperations.status, "previewed"),
            gt(batchOperations.expiresAt, new Date()),
          ));
        if (Number(open) >= BATCH_MAX_OPEN_PREVIEWS_PER_USER) {
          throw tooMany(`You already have ${BATCH_MAX_OPEN_PREVIEWS_PER_USER} batch previews open. Apply or cancel one first.`);
        }
        const [batch] = await tx.insert(batchOperations).values({
          companyId,
          kind: kind.key,
          change: change as Record<string, unknown>,
          origin: "ui",
          createdByUserId: userId,
          status: "previewed",
          confirmTokenHash: sha256Hex(confirmHandle),
          previewDigest,
          itemCount: planned.length,
          counts: emptyBatchCounts(),
          expiresAt,
        }).returning();
        const items = await tx.insert(batchOperationItems).values(planned.map((item, ordinal) => ({
          batchId: batch!.id,
          ordinal,
          entityType: item.entityType,
          entityId: item.entityId,
          label: item.label,
          before: item.before,
          after: item.after,
          fingerprint: fingerprintOf(item.before),
        }))).returning();
        return { batch: batch!, items };
      });
      return {
        batchId: created.batch.id,
        previewDigest,
        confirmHandle,
        expiresAt: expiresAt.toISOString(),
        kind: kind.key,
        items: created.items
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((item) => {
            const notes = notesByEntity.get(`${item.entityType}:${item.entityId}`);
            return { itemId: item.id, entityType: item.entityType, entityId: item.entityId, label: item.label, before: item.before, after: item.after, ...(notes ? { notes } : {}) };
          }),
        omitted,
        notDecidable,
      };
    },

    async confirm(req: Request, companyId: string, batchId: string, input: BatchConfirmRequest): Promise<{ batchId: string; status: BatchStatus }> {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const credential = credentialOrigin(req);
      const existing = await loadOwnBatch(req, companyId, batchId);
      if (existing.origin !== "ui") throw forbidden("This batch is confirmed from its review page.");
      const kind = kindFor(existing.kind);
      // A kind's own guard (admin-only kinds) holds at confirm as well as at
      // preview: the person may have lost the role in between.
      await kind.previewGuard?.({ db, req, companyId });
      if (existing.previewDigest !== input.previewDigest) {
        throw conflict("This preview is out of date. Preview the change again.");
      }
      const userId = actorUserId(req);
      const origin = loopbackOrigin(req);
      const spent = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`batch-confirm:${userId}`}))`);
        const [{ confirmed }] = await tx
          .select({ confirmed: sql<number>`coalesce(sum(${batchOperations.itemCount}), 0)::int` })
          .from(batchOperations)
          .where(and(
            eq(batchOperations.createdByUserId, userId),
            gt(batchOperations.confirmedAt, new Date(Date.now() - 60 * 60 * 1000)),
          ));
        if (Number(confirmed) + existing.itemCount > BATCH_MAX_CONFIRMED_RECORDS_PER_HOUR) {
          throw tooMany(`You can change up to ${BATCH_MAX_CONFIRMED_RECORDS_PER_HOUR} records an hour in batches. Try again later.`);
        }
        const now = new Date();
        const [row] = await tx
          .update(batchOperations)
          .set({ status: "running", confirmedAt: now, executorHeartbeatAt: now })
          .where(and(
            eq(batchOperations.id, batchId),
            eq(batchOperations.companyId, companyId),
            eq(batchOperations.createdByUserId, userId),
            eq(batchOperations.status, "previewed"),
            eq(batchOperations.confirmTokenHash, sha256Hex(input.handle)),
            gt(batchOperations.expiresAt, now),
          ))
          .returning();
        return row ?? null;
      });
      if (!spent) {
        throw conflict(existing.status === "previewed" && existing.expiresAt.getTime() > Date.now()
          ? "This confirmation does not match the preview. Preview the change again."
          : "This preview was already used or has expired. Preview the change again.");
      }
      const run = runBatch({
        db,
        kind,
        batchId,
        companyId,
        origin: "ui",
        actor: { ...req.actor },
        credential,
        loopbackOrigin: origin,
        send: options.send,
        timeBudgetMs: options.timeBudgetMs,
        itemTimeoutMs: options.itemTimeoutMs,
      }).catch((err) => logger.error({ err, batchId }, "batch runner failed"))
        .finally(() => running.delete(batchId));
      running.set(batchId, run);
      return { batchId, status: "running" };
    },

    async get(req: Request, companyId: string, batchId: string): Promise<BatchView> {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      // The same credential rule as preview and confirm: a signed-in person
      // in the browser (or the local operator), never a board key or grant.
      credentialOrigin(req);
      if (!isUuidLike(batchId)) throw notFound("Batch not found");
      const [row] = await db
        .select()
        .from(batchOperations)
        .where(and(eq(batchOperations.id, batchId), eq(batchOperations.companyId, companyId)));
      if (!row) throw notFound("Batch not found");
      if (row.createdByUserId !== actorUserId(req) && !(await isCompanyAdministrator(access, req, companyId))) {
        throw notFound("Batch not found");
      }
      const items = await db
        .select()
        .from(batchOperationItems)
        .where(eq(batchOperationItems.batchId, batchId))
        .orderBy(asc(batchOperationItems.ordinal));
      return batchView(row, items);
    },

    async list(req: Request, companyId: string, opts: { limit?: number } = {}): Promise<BatchView[]> {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      // The same credential rule as preview and confirm: a signed-in person
      // in the browser (or the local operator), never a board key or grant.
      credentialOrigin(req);
      const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
      const admin = await isCompanyAdministrator(access, req, companyId);
      const rows = await db
        .select()
        .from(batchOperations)
        .where(admin
          ? eq(batchOperations.companyId, companyId)
          : and(eq(batchOperations.companyId, companyId), eq(batchOperations.createdByUserId, actorUserId(req))))
        .orderBy(desc(batchOperations.createdAt))
        .limit(limit);
      return rows.map((row) => batchView(row));
    },

    async cancel(req: Request, companyId: string, batchId: string): Promise<BatchView> {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      // The same credential rule as preview and confirm: a signed-in person
      // in the browser (or the local operator), never a board key or grant.
      credentialOrigin(req);
      await loadOwnBatch(req, companyId, batchId);
      const [row] = await db
        .update(batchOperations)
        .set({ status: "cancelled", completedAt: new Date() })
        .where(and(eq(batchOperations.id, batchId), eq(batchOperations.status, "previewed")))
        .returning();
      if (!row) throw conflict("Only a batch that has not been applied can be cancelled.");
      return batchView(row);
    },

    async reconcile(req: Request, companyId: string, batchId: string, itemId: string, input: BatchReconcileRequest): Promise<BatchItemView> {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      // The same credential rule as preview and confirm: a signed-in person
      // in the browser (or the local operator), never a board key or grant.
      credentialOrigin(req);
      if (!(await isCompanyAdministrator(access, req, companyId))) {
        throw forbidden("Only owners and admins can record what happened to an unknown change.");
      }
      if (!isUuidLike(batchId) || !isUuidLike(itemId)) throw notFound("Batch not found");
      const [batch] = await db
        .select()
        .from(batchOperations)
        .where(and(eq(batchOperations.id, batchId), eq(batchOperations.companyId, companyId)));
      if (!batch) throw notFound("Batch not found");
      const [item] = await db
        .update(batchOperationItems)
        .set({
          reconciledByUserId: actorUserId(req),
          reconciledVerdict: input.verdict,
          reconciledAt: new Date(),
          updatedAt: new Date(),
        })
        // Unknown items only, and once: a verdict is audit, it never resends.
        .where(and(
          eq(batchOperationItems.id, itemId),
          eq(batchOperationItems.batchId, batchId),
          eq(batchOperationItems.outcome, "unknown"),
          sql`${batchOperationItems.reconciledVerdict} is null`,
        ))
        .returning();
      if (!item) throw conflict("Only a change with an unknown outcome and no recorded verdict can be reconciled.");
      await runWithBatchActivityContext({ batchId, itemId: item.id, companyId, origin: batch.origin as BatchOrigin }, () =>
        logActivity(db, {
          companyId,
          actorType: "user",
          actorId: actorUserId(req),
          action: "batch.item_reconciled",
          entityType: item.entityType,
          entityId: item.entityId,
          details: {
            kind: batch.kind,
            label: item.label,
            verdict: input.verdict,
            ...(input.note ? { note: input.note } : {}),
          },
        }));
      return batchView(batch, [item]).items![0]!;
    },

    /** Tests and shutdown: resolves when the batch's runner (if any, in this process) has finished. */
    async waitForRunner(batchId: string): Promise<void> {
      await running.get(batchId);
    },
  };
}

export type BatchService = ReturnType<typeof batchService>;
