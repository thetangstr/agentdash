import type { OtaApproval, OtaUpdateStatus } from "@paperclipai/shared";
import { api } from "./client";

/**
 * Instance updates.
 *
 * There is no `apply` here, and that is not an omission. The board records that
 * a human approved a specific release; a separate privileged process observes
 * that record and performs the update. Nothing the browser can call restarts
 * this server.
 */
export const otaApi = {
  getStatus: () => api.get<OtaUpdateStatus>("/instance/ota/status"),

  /** Ask to update to a specific release. Creates a pending approval. */
  requestApproval: (input: { tag: string; commit: string }) =>
    api.post<{ approval: OtaApproval }>("/instance/ota/approvals", input),

  /** Confirm or reject. The server stamps the compatibility verdict it saw. */
  decide: (approvalId: string, decision: "approved" | "rejected") =>
    api.post<{ approval: OtaApproval }>(`/instance/ota/approvals/${approvalId}/decision`, {
      decision,
    }),

  withdraw: (approvalId: string) =>
    api.delete<{ withdrawn: boolean; approvalId: string }>(`/instance/ota/approvals/${approvalId}`),
};
