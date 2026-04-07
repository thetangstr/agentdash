import type { Db } from "@agentdash/db";

// AgentDash: Pipeline orchestrator service stub
export function pipelineOrchestratorService(db: Db) {
  return {
    async onStageCompleted(companyId: string, issueId: string) {},
  };
}
