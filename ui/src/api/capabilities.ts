import { api } from "./client";

/**
 * What the signed-in person may do in a company, as decided by the server.
 *
 * The client deliberately has no logic of its own here. Every boolean is
 * computed server-side by the same predicate the enforcing route uses, so a
 * component asking `direction:set` gets exactly the answer that a PATCH would
 * have produced. Re-deriving any of this in the browser would guarantee the two
 * disagree eventually, and the disagreement always surfaces as either a control
 * that 403s or a missing control that should have been there.
 */
export type CapabilityKey =
  | "direction:set"
  | "agents:create"
  | "users:invite"
  | "users:manage_permissions"
  | "tasks:assign";

export interface Capabilities {
  companyId: string;
  actorType: string;
  membershipRole: string | null;
  isInstanceAdmin: boolean;
  capabilities: Record<CapabilityKey, boolean>;
  /**
   * Workspace features, decided by the same server predicate that gates their
   * routes. `null` means the server could not tell; absent on older servers.
   * Either way the UI falls back to asking the gated route.
   */
  features?: {
    stewardship: boolean | null;
  };
}

export const capabilitiesApi = {
  get: (companyId: string) =>
    api.get<Capabilities>(`/me/capabilities?companyId=${encodeURIComponent(companyId)}`),
};
