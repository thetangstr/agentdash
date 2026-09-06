import type {
  Company,
  CompanyPortabilityExportRequest,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityExportResult,
  CompanyPortabilityImportRequest,
  CompanyPortabilityImportResult,
  CompanyPortabilityPreviewRequest,
  CompanyPortabilityPreviewResult,
  UpdateCompanyBranding,
} from "@paperclipai/shared";
import { api } from "./client";

export type CompanyStats = Record<
  string,
  {
    agentCount: number;
    issueCount: number;
    /** Runs that exited zero. Not the same claim as "work happened". */
    runsSucceeded: number;
    /** Of those, the ones that left no comment and no activity behind. */
    runsSucceededWithoutEvidence: number;
  }
>;

export const companiesApi = {
  list: () => api.get<Company[]>("/companies"),
  get: (companyId: string) => api.get<Company>(`/companies/${companyId}`),
  stats: () => api.get<CompanyStats>("/companies/stats"),
  create: (
    data: {
      name: string;
      description?: string | null;
      budgetMonthlyCents?: number;
      /**
       * Only ever sent together with `inviteCode`: the server refuses a
       * non-default profile that arrives without a valid code, and treats a
       * code with no profile as nothing at all.
       */
      productProfile?: "default" | "agentdash_mk";
      inviteCode?: string;
    },
    options?: { fromSignup?: boolean },
  ) =>
    api.post<Company>(
      options?.fromSignup ? "/companies?fromSignup=1" : "/companies",
      data,
    ),
  update: (
    companyId: string,
    data: Partial<
      Pick<
        Company,
        | "name"
        | "description"
        | "status"
        | "budgetMonthlyCents"
        | "attachmentMaxBytes"
        | "requireBoardApprovalForNewAgents"
        | "feedbackDataSharingEnabled"
        | "brandColor"
        | "logoAssetId"
      >
    >,
  ) => api.patch<Company>(`/companies/${companyId}`, data),
  updateBranding: (companyId: string, data: UpdateCompanyBranding) =>
    api.patch<Company>(`/companies/${companyId}/branding`, data),
  archive: (companyId: string) => api.post<Company>(`/companies/${companyId}/archive`, {}),
  remove: (companyId: string) => api.delete<{ ok: true }>(`/companies/${companyId}`),
  exportBundle: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportResult>(`/companies/${companyId}/exports`, data),
  exportPreview: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportPreviewResult>(`/companies/${companyId}/exports/preview`, data),
  importPreview: (data: CompanyPortabilityPreviewRequest) =>
    api.post<CompanyPortabilityPreviewResult>("/companies/import/preview", data),
  importBundle: (data: CompanyPortabilityImportRequest) =>
    api.post<CompanyPortabilityImportResult>("/companies/import", data),
};
