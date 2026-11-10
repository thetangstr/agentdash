import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assistantGrants, batchOperationItems, batchOperations, companies } from "@paperclipai/db";
import {
  ASSISTANT_BATCH_CONFIRM_CODE_MAX_ATTEMPTS,
  ASSISTANT_BATCH_KINDS,
  ASSISTANT_BATCH_PREPARE_LIMIT_PER_HOUR,
  ASSISTANT_BATCH_RECORD_LIMIT_PER_HOUR,
  ASSISTANT_SCOPE_ADMIN,
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


/**
 * Part 5: the code that confirms an assistant-prepared batch. Eight
 * characters of Crockford base32 (40 random bits), shown as `K7QM-3XRD`.
 * Only `confirmCodeHash` of it is stored; it is returned once, by the
 * browser-only mint route, and never logged or written to any row.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function mintBatchConfirmCode(): string {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let code = "";
  for (let i = 7; i >= 0; i -= 1) code += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return code;
}

export function formatBatchConfirmCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** What a person reads aloud: any case, dashes or spaces, and the letters Crockford folds (O→0, I/L→1). Null when it cannot be a code. */
export function normalizeBatchConfirmCode(input: string): string | null {
  const folded = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(folded) ? folded : null;
}

export function confirmCodeHash(batchId: string, code: string): string {
  return sha256Hex(`agentdash-batch-code:${batchId}:${code}`);
}

/** Constant-time: the stored hash and the hash of what was said are compared byte for byte. */
export function confirmCodeMatches(batchId: string, input: string, storedHash: string): boolean {
  const normalized = normalizeBatchConfirmCode(input);
  // A malformed answer is still hashed and compared, so timing does not say which.
  const candidate = Buffer.from(confirmCodeHash(batchId, normalized ?? `invalid:${input}`), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored) && normalized !== null;
}

type BatchRow = typeof batchOperations.$inferSelect;
type ItemRow = typeof batchOperationItems.$inferSelect;

function batchView(row: BatchRow, items?: ItemRow[], assistantClientName?: string | null): BatchView {
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
    ...(row.origin === "assistant" ? { assistantClientName: assistantClientName ?? null } : {}),
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

  /** Preview: the exact records and the exact change to each, stored for one confirm. */
  async function planAndStore(
    req: Request,
    companyId: string,
    input: BatchPreviewRequest,
    opts: { origin: "ui" } | { origin: "assistant"; grantId: string },
  ): Promise<BatchPreviewResult> {
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
      // A UI preview gets a single-use confirm handle; an assistant one never
      // does (its code is minted only on the browser review page).
      const confirmHandle = opts.origin === "ui" ? randomBytes(32).toString("base64url") : null;
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
        if (opts.origin === "assistant") {
          // Part 5: prepares per grant per rolling hour, durable (this table).
          const [{ prepared }] = await tx
            .select({ prepared: sql<number>`count(*)::int` })
            .from(batchOperations)
            .where(and(
              eq(batchOperations.assistantGrantId, opts.grantId!),
              gt(batchOperations.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
            ));
          if (Number(prepared) >= ASSISTANT_BATCH_PREPARE_LIMIT_PER_HOUR) {
            throw tooMany(`This connection can prepare up to ${ASSISTANT_BATCH_PREPARE_LIMIT_PER_HOUR} batches an hour. Try again later.`);
          }
        }
        const [batch] = await tx.insert(batchOperations).values({
          companyId,
          kind: kind.key,
          change: change as Record<string, unknown>,
          origin: opts.origin,
          createdByUserId: userId,
          assistantGrantId: opts.origin === "assistant" ? opts.grantId! : null,
          status: "previewed",
          confirmTokenHash: confirmHandle ? sha256Hex(confirmHandle) : null,
          previewDigest,
          itemKeyNonce: randomBytes(32).toString("base64url"),
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
    
  }

  /**
   * Part 5: who may use an assistant-prepared batch from the assistant side.
   * All of: the request is a grant actor (the person's own connection); the
   * grant row is live, belongs to this person and company, and holds
   * `agentdash:admin`; the person is an admin of the company (read from the
   * database); the company switch is on. Read fresh on every call.
   */
  async function assistantBatchAccess(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source !== "assistant_grant" || !req.actor.assistantGrantId || !req.actor.userId) {
      throw forbidden("These routes are for your own assistant connection.");
    }
    const grantId = req.actor.assistantGrantId;
    const userId = req.actor.userId;
    const [grant] = await db.select().from(assistantGrants).where(eq(assistantGrants.id, grantId));
    if (!grant || grant.revokedAt || grant.userId !== userId || grant.companyId !== companyId) {
      throw forbidden("This assistant connection was revoked or does not belong to this company.");
    }
    if (!grant.scopes.includes(ASSISTANT_SCOPE_ADMIN)) {
      throw new HttpError(403, "This assistant connection was not given batch changes as an admin. Reconnect it and check that option.", { required_scope: ASSISTANT_SCOPE_ADMIN, scopes: grant.scopes }, "insufficient_scope");
    }
    const company = await assertAdminBatchesOn(req, companyId);
    return { grantId, userId, clientName: grant.clientName, maxRecords: company.assistantBatchMaxRecords };
  }

  /** The person is an admin of the company and its "batch changes from Claude" switch is on. */
  async function assertAdminBatchesOn(req: Request, companyId: string) {
    if (!(await isCompanyAdministrator(access, req, companyId))) {
      throw forbidden("Only owners and admins can make batch changes from their own Claude.");
    }
    const [company] = await db
      .select({ enabled: companies.assistantAdminBatchesEnabled, assistantBatchMaxRecords: companies.assistantBatchMaxRecords })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!company?.enabled) throw forbidden("Batch changes from an admin's own Claude are turned off for this company.");
    return company;
  }

  /**
   * The person in their own browser session (or the local operator): never a
   * grant, its internal loopback, a board key or a batch item credential.
   */
  function browserPersonOnly(req: Request): BatchItemCredentialOrigin {
    if (req.actor.source === "assistant_grant" || req.verifiedCredential?.kind === "batch_item" || req.verifiedCredential?.kind === "assistant") {
      throw forbidden("Only you, in your browser, can do this.");
    }
    return credentialOrigin(req);
  }

  function startRunner(input: Omit<Parameters<typeof runBatch>[0], "db" | "send" | "timeBudgetMs" | "itemTimeoutMs">) {
    const run = runBatch({
      db,
      ...input,
      send: options.send,
      timeBudgetMs: options.timeBudgetMs,
      itemTimeoutMs: options.itemTimeoutMs,
    }).catch((err) => logger.error({ err, batchId: input.batchId }, "batch runner failed"))
      .finally(() => running.delete(input.batchId));
    running.set(input.batchId, run);
  }

  return {
    async preview(req: Request, companyId: string, input: BatchPreviewRequest): Promise<BatchPreviewResult> {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      credentialOrigin(req);
      return planAndStore(req, companyId, input, { origin: "ui" });
    },

    /** Part 5: the assistant-side gate (grant live with the admin scope, admin, switch on), for routes that work before previewing. */
    async assertAssistantAccess(req: Request, companyId: string): Promise<void> {
      await assistantBatchAccess(req, companyId);
    },

    /**
     * Part 5: a preview the person's own Claude asked for. Stored with origin
     * `assistant` and the grant, and with NO confirm handle: it can only be
     * spent by the code its review page shows the person in their browser
     * (confirmAssistant), or by "Apply here" there (applyHere).
     */
    async previewAssistant(
      req: Request,
      companyId: string,
      input: BatchPreviewRequest,
    ): Promise<BatchPreviewResult & { maxRecords: number }> {
      const access = await assistantBatchAccess(req, companyId);
      if (!(ASSISTANT_BATCH_KINDS as readonly string[]).includes(input.kind)) {
        throw badRequest("This kind of batch change cannot be prepared from an assistant.");
      }
      if (new Set(input.ids).size > access.maxRecords) {
        throw badRequest(`A batch from your assistant holds at most ${access.maxRecords} records in this company.`);
      }
      const result = await planAndStore(req, companyId, input, { origin: "assistant", grantId: access.grantId });
      return { ...result, maxRecords: access.maxRecords };
    },

    /**
     * Part 5: shows the person the code that confirms an assistant-prepared
     * batch. Only the creator, in their own browser session (never a grant,
     * a board key, an internal loopback or a batch item credential), while
     * the batch is still previewed and the company switch is on. Each call
     * replaces the previous code. Only a hash is stored; the code is returned
     * once, in this response, and never logged.
     */
    async mintConfirmCode(req: Request, companyId: string, batchId: string): Promise<{ code: string; expiresAt: string }> {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      browserPersonOnly(req);
      const existing = await loadOwnBatch(req, companyId, batchId);
      if (existing.origin !== "assistant") throw conflict("This batch is confirmed on the page where you previewed it.");
      await assertAdminBatchesOn(req, companyId);
      if (existing.status !== "previewed" || existing.expiresAt.getTime() <= Date.now()) {
        throw conflict("This batch was already used, cancelled or has expired. Ask your assistant to prepare it again.");
      }
      const code = mintBatchConfirmCode();
      const [row] = await db
        .update(batchOperations)
        .set({ confirmCodeHash: confirmCodeHash(batchId, code) })
        .where(and(
          eq(batchOperations.id, batchId),
          eq(batchOperations.status, "previewed"),
          gt(batchOperations.expiresAt, new Date()),
        ))
        .returning({ expiresAt: batchOperations.expiresAt });
      if (!row) throw conflict("This batch was already used, cancelled or has expired. Ask your assistant to prepare it again.");
      await runWithBatchActivityContext({ batchId, companyId, origin: "assistant" }, () =>
        logActivity(db, {
          companyId,
          actorType: "user",
          actorId: actorUserId(req),
          action: "batch.confirm_code_shown",
          entityType: "batch",
          entityId: batchId,
          details: { kind: existing.kind, itemCount: existing.itemCount },
        }));
      return { code: formatBatchConfirmCode(code), expiresAt: row.expiresAt.toISOString() };
    },

    /**
     * Part 5: the person's own Claude spends an assistant-prepared batch with
     * the code the person read to it. Only the grant that prepared it, for
     * the person who owns that grant; the grant, admin role and switch are
     * re-checked here and again before every item. A wrong code counts; the
     * fifth cancels the batch. The comparison is constant-time.
     */
    async confirmAssistant(req: Request, companyId: string, batchId: string, rawCode: string): Promise<{ batchId: string; status: BatchStatus }> {
      const access = await assistantBatchAccess(req, companyId);
      if (!isUuidLike(batchId)) throw notFound("Batch not found");
      const [existing] = await db
        .select()
        .from(batchOperations)
        .where(and(eq(batchOperations.id, batchId), eq(batchOperations.companyId, companyId)));
      if (!existing || existing.origin !== "assistant" || existing.assistantGrantId !== access.grantId || existing.createdByUserId !== access.userId) {
        throw notFound("Batch not found");
      }
      const kind = kindFor(existing.kind);
      await kind.previewGuard?.({ db, req, companyId });
      const origin = loopbackOrigin(req);
      const outcome = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`batch-confirm:${access.userId}`}))`);
        const [row] = await tx.select().from(batchOperations).where(eq(batchOperations.id, batchId)).for("update");
        const now = new Date();
        if (!row || row.status !== "previewed" || row.expiresAt.getTime() <= now.getTime()) return { kind: "gone" as const };
        if (!row.confirmCodeHash) return { kind: "no_code" as const };
        if (!confirmCodeMatches(batchId, rawCode, row.confirmCodeHash)) {
          const attempts = row.confirmCodeAttempts + 1;
          if (attempts >= ASSISTANT_BATCH_CONFIRM_CODE_MAX_ATTEMPTS) {
            await tx
              .update(batchOperations)
              .set({ confirmCodeAttempts: attempts, confirmCodeHash: null, status: "cancelled", completedAt: now })
              .where(eq(batchOperations.id, batchId));
            return { kind: "cancelled" as const };
          }
          await tx.update(batchOperations).set({ confirmCodeAttempts: attempts }).where(eq(batchOperations.id, batchId));
          return { kind: "wrong" as const, left: ASSISTANT_BATCH_CONFIRM_CODE_MAX_ATTEMPTS - attempts };
        }
        const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const [{ byGrant }] = await tx
          .select({ byGrant: sql<number>`coalesce(sum(${batchOperations.itemCount}), 0)::int` })
          .from(batchOperations)
          .where(and(eq(batchOperations.assistantGrantId, access.grantId), gt(batchOperations.confirmedAt, hourAgo)));
        if (Number(byGrant) + row.itemCount > ASSISTANT_BATCH_RECORD_LIMIT_PER_HOUR) return { kind: "grant_cap" as const };
        const [{ byPerson }] = await tx
          .select({ byPerson: sql<number>`coalesce(sum(${batchOperations.itemCount}), 0)::int` })
          .from(batchOperations)
          .where(and(eq(batchOperations.createdByUserId, access.userId), gt(batchOperations.confirmedAt, hourAgo)));
        if (Number(byPerson) + row.itemCount > BATCH_MAX_CONFIRMED_RECORDS_PER_HOUR) return { kind: "person_cap" as const };
        const [spent] = await tx
          .update(batchOperations)
          .set({ status: "running", confirmedAt: now, executorHeartbeatAt: now, confirmCodeHash: null })
          .where(and(eq(batchOperations.id, batchId), eq(batchOperations.status, "previewed")))
          .returning();
        return spent ? { kind: "spent" as const } : { kind: "gone" as const };
      });
      if (outcome.kind === "gone") throw conflict("This batch was already used, cancelled or has expired. Prepare it again.");
      if (outcome.kind === "no_code") {
        throw conflict("No code has been shown for this batch yet. Ask the person to open the review link and choose Show code for Claude.");
      }
      if (outcome.kind === "wrong") {
        throw new HttpError(403, `That code is not right. ${outcome.left} ${outcome.left === 1 ? "try" : "tries"} left before this batch is cancelled. Ask the person to read the code from the review page again.`, undefined, "batch_code_wrong");
      }
      if (outcome.kind === "cancelled") {
        throw new HttpError(403, "That code is not right, and this was the last try: the batch is cancelled and nothing was changed. Prepare it again.", undefined, "batch_cancelled");
      }
      if (outcome.kind === "grant_cap") {
        throw tooMany(`This connection can change up to ${ASSISTANT_BATCH_RECORD_LIMIT_PER_HOUR} records an hour in batches. Try again later.`);
      }
      if (outcome.kind === "person_cap") {
        throw tooMany(`You can change up to ${BATCH_MAX_CONFIRMED_RECORDS_PER_HOUR} records an hour in batches. Try again later.`);
      }
      startRunner({
        kind,
        batchId,
        companyId,
        origin: "assistant",
        actor: { ...req.actor },
        credential: { kind: "assistant", grantId: access.grantId, userId: access.userId },
        loopbackOrigin: origin,
        grantId: access.grantId,
        client: access.clientName,
      });
      return { batchId, status: "running" };
    },

    /**
     * Part 5: "Apply here" on the review page. The creator's own browser
     * session spends an assistant-prepared batch directly; each item then
     * carries that session, as for a batch started in the product. The rows
     * still name the connection that prepared it.
     */
    async applyHere(req: Request, companyId: string, batchId: string): Promise<{ batchId: string; status: BatchStatus }> {
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const credential = browserPersonOnly(req);
      const existing = await loadOwnBatch(req, companyId, batchId);
      if (existing.origin !== "assistant") throw conflict("This batch is confirmed on the page where you previewed it.");
      await assertAdminBatchesOn(req, companyId);
      const kind = kindFor(existing.kind);
      await kind.previewGuard?.({ db, req, companyId });
      const userId = actorUserId(req);
      const origin = loopbackOrigin(req);
      const spent = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`batch-confirm:${userId}`}))`);
        const [{ confirmed }] = await tx
          .select({ confirmed: sql<number>`coalesce(sum(${batchOperations.itemCount}), 0)::int` })
          .from(batchOperations)
          .where(and(eq(batchOperations.createdByUserId, userId), gt(batchOperations.confirmedAt, new Date(Date.now() - 60 * 60 * 1000))));
        if (Number(confirmed) + existing.itemCount > BATCH_MAX_CONFIRMED_RECORDS_PER_HOUR) {
          throw tooMany(`You can change up to ${BATCH_MAX_CONFIRMED_RECORDS_PER_HOUR} records an hour in batches. Try again later.`);
        }
        const now = new Date();
        const [row] = await tx
          .update(batchOperations)
          .set({ status: "running", confirmedAt: now, executorHeartbeatAt: now, confirmCodeHash: null })
          .where(and(
            eq(batchOperations.id, batchId),
            eq(batchOperations.createdByUserId, userId),
            eq(batchOperations.status, "previewed"),
            gt(batchOperations.expiresAt, now),
          ))
          .returning();
        return row ?? null;
      });
      if (!spent) throw conflict("This batch was already used, cancelled or has expired. Ask your assistant to prepare it again.");
      const [grant] = existing.assistantGrantId
        ? await db.select({ clientName: assistantGrants.clientName }).from(assistantGrants).where(eq(assistantGrants.id, existing.assistantGrantId))
        : [];
      startRunner({
        kind,
        batchId,
        companyId,
        origin: "assistant",
        actor: { ...req.actor },
        credential,
        loopbackOrigin: origin,
        grantId: existing.assistantGrantId,
        client: grant?.clientName ?? null,
      });
      return { batchId, status: "running" };
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
      // Part 5: the connection that prepared a batch may read that batch
      // (its status and outcomes, never any code or hash), and nothing else.
      const viaGrant = req.actor.source === "assistant_grant";
      // Otherwise the same credential rule as preview and confirm: a signed-in
      // person in the browser (or the local operator), never a board key.
      if (!viaGrant) credentialOrigin(req);
      if (!isUuidLike(batchId)) throw notFound("Batch not found");
      const [row] = await db
        .select()
        .from(batchOperations)
        .where(and(eq(batchOperations.id, batchId), eq(batchOperations.companyId, companyId)));
      if (!row) throw notFound("Batch not found");
      if (viaGrant) {
        if (row.origin !== "assistant" || !req.actor.assistantGrantId || row.assistantGrantId !== req.actor.assistantGrantId || row.createdByUserId !== req.actor.userId) {
          throw notFound("Batch not found");
        }
      } else if (row.createdByUserId !== actorUserId(req) && !(await isCompanyAdministrator(access, req, companyId))) {
        throw notFound("Batch not found");
      }
      const items = await db
        .select()
        .from(batchOperationItems)
        .where(eq(batchOperationItems.batchId, batchId))
        .orderBy(asc(batchOperationItems.ordinal));
      const [grant] = row.assistantGrantId
        ? await db.select({ clientName: assistantGrants.clientName }).from(assistantGrants).where(eq(assistantGrants.id, row.assistantGrantId))
        : [];
      return batchView(row, items, grant?.clientName ?? null);
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
