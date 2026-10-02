// AgentDash (GH #786): the hosted first run.
import { api } from "./client";

export type FirstRunStep = "model" | "repo" | "first_issue" | "done";

export interface FirstRunStatus {
  applies: boolean;
  /** Home shows the first-run nudges: hosted box, and a new company or one with no issues. */
  showHomeNudge: boolean;
  nextStep: FirstRunStep;
  canManage: boolean;
  /** The model key is an instance setting: only the instance admin can set it. */
  canConfigureModel: boolean;
  model: { required: boolean; done: boolean };
  repo: {
    done: boolean;
    repo: string | null;
    projectId: string | null;
    /** Work shipped with no repo connected: the company works without code. */
    shippedWithoutRepo?: boolean;
  };
  firstIssue: {
    done: boolean;
    issueId: string | null;
    identifier: string | null;
    title: string | null;
    status: string | null;
    assigneeAgentId: string | null;
    assigneeName: string | null;
  };
  suggestions: string[];
}

export interface CreateFirstIssueResponse {
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    projectId: string | null;
    assigneeAgentId: string | null;
  };
  created: boolean;
  hiredAgentId: string | null;
}

export const firstRunApi = {
  status: (companyId: string) => api.get<FirstRunStatus>(`/companies/${companyId}/first-run`),
  createFirstIssue: (companyId: string, title: string) =>
    api.post<CreateFirstIssueResponse>(`/companies/${companyId}/first-run/first-issue`, { title }),
};
