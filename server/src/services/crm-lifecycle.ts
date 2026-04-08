import type { Db } from "@agentdash/db";

// AgentDash: CRM lifecycle service stub
export function crmLifecycleService(db: Db) {
  return {
    async onIssueCompleted(
      companyId: string,
      issueId: string,
      opts?: { agentId?: string | null },
    ): Promise<void> {},
    async onIssueCompletedForAccount(
      companyId: string,
      issueId: string,
      crmAccountId: string,
      opts?: { agentId?: string | null },
    ): Promise<void> {},
    async onActionProposalResolved(
      companyId: string,
      details: Record<string, unknown>,
    ): Promise<void> {},
  };
}
