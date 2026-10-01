// AgentDash: pinned workforce roles describe work; they never grant authority.
export interface WorkforceTemplate {
  id: string; version: 1; name: string; description: string;
  responsibilities: string[]; requiredFactKeys: string[]; procedures: string[];
  skills: { key: string; name: string; description: string; content: string }[];
  qualityChecks: string[]; suggestedMetrics: string[];
  starterJob: { title: string; description: string };
}
export interface WorkforceBrief {
  revision: number;
  sources: { id: string; label: string; content: string }[];
  facts: { key: string; value: string; sourceReference: string }[];
  confirmedByUserId: string | null; updatedAt: string | null;
}
export interface WorkforceEnrollment {
  id: string; companyId: string; agentId: string; templateId: string; templateVersion: number;
  objective: string | null; metrics: string[]; goalId: string | null;
  learnedBriefRevision: number | null; firstJobIssueId: string | null;
  installedSkillKeys: string[]; skillInstallError: string | null;
  createdAt: Date | string; updatedAt: Date | string;
}
export interface WorkforceReadiness {
  phase: 'learning' | 'needs_input' | 'working' | 'awaiting_review' | 'ready' | 'refresh_needed';
  missingFactKeys: string[]; pendingQuestionIds: string[]; firstJobIssueId: string | null;
  acceptedVerdictId: string | null; briefRevision: number; learnedBriefRevision: number | null; reason: string;
}
export interface WorkforceRuntimeContext {
  template: WorkforceTemplate; enrollment: WorkforceEnrollment; brief: WorkforceBrief;
  readiness: WorkforceReadiness; sourceUrl: string;
  taskFacts: { companyFactKey?: string; key: string; value: string; issueId: string; sourceReference: string }[];
}

// Native prompt paths verified on both initial and resumed turns. Custom
// process/HTTP/plugin runners need an explicit prompt integration before use.
export const WORKFORCE_PROMPT_ADAPTER_TYPES = ['claude_local', 'codex_local', 'gemini_local', 'cursor', 'opencode_local', 'pi_local', 'acpx_local', 'openclaw_gateway', 'hermes_local'] as const;
export function supportsWorkforcePrompt(adapterType: string): boolean {
  return (WORKFORCE_PROMPT_ADAPTER_TYPES as readonly string[]).includes(adapterType);
}

export interface WorkforceFactProposal {
  id: string; companyId: string; agentId: string;
  status: 'proposed' | 'approved' | 'rejected'; briefRevision: number;
  facts: WorkforceBrief['facts']; sourceReferences: string[];
  sources: WorkforceBrief['sources']; createdAt: string;
  reviewedByUserId: string | null; reviewedAt: string | null;
}
