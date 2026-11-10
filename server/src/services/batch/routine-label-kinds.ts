import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { issueLabels, labels, routines } from "@paperclipai/db";
import {
  BATCH_MAX_RECORDS_UI,
  labelUpdateBatchChangeSchema,
  noOptionsBatchChangeSchema,
  type LabelUpdateBatchChange,
  type NoOptionsBatchChange,
} from "@paperclipai/shared";
import type { BatchKind, BatchKindRecord } from "./kinds.js";

/**
 * AgentDash admin powers, part 3b: routines (archive, delete) and labels
 * (rename/recolor, delete) in bulk. Each record goes through its own route:
 * `PATCH /routines/:id {status:"archived"}`, `DELETE /routines/:id`,
 * `PATCH /labels/:labelId`, `DELETE /labels/:labelId`. Their guards decide
 * (routines: `assertCanWriteRoutines`; labels: company access, today's rule).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuids = (ids: readonly string[]) => [...new Set(ids)].filter((id) => UUID.test(id));

type RoutineRecord = BatchKindRecord & { status: string };

async function loadRoutines(db: Parameters<BatchKind["load"]>[0]["db"], companyId: string, ids: readonly string[]) {
  const wanted = uuids(ids);
  if (wanted.length === 0) return new Map<string, RoutineRecord>();
  const rows = await db
    .select({ id: routines.id, title: routines.title, status: routines.status })
    .from(routines)
    .where(and(eq(routines.companyId, companyId), inArray(routines.id, wanted), isNull(routines.deletedAt)));
  return new Map(rows.map((row) => [row.id, { entityType: "routine", entityId: row.id, label: row.title, status: row.status }]));
}

export const routineArchiveBatchKind: BatchKind<NoOptionsBatchChange, RoutineRecord> = {
  key: "routine.archive",
  entityType: "routine",
  noun: "routine",
  maxPerBatch: BATCH_MAX_RECORDS_UI,
  parseChange: (input) => noOptionsBatchChangeSchema.parse(input),
  load: ({ db, companyId }, ids) => loadRoutines(db, companyId, ids),
  describe(record) {
    const before = { status: record.status };
    const after = { status: "archived" };
    if (record.status === "archived") return { before, after, noop: true };
    return { before, after, noop: false, notes: ["Archiving stops it from running. It can be restored later."] };
  },
  request: (record) => ({ method: "PATCH", path: `/api/routines/${record.entityId}`, body: { status: "archived" } }),
};

export const routineDeleteBatchKind: BatchKind<NoOptionsBatchChange, RoutineRecord> = {
  key: "routine.delete",
  entityType: "routine",
  noun: "routine",
  maxPerBatch: BATCH_MAX_RECORDS_UI,
  parseChange: (input) => noOptionsBatchChangeSchema.parse(input),
  load: ({ db, companyId }, ids) => loadRoutines(db, companyId, ids),
  describe(record) {
    return {
      before: { state: record.status },
      after: { state: "deleted" },
      noop: false,
      notes: ["Deleting removes the routine for good; it cannot be restored. Its past runs, the tasks they created and its history are kept."],
    };
  },
  observe: (record) => ({ state: record.status }),
  observeMissing: { state: "deleted" },
  request: (record) => ({ method: "DELETE", path: `/api/routines/${record.entityId}`, body: {} }),
};

type LabelRecord = BatchKindRecord & { name: string; color: string; taskCount: number };

async function loadLabels(db: Parameters<BatchKind["load"]>[0]["db"], companyId: string, ids: readonly string[]) {
  const wanted = uuids(ids);
  if (wanted.length === 0) return new Map<string, LabelRecord>();
  const rows = await db
    .select({ id: labels.id, name: labels.name, color: labels.color })
    .from(labels)
    .where(and(eq(labels.companyId, companyId), inArray(labels.id, wanted)));
  const counts = rows.length === 0 ? [] : await db
    .select({ labelId: issueLabels.labelId, count: sql<number>`count(*)::int` })
    .from(issueLabels)
    .where(inArray(issueLabels.labelId, rows.map((row) => row.id)))
    .groupBy(issueLabels.labelId);
  const countByLabel = new Map(counts.map((row) => [row.labelId, Number(row.count)]));
  return new Map(rows.map((row) => [row.id, {
    entityType: "label",
    entityId: row.id,
    label: `Label "${row.name}"`,
    name: row.name,
    color: row.color,
    taskCount: countByLabel.get(row.id) ?? 0,
  }]));
}

export const labelUpdateBatchKind: BatchKind<LabelUpdateBatchChange, LabelRecord> = {
  key: "label.update",
  entityType: "label",
  noun: "label",
  maxPerBatch: BATCH_MAX_RECORDS_UI,
  parseChange: (input) => labelUpdateBatchChangeSchema.parse(input),
  load: ({ db, companyId }, ids) => loadLabels(db, companyId, ids),
  describe(record, change) {
    const before = { name: record.name, color: record.color };
    const after = { name: change.name ?? record.name, color: change.color ?? record.color };
    return { before, after, noop: before.name === after.name && before.color === after.color };
  },
  observe: (record) => ({ name: record.name, color: record.color }),
  request: (record, change) => ({
    method: "PATCH",
    path: `/api/labels/${record.entityId}`,
    body: {
      ...(change.name !== undefined && change.name !== record.name ? { name: change.name } : {}),
      ...(change.color !== undefined && change.color !== record.color ? { color: change.color } : {}),
    },
  }),
};

export const labelDeleteBatchKind: BatchKind<NoOptionsBatchChange, LabelRecord> = {
  key: "label.delete",
  entityType: "label",
  noun: "label",
  maxPerBatch: BATCH_MAX_RECORDS_UI,
  parseChange: (input) => noOptionsBatchChangeSchema.parse(input),
  load: ({ db, companyId }, ids) => loadLabels(db, companyId, ids),
  describe(record) {
    return {
      // The task count is part of `before`, so a label put on more tasks
      // after the preview is refused as changed rather than removed from them.
      before: { state: "exists", taskCount: record.taskCount },
      after: { state: "deleted", taskCount: record.taskCount },
      noop: false,
      notes: [record.taskCount === 0
        ? "No task has this label."
        : `Deleting removes the label from ${record.taskCount} ${record.taskCount === 1 ? "task" : "tasks"}. Those tasks get no history entry for it.`],
    };
  },
  observe: () => ({ state: "exists" }),
  observeMissing: { state: "deleted" },
  request: (record) => ({ method: "DELETE", path: `/api/labels/${record.entityId}`, body: {} }),
};
