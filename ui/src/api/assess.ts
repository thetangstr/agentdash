// AgentDash: Assess API client
import { api } from "./client";

export interface ResearchResult {
  companyName: string;
  suggestedIndustry: string;
  summary: string;
  webContent: string;
  allIndustries: string[];
}

export interface InterviewResponse {
  question: string;
  options: string[];
  insights: Array<{ label: string; value: string; icon: string }>;
  clarityScore: number;
  done: boolean;
  thinkingSummary?: string;
}

export interface StoredAssessment {
  markdown: string;
  jumpstart: string | null;
  assessmentInput: Record<string, unknown> | null;
}

export const assessApi = {
  research: (companyId: string, companyUrl: string, companyName: string) =>
    api.post<ResearchResult>(`/companies/${companyId}/assess/research`, { companyUrl, companyName }),

  interview: (companyId: string, body: {
    conversationHistory: Array<{ role: "assistant" | "user"; content: string }>;
    companyWebContent?: string;
    industry: string;
    industrySlug: string;
    formSummary: string;
    selectedFunctions: string[];
  }) => api.post<InterviewResponse>(`/companies/${companyId}/assess/interview`, body),

  runAssessment: async (companyId: string, body: Record<string, unknown>): Promise<ReadableStream<Uint8Array>> => {
    const res = await fetch(`/api/companies/${companyId}/assess`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Assessment failed: ${res.status}`);
    return res.body!;
  },

  getAssessment: (companyId: string) =>
    api.get<StoredAssessment>(`/companies/${companyId}/assess`),
};
