// AgentDash (AGE-54.1): in-app Codex sign-in for non-technical operators.
// Mirrors the Claude login pattern but polishes the UX: one button, a
// prominent "Open sign-in page" link, live status polling, and a green
// confirmation once the OAuth callback writes ~/.codex/auth.json.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { agentsApi, type CodexLoginResult } from "../api/agents";
import { Button } from "@/components/ui/button";
import { Loader2, ExternalLink, CheckCircle2 } from "lucide-react";

interface CodexLoginBlockProps {
  agentId: string;
  companyId: string;
  /** Force the block visible even when auth-status poll reports no pending login. */
  alwaysShow?: boolean;
  /** Optional headline; defaults to "Sign in with ChatGPT to run Codex". */
  headline?: string;
  /** Optional sub-copy; rendered below the headline. */
  description?: string;
}

export function CodexLoginBlock({
  agentId,
  companyId,
  alwaysShow = false,
  headline = "Sign in with ChatGPT to run Codex",
  description = "We'll open the OpenAI sign-in page in a new tab. Complete the sign-in there, then come back here — we'll detect it automatically.",
}: CodexLoginBlockProps) {
  const [loginResult, setLoginResult] = useState<CodexLoginResult | null>(null);
  const [loginStartedAt, setLoginStartedAt] = useState<number | null>(null);

  const authStatusQuery = useQuery({
    queryKey: ["codex-auth-status", agentId, companyId],
    queryFn: () => agentsApi.codexAuthStatus(agentId, companyId),
    // Poll every 3s while a login is in flight so the success state flips
    // as soon as the user completes OAuth. Otherwise refresh every 30s so
    // the UI keeps a recent reading without thrashing the backend.
    refetchInterval: loginStartedAt != null ? 3000 : 30000,
    staleTime: 0,
  });

  const loginMutation = useMutation({
    mutationFn: () => agentsApi.loginWithCodex(agentId, companyId),
    onSuccess: (data) => {
      setLoginResult(data);
      if (data.loginUrl) {
        try {
          window.open(data.loginUrl, "_blank", "noopener,noreferrer");
        } catch {
          // Popup-blocked browsers: the link below is still clickable.
        }
      }
    },
  });

  useEffect(() => {
    if (loginMutation.isPending && loginStartedAt == null) {
      setLoginStartedAt(Date.now());
    }
  }, [loginMutation.isPending, loginStartedAt]);

  useEffect(() => {
    // Once we've confirmed sign-in, stop the fast poll.
    if (authStatusQuery.data?.authenticated && loginStartedAt != null) {
      setLoginStartedAt(null);
    }
  }, [authStatusQuery.data?.authenticated, loginStartedAt]);

  const authed = authStatusQuery.data?.authenticated === true;

  if (authed && !alwaysShow && loginResult == null) {
    return (
      <div className="rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-300 flex items-center gap-2">
        <CheckCircle2 className="h-3.5 w-3.5" />
        <span>
          Codex is signed in{authStatusQuery.data?.email ? ` as ${authStatusQuery.data.email}` : ""}.
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-card p-4 space-y-3">
      <div className="space-y-1">
        <div className="text-sm font-medium">{headline}</div>
        <div className="text-xs text-muted-foreground leading-relaxed">{description}</div>
      </div>

      {authed ? (
        <div className="flex items-center gap-2 text-xs text-green-700 dark:text-green-300">
          <CheckCircle2 className="h-3.5 w-3.5" />
          <span>
            Signed in{authStatusQuery.data?.email ? ` as ${authStatusQuery.data.email}` : ""}.
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => loginMutation.mutate()}
            disabled={loginMutation.isPending}
            className="gap-1.5"
          >
            {loginMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Waiting for sign-in…
              </>
            ) : loginResult?.loginUrl ? (
              "Retry sign-in"
            ) : (
              "Sign in with ChatGPT"
            )}
          </Button>

          {loginResult?.loginUrl && !authed && (
            <a
              href={loginResult.loginUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary underline underline-offset-2 hover:text-primary/80"
            >
              Open sign-in page
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}

      {loginMutation.isError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          {loginMutation.error instanceof Error
            ? loginMutation.error.message
            : "Sign-in request failed. Please try again."}
        </div>
      )}

      {loginResult && !authed && (
        <div className="text-[11px] text-muted-foreground">
          Finished signing in? Status refreshes automatically — no need to reload.
        </div>
      )}
    </div>
  );
}
