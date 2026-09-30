import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

/**
 * AgentDash (recovery budget follow-up to #848): which credential the current
 * HTTP request authenticated with, readable from code the request reaches
 * without threading it through every call.
 *
 * `getActorInfo` reports an assistant-grant caller as actorType "user" — the
 * person stays the actor for attribution — so a wake queued from an assistant
 * client's comment is indistinguishable from one a person queued by hand. The
 * exhausted recovery budget must tell them apart (an assistant is automation,
 * not remediation; see `isHumanBoardActor` in routes/issues.ts). Every wake
 * call site passes `requestedByActorType: actor.actorType`; rather than add a
 * second field to each, `heartbeat.wakeup` reads the source from here at the
 * moment the wake is requested and records it on the run's context.
 */
type RequestActorSourceStore = { source: string | null };

const storage = new AsyncLocalStorage<RequestActorSourceStore>();

export function currentRequestActorSource(): string | null {
  return storage.getStore()?.source ?? null;
}

export function runWithRequestActorSource<T>(source: string | null, fn: () => T): T {
  return storage.run({ source }, fn);
}

/** Mount after the actor middleware so `req.actor` is already resolved. */
export function requestActorSourceMiddleware(): RequestHandler {
  return (req, _res, next) => {
    const source = typeof req.actor?.source === "string" ? req.actor.source : null;
    storage.run({ source }, () => next());
  };
}
