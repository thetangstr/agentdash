// AgentDash (GH #782): connect a GitHub repository with a fine-grained token.
//
// Used as the "Your repo" step of the first run and as the GitHub section of a
// project's Configuration tab. The token lives only in this form's state until
// it is sent; the server checks it with GitHub, stores it encrypted and never
// sends it back. Agents run with a shell and can read the token, so the copy
// asks for a token scoped to this one repository with the minimum permissions.
import { useState, type FormEvent } from "react";
import type { GitHubRepoConnection } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { GITHUB_FINE_GRAINED_TOKEN_URL, githubConnectionsApi, type ConnectGitHubResponse } from "@/api/githubConnections";
import { Button } from "@/components/ui/button";

export interface GitHubConnectStepProps {
  companyId: string;
  /** Attach to this project. Omitted in the first run: the server uses or creates the first project. */
  projectId?: string;
  /** The current connection, if any. */
  connection: GitHubRepoConnection | null;
  canManage: boolean;
  onConnected: (result: ConnectGitHubResponse) => void;
  /** "page" for the first run, "section" inside project settings. */
  variant?: "page" | "section";
}

function errorSentence(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0 || error.status >= 500) {
      return error.message || "Could not reach the workspace to check the token. Try again.";
    }
    return error.message;
  }
  if (error instanceof TypeError) return "Could not reach the workspace to check the token. Check your connection and try again.";
  if (error instanceof Error) return error.message;
  return "Something went wrong while checking the token. Try again.";
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

export function GitHubConnectStep({
  companyId,
  projectId,
  connection,
  canManage,
  onConnected,
  variant = "page",
}: GitHubConnectStepProps) {
  const [repoUrl, setRepoUrl] = useState(connection?.repoUrl ?? "");
  const [token, setToken] = useState("");
  const [editing, setEditing] = useState(!connection);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isPage = variant === "page";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!repoUrl.trim() || !token.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await githubConnectionsApi.connect(companyId, {
        repoUrl: repoUrl.trim(),
        githubToken: token.trim(),
        ...(projectId ? { projectId } : {}),
      });
      setToken("");
      setEditing(false);
      onConnected(result);
    } catch (err) {
      setError(errorSentence(err));
    } finally {
      setSaving(false);
    }
  }

  const heading = isPage ? (
    <h1 className="text-lg font-semibold">Using code? Connect GitHub</h1>
  ) : (
    <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">GitHub</h3>
  );

  const connectedSummary = connection ? (
    <div className="rounded border px-3 py-2 text-sm" data-testid="github-connected">
      <p>
        <span className="font-medium">Connected to </span>
        <a className="underline" href={connection.repoUrl} target="_blank" rel="noreferrer">
          {connection.repo}
        </a>
      </p>
      <p className="mt-1 text-muted-foreground">
        {connection.defaultBranch ? `Default branch ${connection.defaultBranch}. ` : ""}
        {connection.credentialPresent ? "Fine-grained token stored encrypted" : "The stored token is missing; reconnect"}
        {formatDate(connection.validatedAt) ? `, checked ${formatDate(connection.validatedAt)}.` : "."}
      </p>
    </div>
  ) : null;

  if (!canManage) {
    return (
      <div className={isPage ? "mx-auto flex max-w-lg flex-col gap-3 px-6 py-12 text-sm" : "flex flex-col gap-3 text-sm"}>
        {heading}
        {connectedSummary ?? <p className="text-muted-foreground">No repository is connected yet.</p>}
        <p className="text-muted-foreground" data-testid="github-connect-restricted">
          Only a workspace owner or admin can connect a repository or change its token.
        </p>
      </div>
    );
  }

  if (connection && !editing) {
    return (
      <div className={isPage ? "mx-auto flex max-w-lg flex-col gap-3 px-6 py-12" : "flex flex-col gap-3"}>
        {heading}
        {connectedSummary}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            Replace token
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className={isPage ? "mx-auto flex max-w-lg flex-col gap-5 px-6 py-12" : "flex flex-col gap-4"}
      onSubmit={submit}
      aria-label="Connect GitHub"
    >
      <div className="flex flex-col gap-2">
        {heading}
        <p className="text-sm text-muted-foreground">
          {isPage
            ? "Only needed if your team works on software. Agents clone the repo, push a branch for each task and open a pull request. They never merge."
            : "Your agents clone this repo, push a branch for each issue and open a pull request. They never merge."}
        </p>
      </div>

      <div className="rounded border bg-muted/40 px-3 py-2 text-sm" data-testid="github-token-howto">
        <p>
          Create a{" "}
          <a className="underline" href={GITHUB_FINE_GRAINED_TOKEN_URL} target="_blank" rel="noreferrer">
            fine-grained token on GitHub
          </a>
          : Repository access "Only select repositories" with just this repo, and the permissions{" "}
          <strong>Contents: Read and write</strong> and <strong>Pull requests: Read and write</strong> (Metadata: Read
          is added for you). Set an expiry.
        </p>
        <p className="mt-2 text-muted-foreground">
          Agents work in a shell, so they can read this token, and anyone who can give them work could ask for it.
          Give it access to this one repository and nothing else, and protect your default branch on GitHub so
          every change goes through a pull request. Classic tokens are refused.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Repository</span>
        <input
          type="text"
          name="repoUrl"
          autoComplete="off"
          spellCheck={false}
          className="rounded border px-3 py-2"
          placeholder="https://github.com/your-org/your-repo"
          value={repoUrl}
          onChange={(event) => setRepoUrl(event.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Fine-grained token</span>
        <input
          type="password"
          name="githubToken"
          autoComplete="off"
          spellCheck={false}
          className="rounded border px-3 py-2"
          placeholder="github_pat_…"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <span className="text-xs text-muted-foreground">
          Checked with GitHub, then stored encrypted on this workspace. It is never shown again.
        </span>
      </label>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={!repoUrl.trim() || !token.trim() || saving}>
          {saving ? "Checking with GitHub…" : connection ? "Check and replace" : "Check and connect"}
        </Button>
        {connection ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setToken("");
              setError(null);
            }}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
