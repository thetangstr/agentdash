import type { AgentVisibility, CompanyProductProfile, CompanyStatus, PauseReason } from "../constants.js";

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  productProfile: CompanyProductProfile;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number | null;
  spentMonthlyCents: number | null;
  attachmentMaxBytes: number;
  requireBoardApprovalForNewAgents: boolean;
  /** AgentDash: new issues with no status given start as `todo` instead of `backlog`. */
  newIssuesStartAsTodo: boolean;
  /**
   * Agent visibility (2026-09-30): what an agent with no visibility of its own
   * resolves to. 'company' is the default and today's behaviour.
   */
  agentVisibilityDefault?: AgentVisibility;
  /** AgentDash admin powers: admins may read agent directives (off by default). */
  adminDirectiveReadEnabled?: boolean;
  /** AgentDash admin powers: admins may read run transcripts when document access is on (off by default). */
  adminTranscriptReadEnabled?: boolean;
  /** AgentDash admin powers: an admin's own Claude may prepare batch changes (off by default). */
  assistantAdminBatchesEnabled?: boolean;
  /** AgentDash admin powers: most records one batch from an admin's Claude may hold (1 to 200, default 50). */
  assistantBatchMaxRecords?: number;
  /** AgentDash admin powers: the ceiling template every new agent starts with, or none. */
  defaultCeilingTemplateId?: string | null;
  feedbackDataSharingEnabled: boolean;
  feedbackDataSharingConsentAt: Date | null;
  feedbackDataSharingConsentByUserId: string | null;
  feedbackDataSharingTermsVersion: string | null;
  brandColor: string | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}
