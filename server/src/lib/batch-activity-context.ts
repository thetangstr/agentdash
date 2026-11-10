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
 * Modelled on lib/request-actor-source.ts.
 */
export interface BatchActivityContext {
  batchId: string;
  itemId: string;
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
    itemId: context.itemId,
    origin: context.origin,
    ...(context.grantId ? { grantId: context.grantId } : {}),
    ...(context.client ? { client: context.client } : {}),
  };
}
