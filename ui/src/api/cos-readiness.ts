// AgentDash (AGE-50 Phase 1): UI client for the CoS readiness precondition.
// Mirrors `CosReadiness` from server/src/services/cos-readiness.ts.

import { api } from "./client";

export interface CosReadiness {
  ready: boolean;
  hasChiefOfStaff: boolean;
  hasLlmAdapter: boolean;
  reasons: string[];
  chiefOfStaffAgentId: string | null;
}

export const cosReadinessApi = {
  get: (companyId: string) =>
    api.get<CosReadiness>(`/companies/${companyId}/cos-readiness`),
};
