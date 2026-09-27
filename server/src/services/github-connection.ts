// AgentDash (GH #782): connect a GitHub repository to a project workspace with
// a fine-grained personal access token, so agents on a hosted box can clone,
// push a branch and open a pull request.
//
// Model:
//   project ── project_workspaces (git_repo, repoUrl https://github.com/o/r,
//              no local cwd, so the run path makes a managed checkout)
//          └── github_repo_connections (which repo, which credential source)
//                 └── company_secrets (the token, encrypted; "pat" source only)
//
// The credential source is the one seam GH #797 (GitHub App) changes: add a
// "github_app" entry to CREDENTIAL_SOURCES that mints an installation token
// from connection.githubAppInstallationId. Nothing else reads the token:
// the clone path and the agent credential endpoint both go through
// resolveConnectionToken().
//
// The token is validated against GitHub before anything is saved, is never
// returned, logged or put in an activity entry, and error messages never quote
// it or GitHub's response body.

import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { githubRepoConnections, heartbeatRuns, issues, projects, projectWorkspaces } from "@paperclipai/db";
import {
  SECRET_PROVIDERS,
  type GitHubCredentialSource,
  type GitHubRepoConnection,
  type SecretProvider,
} from "@paperclipai/shared";
import { badRequest, HttpError, notFound } from "../errors.js";
import { GITHUB_HOST, GITHUB_HTTPS_PREFIX } from "./git-credential-helper.js";
import { projectService } from "./projects.js";
import { secretService } from "./secrets.js";

// ---------------------------------------------------------------------------
// Repo references
// ---------------------------------------------------------------------------

export interface GitHubRepoRef {
  owner: string;
  name: string;
  /** Lower-cased `owner/name`, the match key. */
  key: string;
  /** Canonical https URL with no credentials and no `.git`. */
  url: string;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

function repoRef(owner: string, name: string): GitHubRepoRef | null {
  const cleanName = name.replace(/\.git$/i, "");
  if (!OWNER_RE.test(owner) || !NAME_RE.test(cleanName) || cleanName === "." || cleanName === "..") return null;
  return {
    owner,
    name: cleanName,
    key: `${owner}/${cleanName}`.toLowerCase(),
    url: `${GITHUB_HTTPS_PREFIX}/${owner}/${cleanName}`,
  };
}

/**
 * Accepts `https://github.com/o/r(.git)`, `github.com/o/r`, `git@github.com:o/r.git`,
 * `ssh://git@github.com/o/r.git` and `o/r`. Refuses URLs that carry credentials
 * and any host but github.com.
 */
export function parseGitHubRepo(input: unknown): GitHubRepoRef | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw || raw.length > 300) return null;
  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)\/?$/i.exec(raw);
  if (scp) return repoRef(scp[1]!, scp[2]!);
  const short = /^([^/\s:@.]+)\/([^/\s:@]+)$/.exec(raw);
  if (short) return repoRef(short[1]!, short[2]!);
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== GITHUB_HOST || url.port) return null;
  if (!["https:", "http:", "ssh:"].includes(url.protocol)) return null;
  if (url.password || (url.username && url.username !== "git")) return null;
  if (url.search || url.hash) return null;
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) return null;
  return repoRef(parts[0]!, parts[1]!);
}

/** Normalise a `path=` from git's credential request (`o/r.git`, `/o/r`) to the match key. */
export function repoKeyFromCredentialPath(path: string | null): string | null {
  if (!path) return null;
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) return null;
  return repoRef(parts[0]!, parts[1]!)?.key ?? null;
}

// ---------------------------------------------------------------------------
// Token checks
// ---------------------------------------------------------------------------

/** Fine-grained PATs only. Classic tokens (ghp_) reach every repo the user can. */
const FINE_GRAINED_TOKEN_RE = /^github_pat_[A-Za-z0-9_]{20,255}$/;

