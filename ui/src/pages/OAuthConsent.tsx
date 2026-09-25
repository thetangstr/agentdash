import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";

/**
 * AgentDash assistant MCP (GH #677): the OAuth consent screen.
 *
 * `/oauth/authorize` 302s here once the client, redirect URI, PKCE challenge,
 * and resource have all validated — so everything this page renders came from
 * a row the server already checked, not from the address bar. The person sees
 * the client name, the host their browser will be sent back to, exactly one
 * company, and the scopes the client asked for.
 *
 * `agentdash:decide` is deliberately NOT pre-checked: it lets the assistant
 * resolve approvals, and "checked by default" is how a scope nobody asked for
 * gets granted. Read and work default on because they are the surface the
 * consent screen exists to describe.
 */

interface ConsentView {
  requestId: string;
  clientName: string;
  redirectHost: string;
  requestedScopes: string[];
  resource: string;
  companies: Array<{ id: string; name: string }>;
}

const SCOPE_LABELS: Record<string, { label: string; description: string }> = {
  "agentdash:read": {
    label: "Read your workspace",
    description: "See projects, work items, activity, and what needs you.",
  },
  "agentdash:work": {
    label: "Work in your name",
    description: "Create and move work items, comment, and wake your agent.",
  },
  "agentdash:decide": {
    label: "Decide for you",
    description: "Resolve approvals and hires. Off by default — check it only if you mean it.",
  },
};

async function consentRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (body as { error?: string; error_description?: string } | null)?.error_description ??
      (body as { error?: string } | null)?.error ??
      `Request failed: ${res.status}`;
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return body as T;
}

export function OAuthConsent() {
  const [searchParams] = useSearchParams();
  const requestId = searchParams.get("request") ?? "";
  const [companyId, setCompanyId] = useState<string>("");
  const [granted, setGranted] = useState<Set<string>>(
    () => new Set(["agentdash:read", "agentdash:work"]),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const view = useQuery({
    queryKey: ["oauth", "consent", requestId],
    queryFn: () => consentRequest<ConsentView>(`/oauth/consent/${encodeURIComponent(requestId)}`),
    enabled: requestId.length > 0,
    retry: false,
  });

  const companies = view.data?.companies ?? [];
  const selectedCompany = companyId || companies[0]?.id || "";

  const requestedScopes = useMemo(
    () => (view.data?.requestedScopes ?? []).filter((scope) => scope in SCOPE_LABELS),
    [view.data],
  );
  const nothingGranted = requestedScopes.every((scope) => !granted.has(scope));

  function toggle(scope: string) {
    setGranted((current) => {
      const next = new Set(current);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  async function decide(approved: boolean) {
    setPending(true);
    setError(null);
    try {
      const result = await consentRequest<{ redirect: string }>(
        `/oauth/consent/${encodeURIComponent(requestId)}/decision`,
        {
          method: "POST",
          body: JSON.stringify({
            approved,
            companyId: approved ? selectedCompany : undefined,
            scopes: approved ? [...granted].filter((scope) => requestedScopes.includes(scope)) : [],
          }),
        },
      );
      // The server built this URL from the redirect_uri it validated at
      // authorize time — follow it verbatim.
      window.location.assign(result.redirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record your choice");
      setPending(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-4 py-10">
      <div className="rounded-lg border border-border bg-card">
        <div className="border-b px-5 py-4">
          <h1 className="text-lg font-semibold">Connect an assistant</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            An assistant is asking to work with your AgentDash workspace.
          </p>
        </div>

        <div className="px-5 py-4">
          {view.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading the request…</p>
          ) : view.error || !view.data ? (
            <p className="text-sm text-destructive" role="alert">
              {view.error instanceof Error
                ? view.error.message
                : "This consent request is no longer pending — ask the assistant to connect again."}
            </p>
          ) : (
            <>
              <dl className="flex flex-col gap-2.5 text-sm">
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Assistant</dt>
                  <dd className="mt-0.5 font-medium">{view.data.clientName}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">
                    Your browser returns to
                  </dt>
                  <dd className="mt-0.5 font-mono text-xs">{view.data.redirectHost}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted-foreground">Workspace</dt>
                  <dd className="mt-0.5">
                    {companies.length === 0 ? (
                      <span className="text-destructive">
                        You are not a member of any company this assistant could work in.
                      </span>
                    ) : companies.length === 1 ? (
                      <span className="font-medium">{companies[0]!.name}</span>
                    ) : (
                      <select
                        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                        value={selectedCompany}
                        onChange={(event) => setCompanyId(event.target.value)}
                      >
                        {companies.map((company) => (
                          <option key={company.id} value={company.id}>
                            {company.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </dd>
                </div>
              </dl>

              <fieldset className="mt-4">
                <legend className="text-xs font-medium text-muted-foreground">
                  What it may do
                </legend>
                <div className="mt-1.5 flex flex-col gap-1.5">
                  {requestedScopes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      The assistant asked for nothing beyond basic access.
                    </p>
                  ) : (
                    requestedScopes.map((scope) => {
                      const meta = SCOPE_LABELS[scope]!;
                      const isDecide = scope === "agentdash:decide";
                      return (
                        <label
                          key={scope}
                          className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2"
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={granted.has(scope)}
                            onChange={() => toggle(scope)}
                          />
                          <span>
                            <span className="block text-sm font-medium">
                              {meta.label}
                              {isDecide ? (
                                <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                                  Off by default
                                </span>
                              ) : null}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {meta.description}
                            </span>
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              </fieldset>

              {error ? (
                <p className="mt-3 text-xs text-destructive" role="alert">
                  {error}
                </p>
              ) : null}

              <div className="mt-5 flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => void decide(false)}
                >
                  Deny
                </Button>
                <Button
                  disabled={pending || companies.length === 0 || nothingGranted}
                  onClick={() => void decide(true)}
                >
                  {pending ? "Connecting…" : `Allow ${view.data.clientName}`}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
