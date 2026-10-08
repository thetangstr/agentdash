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
