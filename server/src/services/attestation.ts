/**
 * Attestation service — anchors batches of activity_log rows to an external
 * service via the AnchorAdapter interface, producing a tamper-evident hash
 * chain per company. Reference: docs/superpowers/specs/2026-05-13-delegation-and-attestation-design.md
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  activityLog,
  companies as companiesTable,
  trailAnchors,
  type Db,
} from "@paperclipai/db";
import {
  buildManifest,
  type ActivityEntryInput,
  type AnchorAdapter,
} from "@agentdash/attestation";
import { logger } from "../middleware/logger.js";

/**
 * Persistence + activity-source interface used by the service. Concrete
 * implementations live alongside (`createAttestationStore` wraps Drizzle); tests
 * use in-memory fakes.
 */
export interface AttestationStore {
  listCompanyIdsWithActivity(): Promise<string[]>;
  findLatestAnchor(companyId: string): Promise<LatestAnchorRow | null>;
  fetchNewActivity(
    companyId: string,
    afterActivityId: string | null,
    limit: number,
  ): Promise<ActivityRow[]>;
  insertPendingAnchor(input: PendingAnchorInput): Promise<{ id: string }>;
  markAnchored(anchorId: string, result: AnchoredUpdate): Promise<void>;
  markFailed(anchorId: string, errorMessage: string): Promise<void>;
}

export interface ActivityRow {
  id: string;
  createdAt: Date;
  action: string;
  entityType: string;
  entityId: string;
  actorType: string;
  actorId: string;
  details: Record<string, unknown> | null;
}

export interface LatestAnchorRow {
  id: string;
  batchEndActivityId: string;
  manifestSha256: string;
}

export interface PendingAnchorInput {
  companyId: string;
  prevAnchorId: string | null;
  prevPayloadHash: string | null;
  batchStartActivityId: string;
  batchEndActivityId: string;
  batchActivityCount: number;
  manifestSha256: string;
  manifestPreview: Record<string, unknown>;
  adapter: string;
}

export interface AnchoredUpdate {
  externalLogId: string;
  externalBlockHeight: string | null | undefined;
  externalAnchoredAt: string | null | undefined;
}

export interface AttestationServiceOptions {
  /** Max activity rows folded into a single anchor batch. */
  batchLimit?: number;
  /** Logger context — defaults to the shared server logger. */
  log?: typeof logger;
}

export interface AnchorRunSummary {
  companyId: string;
  anchored: number;
  skipped: number;
  failed: number;
  newRows: number;
}

const DEFAULT_BATCH_LIMIT = 500;
const MANIFEST_PREVIEW_ENTRIES = 3;

export function attestationService(
  store: AttestationStore,
  adapter: AnchorAdapter,
  opts: AttestationServiceOptions = {},
) {
  const batchLimit = opts.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const log = opts.log ?? logger;

  async function anchorCompany(companyId: string): Promise<AnchorRunSummary> {
    const summary: AnchorRunSummary = { companyId, anchored: 0, skipped: 0, failed: 0, newRows: 0 };

    const latest = await store.findLatestAnchor(companyId);
    const after = latest?.batchEndActivityId ?? null;
    const rows = await store.fetchNewActivity(companyId, after, batchLimit);
    summary.newRows = rows.length;

    if (rows.length === 0) {
      summary.skipped++;
      return summary;
    }

    const entries: ActivityEntryInput[] = rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      actorType: r.actorType,
      actorId: r.actorId,
      details: r.details ?? null,
    }));

    const { manifest, payloadHash } = buildManifest({
      companyId,
      prevPayloadHash: latest?.manifestSha256 ?? null,
      entries,
    });

    const start = entries[0]!;
    const end = entries[entries.length - 1]!;

    const previewEntries = manifest.entries.slice(0, MANIFEST_PREVIEW_ENTRIES);
    const manifestPreview: Record<string, unknown> = {
      v: manifest.v,
      count: manifest.count,
      entries: previewEntries,
      truncated: manifest.entries.length > previewEntries.length,
    };

    const pending = await store.insertPendingAnchor({
      companyId,
      prevAnchorId: latest?.id ?? null,
      prevPayloadHash: latest?.manifestSha256 ?? null,
      batchStartActivityId: start.id,
      batchEndActivityId: end.id,
      batchActivityCount: entries.length,
      manifestSha256: payloadHash,
      manifestPreview,
      adapter: adapter.name,
    });

    try {
      const result = await adapter.anchorBatch(payloadHash, {
        companyId,
        manifestSha256: payloadHash,
        batchStartActivityId: start.id,
        batchEndActivityId: end.id,
        batchActivityCount: entries.length,
        prevAnchorId: latest?.id ?? null,
      });
      await store.markAnchored(pending.id, {
        externalLogId: result.externalLogId,
        externalBlockHeight: result.externalBlockHeight,
        externalAnchoredAt: result.externalAnchoredAt,
      });
      summary.anchored++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ companyId, anchorId: pending.id, err: message }, "[attestation] anchor failed");
      await store.markFailed(pending.id, message.slice(0, 1000));
      summary.failed++;
    }

    return summary;
  }

  async function run(): Promise<AnchorRunSummary[]> {
    const companyIds = await store.listCompanyIdsWithActivity();
    const summaries: AnchorRunSummary[] = [];
    for (const companyId of companyIds) {
      try {
        summaries.push(await anchorCompany(companyId));
      } catch (err) {
        log.error(
          { companyId, err: err instanceof Error ? err.message : String(err) },
          "[attestation] anchorCompany failed",
        );
        summaries.push({ companyId, anchored: 0, skipped: 0, failed: 1, newRows: 0 });
      }
    }
    return summaries;
  }

  return { run, anchorCompany };
}

