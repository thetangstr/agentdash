import type { Db } from "@agentdash/db";
import type { SkillVerification } from "@agentdash/shared";

// AgentDash: Skill selection types and service
export interface SkillDescriptor {
  id: string;
  key: string;
  name: string;
  description?: string;
  whenToUse?: string;
  instructions?: string;
  allowedTools: string[];
  executionContext: string;
  // AgentDash: smart model routing fields from skill_versions
  modelTier: string | null;
  maxToolCalls: number | null;
  verification: SkillVerification | null;
}

export interface SelectedSkillForRun {
  skill: SkillDescriptor;
  required: boolean;
  selectionReason: string;
}

export function skillSelectionService(db: Db) {
  return {
    async selectForRun(_params: {
      companyId: string;
      agentId: string;
      issueId: string | null;
      projectWorkspaceId: string | null;
      executionWorkspaceId: string | null;
      cwd: string;
    }): Promise<SelectedSkillForRun[]> {
      return [];
    },
  };
}
