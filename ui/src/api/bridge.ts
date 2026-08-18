import { api } from "./client";

/**
 * The bridge: how an agent reaches the person who looks after it.
 *
 * Nothing in the UI called these routes before. Enrolment existed only as an
 * operator running a seed script against `bridgeService`, which meant the one
 * promise the product makes to an individual — "when only you can answer, the
 * question arrives where you already work" — could not be taken up by that
 * person at all.
 */

export interface BridgeEndpoint {
  id: string;
  label: string;
  capabilities: string[];
  /** Null until the enrolment is approved. */
  enrolledAt: string | null;
  lastSeenAt: string | null;
  pendingApproval: boolean;
}

/**
 * `bridge:read` answers a question; `bridge:act` changes something on the
 * machine. Enrolling a laptop so its owner can be asked things needs only the
 * first, and an endpoint that can act is gated behind an approval on every task.
 * The UI never requests `act` — widening that is a deliberate decision someone
 * should make explicitly, not a default that arrived with a checkbox.
 */
export const BRIDGE_READ = "bridge:read";

export const bridgeApi = {
  listMyEndpoints: (companyId: string) =>
    api.get<{ endpoints: BridgeEndpoint[] }>(`/companies/${companyId}/me/bridge/endpoints`),

  /** Inert until approved — this mints no usable credential on its own. */
  requestEnrollment: (companyId: string, label: string) =>
    api.post<{ enrollmentId: string; pendingApproval: true }>(
      `/companies/${companyId}/me/bridge/endpoints`,
      { label, capabilities: [BRIDGE_READ] },
    ),

  /**
   * Approve an enrolment and mint the token. The token is in this response and
   * nowhere else, ever — there is no route that will show it again.
   */
  approve: (companyId: string, endpointId: string) =>
    api.post<{ endpointId: string; token: string }>(
      `/companies/${companyId}/bridge/endpoints/${endpointId}/approve`,
      {},
    ),

  revoke: (companyId: string, endpointId: string) =>
    api.post<unknown>(`/companies/${companyId}/bridge/endpoints/${endpointId}/revoke`, {}),
};