export type AttestationService = ReturnType<typeof attestationService>;

/** Drizzle-backed implementation of {@link AttestationStore}. */
export function createAttestationStore(db: Db): AttestationStore {
  return {
    async listCompanyIdsWithActivity() {
      const rows = await db
        .select({ id: companiesTable.id })
        .from(companiesTable)
        .where(
          sql`EXISTS (SELECT 1 FROM ${activityLog} a WHERE a.company_id = ${companiesTable.id})`,
        );
      return rows.map((r) => r.id);
    },

    async findLatestAnchor(companyId) {
      const rows = await db
        .select({
          id: trailAnchors.id,
          batchEndActivityId: trailAnchors.batchEndActivityId,
          manifestSha256: trailAnchors.manifestSha256,
        })
        .from(trailAnchors)
        .where(and(eq(trailAnchors.companyId, companyId), eq(trailAnchors.status, "anchored")))
        .orderBy(desc(trailAnchors.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },

    async fetchNewActivity(companyId, afterActivityId, limit) {
      if (afterActivityId === null) {
        const rows = await db
          .select()
          .from(activityLog)
          .where(eq(activityLog.companyId, companyId))
          .orderBy(asc(activityLog.createdAt), asc(activityLog.id))
          .limit(limit);
        return rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          actorType: r.actorType,
          actorId: r.actorId,
          details: r.details ?? null,
        }));
      }
      const cursor = await db
        .select({ createdAt: activityLog.createdAt, id: activityLog.id })
        .from(activityLog)
        .where(eq(activityLog.id, afterActivityId))
        .limit(1);
      const c = cursor[0];
      const baseQuery = db
        .select()
        .from(activityLog)
        .where(
          c
            ? and(
                eq(activityLog.companyId, companyId),
                sql`(${activityLog.createdAt}, ${activityLog.id}) > (${c.createdAt}, ${c.id})`,
              )
            : eq(activityLog.companyId, companyId),
        )
        .orderBy(asc(activityLog.createdAt), asc(activityLog.id))
        .limit(limit);
      const rows = await baseQuery;
      return rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        actorType: r.actorType,
        actorId: r.actorId,
        details: r.details ?? null,
      }));
    },

    async insertPendingAnchor(input) {
      const [row] = await db
        .insert(trailAnchors)
        .values({
          companyId: input.companyId,
          prevAnchorId: input.prevAnchorId,
          prevPayloadHash: input.prevPayloadHash,
          batchStartActivityId: input.batchStartActivityId,
          batchEndActivityId: input.batchEndActivityId,
          batchActivityCount: input.batchActivityCount,
          manifestSha256: input.manifestSha256,
          manifestPreview: input.manifestPreview,
          adapter: input.adapter,
          status: "pending",
        })
        .returning({ id: trailAnchors.id });
      if (!row) {
        throw new Error("[attestation] insertPendingAnchor returned no row");
      }
      return { id: row.id };
    },

    async markAnchored(anchorId, result) {
      await db
        .update(trailAnchors)
        .set({
          status: "anchored",
          externalLogId: result.externalLogId,
          externalBlockHeight: result.externalBlockHeight
            ? BigInt(result.externalBlockHeight)
            : null,
          externalAnchoredAt: result.externalAnchoredAt
            ? new Date(result.externalAnchoredAt)
            : null,
          anchoredAt: new Date(),
          lastError: null,
        })
        .where(eq(trailAnchors.id, anchorId));
    },

    async markFailed(anchorId, errorMessage) {
      await db
        .update(trailAnchors)
        .set({ status: "failed", lastError: errorMessage })
        .where(eq(trailAnchors.id, anchorId));
    },
  };
}
