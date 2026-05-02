// AgentDash: Assess API client (company mode + project mode)
import { api } from "./client";

export interface ResearchResult {
  companyName: string;
  suggestedIndustry: string;
  summary: string;
  webContent: string;
  allIndustries: string[];
}

export interface StoredAssessment {
  markdown: string;
  jumpstart: string | null;
  assessmentInput: Record<string, unknown> | null;
}

// AgentDash: Project-mode types — slimmed to Step-1 basics only.
// Steps 2-4 of the old wizard were dropped; their territory is now covered by
// the adaptive 6-10 question clarify round.
export interface ProjectIntake {
  projectName: string;
  oneLineGoal: string;
  description: string;
  sponsor: string;
}

export interface ProjectClarifyQuestion {
  id: string;
  question: string;
  hint: string;
  options: string[];
}

export interface ProjectClarifyResponse {
  rephrased: string;
  questions: ProjectClarifyQuestion[];
}

export interface ProjectAnswer {
  questionId: string;
  text: string;
}

export interface ProjectAssessmentSummary {
  slug: string;
  projectName: string;
  createdAt: string;
}

export interface StoredProjectAssessment {
  markdown: string;
  input: Record<string, unknown> | null;
}

export const assessApi = {
  research: (companyId: string, companyUrl: string, companyName: string) =>
    api.post<ResearchResult>(`/companies/${companyId}/assess/research`, { companyUrl, companyName }),

  runAssessment: async (companyId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> => {
    const res = await fetch(`/api/companies/${companyId}/assess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(errBody.error ?? `Assessment failed: ${res.status}`);
    }
    return res.body!;
  },

  getAssessment: (companyId: string) =>
    api.get<StoredAssessment>(`/companies/${companyId}/assess`),

  // ── AgentDash: Project-mode endpoints ───────────────────────────────────
  generateProjectClarify: (companyId: string, intake: ProjectIntake) =>
    api.post<ProjectClarifyResponse>(`/companies/${companyId}/assess/project/clarify`, { intake }),

  generateProjectFollowUp: (companyId: string, body: { intake: ProjectIntake; answers: ProjectAnswer[]; rephrased: string }) =>
    api.post<ProjectClarifyResponse>(`/companies/${companyId}/assess/project/followup`, body),

  runProjectAssessment: async (
    companyId: string,
    body: { intake: ProjectIntake; answers: ProjectAnswer[]; rephrased: string },
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> => {
    const res = await fetch(`/api/companies/${companyId}/assess/project/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(errBody.error ?? `Project assessment failed: ${res.status}`);
    }
    return res.body!;
  },

  downloadProjectDocx: async (
    companyId: string,
    body: { markdown: string; projectName: string; companyName: string },
  ): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch(`/api/companies/${companyId}/assess/project/docx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "include",
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(errBody.error ?? `Docx generation failed: ${res.status}`);
    }
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = /filename="?([^";]+)"?/.exec(disposition);
    const filename = match?.[1] ?? `${body.companyName} — ${body.projectName}.docx`;
    const blob = await res.blob();
    return { blob, filename };
  },

  listProjects: (companyId: string) =>
    api.get<ProjectAssessmentSummary[]>(`/companies/${companyId}/assess/project/list`),

  getProject: (companyId: string, slug: string) =>
    api.get<StoredProjectAssessment>(`/companies/${companyId}/assess/project/${encodeURIComponent(slug)}`),
};
