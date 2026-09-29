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
}
