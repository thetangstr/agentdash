import type { AgentDirectiveHistory } from "@paperclipai/shared";
import { api } from "./client";

/**
 * AgentDash-MK: an agent's directives (its steward's own words to it). The
 * server answers the active steward, and an owner or admin when the company
 * switched "admins can read agent directives" on (each such read is
 * recorded); everyone else gets 403, and companies without the feature 404.
 */
export const agentDirectivesApi = {
  history: (companyId: string, agentId: string) =>
    api.get<AgentDirectiveHistory>(`/companies/${companyId}/agents/${agentId}/directives`),
};
