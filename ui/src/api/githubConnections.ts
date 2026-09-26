// AgentDash (GH #782): GitHub repo connections. The token is write-only: it is
// sent once in `connect` and never comes back.
import type { GitHubConnectionsResponse, GitHubRepoConnection } from "@paperclipai/shared";
import { api } from "./client";

export interface ConnectGitHubInput {
  repoUrl: string;
  githubToken: string;
  projectId?: string;
}

export interface ConnectGitHubResponse {
  connection: GitHubRepoConnection;
  projectCreated: boolean;
}

/** GitHub's page for creating a fine-grained personal access token. */
export const GITHUB_FINE_GRAINED_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

export const githubConnectionsApi = {
  list: (companyId: string) => api.get<GitHubConnectionsResponse>(`/companies/${companyId}/github-connections`),
  connect: (companyId: string, input: ConnectGitHubInput) =>
    api.put<ConnectGitHubResponse>(`/companies/${companyId}/github-connections`, input),
  disconnect: (companyId: string, connectionId: string) =>
    api.delete<{ ok: true; id: string }>(`/companies/${companyId}/github-connections/${connectionId}`),
};
