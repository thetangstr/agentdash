import { and, eq, inArray, isNull } from "drizzle-orm";
import { agents, agentStewardships } from "@paperclipai/db";
import {
  agentPauseResumeBatchChangeSchema,
  agentSetModelBatchChangeSchema,
  agentTransferStewardBatchChangeSchema,
  BATCH_MAX_RECORDS_UI,
  BATCH_REASON_CODES,
  type AgentPauseResumeBatchChange,
  type AgentSetModelBatchChange,
  type AgentTransferStewardBatchChange,
} from "@paperclipai/shared";
import { forbidden } from "../../errors.js";
import { visibleAgentIdsFor } from "../../routes/visibility.js";
import { listAdapterModels } from "../../adapters/registry.js";
import { accessService } from "../access.js";
import type { BatchKind, BatchKindContext, BatchKindRecord } from "./kinds.js";

/**
 * AgentDash admin powers, part 3b: agents in bulk — pause, resume, change
 * model, hand over to another steward. Each record goes through the agent's
 * own route (pause/resume, PATCH /agents/:id, the stewardship transfer), whose
 * guards decide. These kinds are for people with `agents:create` (the
 * routes' own rule); the engine runs that guard at preview and again at
 * confirm, so someone who loses it in between sends nothing.
 *
 * Secrets: an agent's adapter configuration can hold credentials. These kinds
 * read only `adapterConfig.model` out of it; nothing else of the
 * configuration enters a record, a batch row, a preview, an activity row or
 * a log line.
 */

type AgentRecord = BatchKindRecord & {
  companyId: string;
  status: string;
  adapterType: string;
  /** Only the model, never the rest of adapterConfig. */
  model: string | null;
  stewardUserId: string | null;
  /** For `agent.set_model`: whether the agent's runtime offers the chosen model. */
  modelOffered?: boolean;
  /**
   * For `agent.transfer_steward`: the new steward cannot take this agent. A
   * person looks after one agent at a time in a company (the stewardship
   * table's own rule), so only one agent can go to them.
   */
  targetBusyWith?: string | null;
};

const UNMANAGEABLE = new Set(["terminated", "pending_approval"]);

async function requireAgentManagement(ctx: BatchKindContext) {
  const { req, companyId, db } = ctx;
  if (req.actor.type !== "board") throw forbidden("Board access required");
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  const allowed = await accessService(db).canUser(companyId, req.actor.userId, "agents:create");
  if (!allowed) throw forbidden("Only people who can manage agents can change agents in bulk.");
}

function modelOf(adapterConfig: unknown): string | null {
  if (!adapterConfig || typeof adapterConfig !== "object" || Array.isArray(adapterConfig)) return null;
  const model = (adapterConfig as Record<string, unknown>).model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

async function loadAgents(ctx: BatchKindContext, ids: readonly string[], chosenModel?: string, transferTo?: string): Promise<Map<string, AgentRecord>> {
  const { db, req, companyId } = ctx;
  const wanted = [...new Set(ids)].filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  if (wanted.length === 0) return new Map();
  const visible = await visibleAgentIdsFor(db, req, companyId);
  const rows = await db
    .select({ id: agents.id, name: agents.name, status: agents.status, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, wanted)));
  const shown = rows.filter((row) => visible === null || visible.has(row.id));
  const stewards = shown.length === 0 ? [] : await db
    .select({ agentId: agentStewardships.agentId, userId: agentStewardships.userId })
    .from(agentStewardships)
    .where(and(eq(agentStewardships.companyId, companyId), inArray(agentStewardships.agentId, shown.map((row) => row.id)), isNull(agentStewardships.endedAt)));
  const stewardByAgent = new Map(stewards.map((row) => [row.agentId, row.userId]));
  const offeredByAdapter = new Map<string, boolean>();
  if (chosenModel) {
    for (const adapterType of new Set(shown.map((row) => row.adapterType))) {
      // The same per-adapter list the agent configuration form offers
      // (GET /companies/:id/adapters/:type/models).
      const models = await listAdapterModels(adapterType).catch(() => []);
      offeredByAdapter.set(adapterType, models.some((model) => model.id === chosenModel));
    }
  }
  // A person looks after one agent at a time: when the new steward already
  // looks after one, no agent can go to them; otherwise only the first
  // eligible agent of the selection can.
  const targetBusyWith = new Map<string, string>();
  if (transferTo) {
    const [held] = await db
      .select({ agentId: agentStewardships.agentId, name: agents.name })
      .from(agentStewardships)
      .innerJoin(agents, eq(agents.id, agentStewardships.agentId))
      .where(and(eq(agentStewardships.companyId, companyId), eq(agentStewardships.userId, transferTo), isNull(agentStewardships.endedAt)));
    const byId = new Map(shown.map((row) => [row.id, row]));
    let firstTaken: string | null = held ? (visible === null || visible.has(held.agentId) ? held.name : "another agent") : null;
    for (const id of wanted) {
      const row = byId.get(id);
      if (!row || UNMANAGEABLE.has(row.status)) continue;
      const steward = stewardByAgent.get(row.id) ?? null;
      if (!steward || steward === transferTo) continue;
      if (firstTaken) targetBusyWith.set(row.id, firstTaken);
      else firstTaken = row.name;
    }
  }
  return new Map(shown.map((row) => [row.id, {
    entityType: "agent",
    entityId: row.id,
    label: row.name,
    companyId,
    status: row.status,
    adapterType: row.adapterType,
    model: modelOf(row.adapterConfig),
    stewardUserId: stewardByAgent.get(row.id) ?? null,
    ...(chosenModel ? { modelOffered: offeredByAdapter.get(row.adapterType) ?? false } : {}),
    ...(transferTo ? { targetBusyWith: targetBusyWith.get(row.id) ?? null } : {}),
  }]));
}

