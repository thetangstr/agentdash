import type { CompanyStatus, PauseReason } from "../constants.js";

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  requireBoardApprovalForNewAgents: boolean;
  feedbackDataSharingEnabled: boolean;
  feedbackDataSharingConsentAt: Date | null;
  feedbackDataSharingConsentByUserId: string | null;
  feedbackDataSharingTermsVersion: string | null;
  brandColor: string | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  // AgentDash (AGE-55): FRE Plan B — bare lowercased corp domain (e.g.
  // `acme.com`) or full lowercased free-mail address (e.g.
  // `me@gmail.com`). NULL on grandfathered rows. See
  // `deriveCompanyEmailDomain` in `@agentdash/shared`.
  emailDomain: string | null;
  createdAt: Date;
  updatedAt: Date;
}
