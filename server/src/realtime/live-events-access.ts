// AgentDash (GH #708): access-change signals for the live-events websocket.
//
// Authorization of a live-events socket happens at the upgrade. When a
// principal loses access afterwards (membership archived or downgraded, agent
// key revoked, agent terminated or deleted, session signed out) the mutation
// publishes a change here, and the websocket server re-authorizes the matching
// sockets at once and closes those that no longer pass (1008).
//
// In-process only, like the live-event bus itself (services/live-events.ts):
// a change made in one server process does not reach sockets held by another.
// Those sockets are still caught by the periodic re-authorization on the
// websocket heartbeat (see live-events-ws.ts), so the worst case across
// processes is one heartbeat interval rather than the socket's lifetime.
import { logger } from "../middleware/logger.js";

export type LiveEventAccessChange =
  /** A user's access changed. No companyId means every company (instance-admin demotion, session revocation). */
  | { kind: "user"; userId: string; companyId?: string | null; reason: string }
  /** An agent's access changed (key revoked, terminated, deleted). */
  | { kind: "agent"; agentId: string; companyId?: string | null; reason: string }
  /** Everything in a company changed (company deleted). */
  | { kind: "company"; companyId: string; reason: string };

type Listener = (change: LiveEventAccessChange) => void;

const listeners = new Set<Listener>();

export function subscribeLiveEventAccessChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: how many websocket servers are listening (0 once they have all closed). */
export function liveEventAccessListenerCount(): number {
  return listeners.size;
}

/**
 * Publish after the mutation has committed: listeners re-read the database, and
 * a change still inside an open transaction would look unchanged to them.
 * Never throws; a listener failure is logged.
 */
export function publishLiveEventAccessChange(change: LiveEventAccessChange): void {
  for (const listener of listeners) {
    try {
      listener(change);
    } catch (err) {
      logger.warn({ err, change }, "live event access-change listener failed");
    }
  }
}

/** A membership row changed: route it to the user or agent principal it belongs to. */
export function publishMembershipAccessChange(
  membership: { companyId: string; principalType: string; principalId: string } | null | undefined,
  reason: string,
): void {
  if (!membership) return;
  if (membership.principalType === "agent") {
    publishLiveEventAccessChange({ kind: "agent", agentId: membership.principalId, companyId: membership.companyId, reason });
    return;
  }
  publishLiveEventAccessChange({ kind: "user", userId: membership.principalId, companyId: membership.companyId, reason });
}
