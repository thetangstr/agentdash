// AgentDash native adapter — REST client used by the in-process tool loop.
//
// Tools call the AgentDash/Paperclip REST API *as the agent* (the per-run JWT in
// AdapterExecutionContext.authToken), not as the server. The heartbeat has already
// checked out the issue before execute() runs, so no checkout is needed here.
//
// The request/response shapes and the base-URL resolution order are adapted from
// the MIT-licensed community OpenRouter adapter
// (github.com/talhamahmood666/paperclip-adapter-openrouter, src/server/paperclip-api.ts),
// extended with AgentDash's DoD / verdict / interaction / quota endpoints.

export interface PaperclipApiOptions {
  baseUrl?: string;
  authToken: string;
  runId?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class PaperclipApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly endpoint: string,
  ) {
    super(message);
    this.name = "PaperclipApiError";
  }
}

function resolveBaseUrl(explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.replace(/\/+$/, "");
  const fromEnv = process.env.PAPERCLIP_API_URL ?? process.env.AGENTDASH_API_URL;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.replace(/\/+$/, "");
  const port = process.env.PORT ?? process.env.PAPERCLIP_PORT ?? "3100";
  return `http://127.0.0.1:${port}`;
}

export class PaperclipApi {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly runId: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PaperclipApiOptions) {
    this.baseUrl = resolveBaseUrl(opts.baseUrl);
    this.authToken = opts.authToken;
    this.runId = opts.runId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.authToken}`,
      Accept: "application/json",
    };
    // The run id is also carried in the JWT claims; send the header too so
    // routes that read X-Paperclip-Run-Id (run ownership) are satisfied.
    if (this.runId) headers["X-Paperclip-Run-Id"] = this.runId;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new PaperclipApiError(`Network error calling AgentDash API: ${reason}`, 0, null, `${method} ${path}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    let parsed: unknown = null;
    if (contentType.includes("application/json")) {
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
    } else {
      try {
        parsed = await response.text();
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const message =
        (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : null) ?? `AgentDash API ${response.status} ${response.statusText}`;
      throw new PaperclipApiError(message, response.status, parsed, `${method} ${path}`);
    }
    return parsed as T;
  }

  // ----- Issues -----
  getIssue(issueId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}`);
  }
  updateIssue(issueId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, patch);
  }
  listCompanyIssues(companyId: string, query?: Record<string, string>): Promise<unknown> {
    const qs = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : "";
    return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/issues${qs}`);
  }
  createIssue(companyId: string, issue: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/issues`, issue);
  }

  // ----- Comments -----
  listIssueComments(issueId: string): Promise<unknown> {
    return this.request("GET", `/api/issues/${encodeURIComponent(issueId)}/comments`);
  }
  addIssueComment(issueId: string, body: { body: string; [k: string]: unknown }): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, body);
  }

  // ----- Agents / approvals -----
  listCompanyAgents(companyId: string): Promise<Record<string, unknown>[]> {
    return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/agents`);
  }
  createApproval(companyId: string, approval: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/approvals`, approval);
  }

  // ----- Definition of Done -----
  setDefinitionOfDone(
    companyId: string,
    issueId: string,
    dod: { summary: string; criteria: Array<Record<string, unknown>>; goalMetricLink?: string },
  ): Promise<Record<string, unknown>> {
    return this.request(
      "PUT",
      `/api/companies/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(issueId)}/dod`,
      dod,
    );
  }

  // ----- Verdicts (in_review review flow) -----
  createVerdict(companyId: string, verdict: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/verdicts`, {
      companyId,
      ...verdict,
    });
  }

  // ----- Interactions (suggest_tasks / ask_user_questions / request_confirmation) -----
  createInteraction(issueId: string, interaction: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/interactions`, interaction);
  }

  // ----- Quota -----
  getQuota(companyId: string): Promise<Record<string, unknown>> {
    return this.request("GET", `/api/companies/${encodeURIComponent(companyId)}/quota`);
  }
}
