import { api } from "./client";

export type IssueReportKind = "bug" | "feature";

export type IssueReportConfig = {
  /** False when the instance has no GitHub credential — the UI hides the button. */
  enabled: boolean;
  /** "owner/repo", so the dialog can tell people where their report lands. */
  repo: string | null;
};

export type CreatedIssueReport = {
  number: number;
  url: string;
};

export type IssueReportInput = {
  kind: IssueReportKind;
  title: string;
  description: string;
  companyId?: string;
  pageUrl?: string;
};

export const issueReportsApi = {
  getConfig: () => api.get<IssueReportConfig>("/issue-reports/config"),
  create: (input: IssueReportInput) => api.post<CreatedIssueReport>("/issue-reports", input),
};