export type GitHubConnectionErrorCode =
  | "github_token_not_fine_grained"
  | "github_token_rejected"
  | "github_repo_not_accessible"
  | "github_missing_contents_write"
  | "github_missing_pull_requests"
  | "github_repo_archived"
  | "github_rate_limited"
  | "github_unreachable"
  | "github_error";

export class GitHubConnectionError extends HttpError {
  declare code: GitHubConnectionErrorCode;
  constructor(status: number, code: GitHubConnectionErrorCode, message: string) {
    super(status, message, { code }, code);
    this.name = "GitHubConnectionError";
  }
}

export function assertFineGrainedToken(token: unknown): string {
  if (typeof token !== "string" || token.trim().length === 0) throw badRequest("githubToken required");
  const trimmed = token.trim();
  if (!FINE_GRAINED_TOKEN_RE.test(trimmed)) {
    throw new GitHubConnectionError(
      422,
      "github_token_not_fine_grained",
      "Use a fine-grained personal access token (it starts with github_pat_). Classic tokens can reach every " +
        "repository you can, and agents on this workspace can read the token.",
    );
  }
  return trimmed;
}

export interface GitHubConnectionDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/**
 * GitHub's API, or AGENTDASH_GITHUB_API_URL for a test stub. The override must
 * be https, or plain http to a loopback address; anything else is ignored so a
 * mistyped variable cannot send tokens over the network in the clear.
 */
export function githubApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fallback = "https://api.github.com";
  const configured = (env.AGENTDASH_GITHUB_API_URL ?? "").trim();
  if (!configured) return fallback;
  try {
    const url = new URL(configured);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return fallback;
  } catch {
    return fallback;
  }
  return configured.replace(/\/+$/, "");
}

export interface VerifiedGitHubRepo {
  owner: string;
  name: string;
  defaultBranch: string | null;
  private: boolean;
  /** Permission names only. */
  permissions: { contents: "write"; pullRequests: "read" };
}

