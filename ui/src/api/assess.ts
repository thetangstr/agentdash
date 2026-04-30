// AgentDash: Assess API client
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
};
