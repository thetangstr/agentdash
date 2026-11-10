import { AsyncLocalStorage } from "node:async_hooks";
import type { BatchOrigin } from "@paperclipai/shared";

/**
 * AgentDash admin powers, part 2: which batch item the current request is.
 *
 * A batch item reaches the record's own single-record route, which writes its
 * own activity rows (for example `issue.updated`) without knowing it was part
 * of a batch. The auth middleware's `pcbx_` branch sets this context, and
 * `insertActivityWithRedaction` (the one choke point under `logActivity` and
 * `insertActivity`) merges `details.batch` into every row the request writes,
 * so no route is edited to say "this came from a batch".
 *
 * `details.batch` is only ever written from this context: outside it a
 * caller-supplied `batch` key is removed (a hand-posted activity row cannot
 * claim to come from a batch). The engine writes its own rows inside it too.
 *
 * Modelled on lib/request-actor-source.ts.
 */
export interface BatchActivityContext {
  batchId: string;
  /** Absent for rows about the whole batch (`batch.completed`, `batch.interrupted`). */
  itemId?: string | null;
  companyId: string;
  origin: BatchOrigin;
  grantId?: string | null;
  client?: string | null;
}

const storage = new AsyncLocalStorage<BatchActivityContext>();

export function currentBatchActivityContext(): BatchActivityContext | null {
  return storage.getStore() ?? null;
}

export function runWithBatchActivityContext<T>(context: BatchActivityContext, fn: () => T): T {
  return storage.run(Object.freeze({ ...context }), fn);
}

/** The `details.batch` value an activity row in this context carries. */
export function batchActivityDetails(context: BatchActivityContext): Record<string, unknown> {
  return {
    id: context.batchId,
    ...(context.itemId ? { itemId: context.itemId } : {}),
    origin: context.origin,
    ...(context.grantId ? { grantId: context.grantId } : {}),
    ...(context.client ? { client: context.client } : {}),
  };
}