async function githubGet(
  path: string,
  token: string,
  deps: GitHubConnectionDeps,
): Promise<{ status: number; json: unknown; rateLimited: boolean }> {
  const doFetch = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${githubApiBaseUrl(deps.env)}${path}`, {
      method: "GET",
      // Never follow a redirect with the token attached (GitHub answers a
      // renamed repo with 301; that is reported, not followed).
      redirect: "manual",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "AgentDash",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new GitHubConnectionError(
      502,
      "github_unreachable",
      "Could not reach GitHub to check the token. Check the workspace's network and try again.",
    );
  }
  if (response.status >= 300 && response.status < 400) {
    await response.arrayBuffer().catch(() => undefined);
    throw new GitHubConnectionError(
      422,
      "github_repo_not_accessible",
      "GitHub says this repository has moved or been renamed. Paste its current URL.",
    );
  }
  const rateLimited = response.headers.get("x-ratelimit-remaining") === "0";
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    return { status: response.status, json: null, rateLimited };
  }
  const json = await response.json().catch(() => null);
  return { status: response.status, json, rateLimited };
}

/**
 * Two read-only calls: the repository (existence, push permission, default
 * branch, archived) and its pull requests (Pull requests: Read). GitHub offers
 * no read-only probe for "Pull requests: Read and write"; a token without it
 * fails on the agent's first `gh pr create` with GitHub's own message.
 */
export async function verifyGitHubToken(
  repo: GitHubRepoRef,
  token: string,
  deps: GitHubConnectionDeps = {},
): Promise<VerifiedGitHubRepo> {
  const label = `${repo.owner}/${repo.name}`;
  const repoPath = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const repoRes = await githubGet(repoPath, token, deps);
  if (repoRes.status === 401) {
    throw new GitHubConnectionError(
      422,
      "github_token_rejected",
      "GitHub rejected this token. It may be mistyped, expired or revoked.",
    );
  }
  if (repoRes.rateLimited && (repoRes.status === 403 || repoRes.status === 429)) {
    throw new GitHubConnectionError(502, "github_rate_limited", "GitHub is rate-limiting this token. Try again in a few minutes.");
  }
  if (repoRes.status === 403 || repoRes.status === 404) {
    throw new GitHubConnectionError(
      422,
      "github_repo_not_accessible",
      `This token cannot see ${label}. When you create the token, choose "Only select repositories", pick ` +
        `${label}, and keep Metadata: Read.`,
    );
  }
  if (repoRes.status !== 200 || !repoRes.json || typeof repoRes.json !== "object") {
    throw new GitHubConnectionError(502, "github_error", `GitHub returned HTTP ${repoRes.status} while checking the token. Try again in a minute.`);
  }
  const body = repoRes.json as Record<string, unknown>;
  const permissions = (body.permissions && typeof body.permissions === "object" ? body.permissions : {}) as Record<string, unknown>;
  if (body.archived === true) {
    throw new GitHubConnectionError(422, "github_repo_archived", `${label} is archived on GitHub, so agents cannot push to it.`);
  }
  if (permissions.push !== true) {
    throw new GitHubConnectionError(
      422,
      "github_missing_contents_write",
      `The token can read ${label} but cannot push to it. Missing permission: Contents: Read and write.`,
    );
  }

  const pullsRes = await githubGet(`${repoPath}/pulls?per_page=1&state=all`, token, deps);
  if (pullsRes.status === 403 || pullsRes.status === 404) {
    throw new GitHubConnectionError(
      422,
      "github_missing_pull_requests",
      `The token cannot open pull requests on ${label}. Missing permission: Pull requests: Read and write.`,
    );
  }
  if (pullsRes.status !== 200) {
    throw new GitHubConnectionError(502, "github_error", `GitHub returned HTTP ${pullsRes.status} while checking the token. Try again in a minute.`);
  }

  const owner = body.owner && typeof body.owner === "object" ? (body.owner as Record<string, unknown>).login : null;
  return {
    owner: typeof owner === "string" && OWNER_RE.test(owner) ? owner : repo.owner,
    name: typeof body.name === "string" && NAME_RE.test(body.name) ? body.name : repo.name,
    defaultBranch: typeof body.default_branch === "string" && body.default_branch.length <= 255 ? body.default_branch : null,
    private: body.private === true,
    permissions: { contents: "write", pullRequests: "read" },
  };
}

// ---------------------------------------------------------------------------
// Credential sources (the GH #797 swap point)
// ---------------------------------------------------------------------------

type ConnectionRow = typeof githubRepoConnections.$inferSelect;

export interface GitHubCredentialSourceImpl {
  kind: GitHubCredentialSource;
  /** A token git can use for this connection's repo right now, or null. */
  resolveToken(connection: ConnectionRow): Promise<string | null>;
}

function patCredentialSource(db: Db): GitHubCredentialSourceImpl {
  const secrets = secretService(db);
  return {
    kind: "pat",
    async resolveToken(connection) {
      if (!connection.secretId) return null;
      try {
        return await secrets.resolveSecretValue(connection.companyId, connection.secretId, "latest");
      } catch {
        return null;
      }
    },
  };
}

/**
 * Registered sources. GH #797 adds "github_app" here (mint an installation
 * token from connection.githubAppInstallationId via the control plane).
 */
function credentialSources(db: Db): Partial<Record<GitHubCredentialSource, GitHubCredentialSourceImpl>> {
  return { pat: patCredentialSource(db) };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function githubTokenSecretName(projectWorkspaceId: string): string {
  return `github-token-${projectWorkspaceId}`;
}

function secretProvider(): SecretProvider {
  const configured = process.env.PAPERCLIP_SECRETS_PROVIDER;
  return (configured && SECRET_PROVIDERS.includes(configured as SecretProvider) ? configured : "local_encrypted") as SecretProvider;
}

export interface ConnectGitHubInput {
  repoUrl: unknown;
  token: unknown;
  projectId?: unknown;
}

export interface CredentialForRunInput {
  companyId: string;
  agentId: string;
  runId: string | null | undefined;
  protocol: string | null;
  host: string | null;
  path: string | null;
}

export function githubConnectionService(db: Db, deps: GitHubConnectionDeps = {}) {
  const secrets = secretService(db);
  const projectsSvc = projectService(db);

  async function toDto(row: ConnectionRow): Promise<GitHubRepoConnection> {
    const project = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, row.projectId))
      .then((rows) => rows[0] ?? null);
    const repo = `${row.repoOwner}/${row.repoName}`;
    return {
      id: row.id,
      companyId: row.companyId,
      projectId: row.projectId,
      projectName: project?.name ?? null,
      projectWorkspaceId: row.projectWorkspaceId,
      repo,
      repoUrl: `${GITHUB_HTTPS_PREFIX}/${repo}`,
      defaultBranch: row.defaultBranch,
      credentialSource: (row.credentialSource === "github_app" ? "github_app" : "pat") as GitHubCredentialSource,
      credentialPresent: row.credentialSource === "pat" ? Boolean(row.secretId) : Boolean(row.githubAppInstallationId),
      validatedAt: row.validatedAt ? row.validatedAt.toISOString() : null,
      connectedByUserId: row.connectedByUserId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function resolveConnectionToken(row: ConnectionRow): Promise<string | null> {
    const source = credentialSources(db)[row.credentialSource as GitHubCredentialSource];
    return source ? source.resolveToken(row) : null;
  }

  async function findProjectForConnect(companyId: string, projectId: unknown, repo: GitHubRepoRef) {
    if (projectId !== undefined && projectId !== null && projectId !== "") {
      if (typeof projectId !== "string") throw badRequest("projectId must be a string");
      const project = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!project) throw notFound("Project not found");
      return { project, created: false };
    }
    // Rotation: the repo is already connected somewhere in this company.
    const existing = await db
      .select()
      .from(githubRepoConnections)
      .where(and(eq(githubRepoConnections.companyId, companyId), eq(githubRepoConnections.repoFullName, repo.key)))
      .orderBy(asc(githubRepoConnections.createdAt))
      .then((rows) => rows[0] ?? null);
    if (existing) {
      const project = await db.select().from(projects).where(eq(projects.id, existing.projectId)).then((rows) => rows[0] ?? null);
      if (project) return { project, created: false };
    }
    // First run: the first live project, or a new one named after the repo.
    const first = await db
      .select()
      .from(projects)
      .where(and(eq(projects.companyId, companyId), isNull(projects.archivedAt)))
      .orderBy(asc(projects.createdAt))
      .then((rows) => rows[0] ?? null);
    if (first) return { project: first, created: false };
    const created = await projectsSvc.create(companyId, {
      name: repo.name,
      description: `Work on ${repo.owner}/${repo.name}.`,
      status: "in_progress",
    });
    const project = await db.select().from(projects).where(eq(projects.id, created.id)).then((rows) => rows[0]!);
    return { project, created: true };
  }

  async function findOrCreateWorkspace(
    project: typeof projects.$inferSelect,
    repo: GitHubRepoRef,
    defaultBranch: string | null,
  ) {
    const rows = await db
      .select()
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.companyId, project.companyId), eq(projectWorkspaces.projectId, project.id)))
      .orderBy(asc(projectWorkspaces.createdAt));
    const match = rows.find((row) => parseGitHubRepo(row.repoUrl)?.key === repo.key);
    if (match) {
      // Canonical URL (no credentials, https) so the managed checkout uses the helper.
      if (match.repoUrl !== repo.url || (!match.defaultRef && defaultBranch)) {
        await db
          .update(projectWorkspaces)
          .set({ repoUrl: repo.url, defaultRef: match.defaultRef ?? defaultBranch, updatedAt: new Date() })
          .where(eq(projectWorkspaces.id, match.id));
      }
      return { workspaceId: match.id, created: false };
    }
    const created = await projectsSvc.createWorkspace(project.id, {
      name: repo.name,
      sourceType: "git_repo",
      repoUrl: repo.url,
      ...(defaultBranch ? { defaultRef: defaultBranch } : {}),
      isPrimary: true,
    } as Parameters<typeof projectsSvc.createWorkspace>[1]);
    if (!created) throw new HttpError(500, "Could not attach the repository to the project");
    return { workspaceId: created.id, created: true };
  }

  return {
    resolveConnectionToken,

    list: async (companyId: string): Promise<GitHubRepoConnection[]> => {
      const rows = await db
        .select()
        .from(githubRepoConnections)
        .where(eq(githubRepoConnections.companyId, companyId))
        .orderBy(asc(githubRepoConnections.createdAt));
      return Promise.all(rows.map(toDto));
    },

    /**
     * Validate with GitHub, then store the token and attach the repo. Creates
     * the first project when the company has none. Re-connecting a repo rotates
     * its token in place.
     */
    connect: async (companyId: string, input: ConnectGitHubInput, actorUserId: string | null) => {
      const repoInput = parseGitHubRepo(input.repoUrl);
      if (!repoInput) {
        throw badRequest("repoUrl must be a GitHub repository, for example https://github.com/your-org/your-repo");
      }
      const token = assertFineGrainedToken(input.token);
      const verified = await verifyGitHubToken(repoInput, token, deps);
      const repo = repoRef(verified.owner, verified.name) ?? repoInput;

      const { project, created: projectCreated } = await findProjectForConnect(companyId, input.projectId, repo);
      const { workspaceId, created: workspaceCreated } = await findOrCreateWorkspace(project, repo, verified.defaultBranch);

      const existing = await db
        .select()
        .from(githubRepoConnections)
        .where(eq(githubRepoConnections.projectWorkspaceId, workspaceId))
        .then((rows) => rows[0] ?? null);

      // The token: rotate the connection's secret or create one.
      const secretName = githubTokenSecretName(workspaceId);
      const description = `GitHub fine-grained token for ${repo.owner}/${repo.name}`;
      let secretId: string;
      let restore: () => Promise<void>;
      // Only the secret this connection already owns is rotated. A secret that
      // merely has the expected name is never adopted: it may have been
      // planted by someone else (GH #782 review).
      const current = existing?.secretId ? await secrets.getById(existing.secretId) : null;
      if (current && current.companyId === companyId) {
        const previous = await secrets.resolveSecretValue(companyId, current.id, "latest").catch(() => null);
        await secrets.rotate(current.id, { value: token }, { userId: actorUserId }, { companyId, allowManaged: true });
        secretId = current.id;
        restore = async () => {
          if (previous !== null) await secrets.rotate(current.id, { value: previous }, { userId: actorUserId }, { companyId, allowManaged: true });
        };
      } else {
        const nameTaken = Boolean(await secrets.getByName(companyId, secretName));
        const createdSecret = await secrets.create(
          companyId,
          {
            name: nameTaken ? `${secretName}-${randomUUID().slice(0, 8)}` : secretName,
            provider: secretProvider(),
            value: token,
            description,
          },
          { userId: actorUserId },
        );
        secretId = createdSecret.id;
        restore = async () => {
          await secrets.remove(createdSecret.id, { companyId, allowManaged: true });
        };
      }

      const now = new Date();
      const values = {
        companyId,
        projectId: project.id,
        projectWorkspaceId: workspaceId,
        repoFullName: repo.key,
        repoOwner: repo.owner,
        repoName: repo.name,
        defaultBranch: verified.defaultBranch,
        credentialSource: "pat" as const,
        secretId,
        githubAppInstallationId: null,
        validation: { permissions: verified.permissions, private: verified.private },
        validatedAt: now,
        connectedByUserId: actorUserId,
        updatedAt: now,
      };
      let row: ConnectionRow;
      try {
        row = existing
          ? await db
              .update(githubRepoConnections)
              .set(values)
              .where(eq(githubRepoConnections.id, existing.id))
              .returning()
              .then((rows) => rows[0]!)
          : await db.insert(githubRepoConnections).values(values).returning().then((rows) => rows[0]!);
      } catch (error) {
        await restore().catch(() => undefined);
        throw error;
      }
      return {
        connection: await toDto(row),
        rotated: Boolean(existing),
        projectCreated,
        workspaceCreated,
      };
    },

    disconnect: async (companyId: string, connectionId: string) => {
      const row = await db
        .select()
        .from(githubRepoConnections)
        .where(and(eq(githubRepoConnections.id, connectionId), eq(githubRepoConnections.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("GitHub connection not found");
      // The token first: if it cannot be removed, keep the connection so the
      // disconnect can be retried rather than orphaning an encrypted token.
      if (row.secretId) await secrets.remove(row.secretId, { companyId, allowManaged: true });
      await db.delete(githubRepoConnections).where(eq(githubRepoConnections.id, row.id));
      return { id: row.id, repo: `${row.repoOwner}/${row.repoName}`, projectId: row.projectId };
    },

    /**
     * The token for the server's clone of a managed checkout, when the
     * workspace is connected and its URL still names the connected repo.
     */
    cloneTokenForWorkspace: async (companyId: string, projectWorkspaceId: string, repoUrl: string | null) => {
      const repo = parseGitHubRepo(repoUrl);
      if (!repo) return null;
      const row = await db
        .select()
        .from(githubRepoConnections)
        .where(
          and(
            eq(githubRepoConnections.companyId, companyId),
            eq(githubRepoConnections.projectWorkspaceId, projectWorkspaceId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!row || row.repoFullName !== repo.key) return null;
      const token = await resolveConnectionToken(row);
      return token ? { token, repoUrl: repo.url } : null;
    },

    /**
     * The credential an agent's `git` asks for (POST /api/agent-git-credential).
     * Granted only to a run that is running right now, belongs to this agent,
     * and works in the project the repo is connected to; the requested repo, if
     * git names it, must be that repo. Returns null in every other case.
     */
    credentialForRun: async (input: CredentialForRunInput) => {
      if (!input.runId) return null;
      if (input.protocol !== "https" || input.host !== GITHUB_HOST) return null;
      const run = await db
        .select({
          id: heartbeatRuns.id,
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, input.runId))
        .then((rows) => rows[0] ?? null);
      if (!run || run.companyId !== input.companyId || run.agentId !== input.agentId || run.status !== "running") {
        return null;
      }
      // The project comes from the run's issue, and the agent must be that
      // issue's assignee: a context projectId alone is not trusted, since
      // wakeup context can be supplied by callers.
      const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
      const issueId =
        typeof context.issueId === "string" && context.issueId
          ? context.issueId
          : typeof context.taskId === "string" && context.taskId
            ? context.taskId
            : null;
      if (!issueId) return null;
      const issue = await db
        .select({ projectId: issues.projectId, companyId: issues.companyId, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue || issue.companyId !== input.companyId || issue.assigneeAgentId !== input.agentId) return null;
      const projectId = issue.projectId ?? null;
      if (!projectId) return null;
      const rows = await db
        .select()
        .from(githubRepoConnections)
        .where(and(eq(githubRepoConnections.companyId, input.companyId), eq(githubRepoConnections.projectId, projectId)));
      const requested = repoKeyFromCredentialPath(input.path);
      const row = requested
        ? rows.find((candidate) => candidate.repoFullName === requested)
        : rows.length === 1
          ? rows[0]
          : undefined;
      if (!row) return null;
      const token = await resolveConnectionToken(row);
      return token ? { token, connectionId: row.id, repo: `${row.repoOwner}/${row.repoName}`, projectId } : null;
    },
  };
}