function unmanageable(record: AgentRecord) {
  return {
    reasonCode: BATCH_REASON_CODES.agentNotManageable,
    reason: record.status === "terminated"
      ? `${record.label} has been removed, so it was left out.`
      : `${record.label} is not set up yet, so it was left out.`,
  };
}

function pauseKind(key: "agent.pause" | "agent.resume"): BatchKind<AgentPauseResumeBatchChange, AgentRecord> {
  const pausing = key === "agent.pause";
  return {
    key,
    entityType: "agent",
    noun: "agent",
    maxPerBatch: BATCH_MAX_RECORDS_UI,
    parseChange: (input) => agentPauseResumeBatchChangeSchema.parse(input),
    previewGuard: requireAgentManagement,
    load: (ctx, ids) => loadAgents(ctx, ids),
    describe(record) {
      const state = record.status === "paused" ? "paused" : "active";
      const before = { state };
      const after = { state: pausing ? "paused" : "active" };
      if (before.state === after.state) return { before, after, noop: true };
      if (UNMANAGEABLE.has(record.status)) return { before, after, noop: false, notDecidable: unmanageable(record) };
      const notes = pausing
        ? [record.status === "running" ? "Pausing stops the work it is doing now." : "Pausing stops it from starting new work."]
        : ["Resuming may start work now."];
      return { before, after, noop: false, notes };
    },
    observe: (record) => ({ state: record.status === "paused" ? "paused" : "active" }),
    request: (record) => ({ method: "POST", path: `/api/agents/${record.entityId}/${pausing ? "pause" : "resume"}`, body: {} }),
  };
}

export const agentPauseBatchKind = pauseKind("agent.pause");
export const agentResumeBatchKind = pauseKind("agent.resume");

export const agentSetModelBatchKind: BatchKind<AgentSetModelBatchChange, AgentRecord> = {
  key: "agent.set_model",
  entityType: "agent",
  noun: "agent",
  maxPerBatch: BATCH_MAX_RECORDS_UI,
  parseChange: (input) => agentSetModelBatchChangeSchema.parse(input),
  previewGuard: requireAgentManagement,
  load: (ctx, ids, change) => loadAgents(ctx, ids, change?.model),
  describe(record, change) {
    const before = { model: record.model };
    const after = { model: change.model };
    if (record.model === change.model) return { before, after, noop: true };
    if (UNMANAGEABLE.has(record.status)) return { before, after, noop: false, notDecidable: unmanageable(record) };
    if (!record.modelOffered) {
      return {
        before, after, noop: false,
        notDecidable: { reasonCode: BATCH_REASON_CODES.modelNotOffered, reason: `${record.label} runs on a runtime that does not offer ${change.model}, so it was left out.` },
      };
    }
    return { before, after, noop: false, notes: ["Its next run uses the new model."] };
  },
  observe: (record) => ({ model: record.model }),
  // Only the model: the route merges it into the agent's adapter
  // configuration and leaves everything else there as it was.
  request: (record, change) => ({ method: "PATCH", path: `/api/agents/${record.entityId}`, body: { adapterConfig: { model: change.model } } }),
};

export const agentTransferStewardBatchKind: BatchKind<AgentTransferStewardBatchChange, AgentRecord> = {
  key: "agent.transfer_steward",
  entityType: "agent",
  noun: "agent",
  maxPerBatch: BATCH_MAX_RECORDS_UI,
  parseChange: (input) => agentTransferStewardBatchChangeSchema.parse(input),
  previewGuard: requireAgentManagement,
  load: (ctx, ids, change) => loadAgents(ctx, ids, undefined, change?.userId),
  describe(record, change) {
    const before = { stewardUserId: record.stewardUserId };
    const after = { stewardUserId: change.userId };
    if (record.stewardUserId === change.userId) return { before, after, noop: true };
    if (UNMANAGEABLE.has(record.status)) return { before, after, noop: false, notDecidable: unmanageable(record) };
    if (!record.stewardUserId) {
      return {
        before, after, noop: false,
        notDecidable: { reasonCode: BATCH_REASON_CODES.noStewardToTransfer, reason: `${record.label} has no steward to hand over, so it was left out.` },
      };
    }
    if (record.targetBusyWith) {
      return {
        before, after, noop: false,
        notDecidable: {
          reasonCode: BATCH_REASON_CODES.stewardAlreadyBusy,
          reason: `A person looks after one agent at a time, and the new steward would already look after ${record.targetBusyWith}, so ${record.label} was left out.`,
        },
      };
    }
    return { before, after, noop: false, notes: ["The new steward takes over its decisions and its inbox; the old one stops receiving them."] };
  },
  observe: (record) => ({ stewardUserId: record.stewardUserId }),
  request: (record, change) => ({
    method: "POST",
    path: `/api/companies/${record.companyId}/agents/${record.entityId}/stewardship/transfer`,
    body: { userId: change.userId, transferReason: change.transferReason },
  }),
};
