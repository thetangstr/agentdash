// AgentDash (GH #782): a GitHub repository connected to a project workspace.
// Returned by GET/PUT /api/companies/:companyId/github-connections. Never
// carries the credential: a pasted token is write-only.

/** Where the credential for a connection comes from. "github_app" is GH #797. */
export const GITHUB_CREDENTIAL_SOURCES = ["pat", "github_app"] as const;
export type GitHubCredentialSource = (typeof GITHUB_CREDENTIAL_SOURCES)[number];

export interface GitHubRepoConnection {
  id: string;
  companyId: string;
  projectId: string;
  projectName: string | null;
  projectWorkspaceId: string;
  /** `owner/name` as GitHub spells it. */
  repo: string;
  repoUrl: string;
  defaultBranch: string | null;
  credentialSource: GitHubCredentialSource;
  /** False when the stored credential is gone (for example the secret was deleted). */
  credentialPresent: boolean;
  validatedAt: string | null;
  connectedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubConnectionsResponse {
  connections: GitHubRepoConnection[];
  /** True when the caller may connect, rotate or disconnect (instance admin, company owner or admin). */
  canManage: boolean;
}
