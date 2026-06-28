import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams, Link } from "@/lib/router";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { getRememberedInvitePath } from "../lib/invite-memory";
import { Button } from "@/components/ui/button";
import { LiveBriefing } from "../marketing/sections/LiveBriefing";
// LiveBriefing's "Live · Tue 29 Apr" hero card is the same illustration
// the marketing landing page uses. tokens.css / typography.css are
// loaded globally from main.tsx; we just need the section's own styles
// for the brief card itself.
import "../marketing/sections/LiveBriefing.css";
import { Sparkles } from "lucide-react";

type AuthMode = "sign_in" | "sign_up";

// AgentDash: SSO — inline brand glyphs (no extra icon dependency). Sized to
// match the 14px lucide icons used elsewhere on this page.
function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z" />
    </svg>
  );
}

function MicrosoftGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Default to sign-in, but honor `?mode=sign_up` so the CLI's first-run
  // wizard can deep-link new users straight to the "Create your workspace"
  // form. The toggle link still lets them switch back to sign-in if they
  // already have an account.
  const initialMode: AuthMode = searchParams.get("mode") === "sign_up" ? "sign_up" : "sign_in";
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const nextPath = useMemo(
    () => searchParams.get("next") || getRememberedInvitePath() || "/",
    [searchParams],
  );
  const { data: session, isLoading: isSessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  // AgentDash: SSO — discover which social providers are configured so we only
  // render a button when its provider can actually complete a sign-in.
  const { data: socialProviders } = useQuery({
    queryKey: ["auth", "social-providers"],
    queryFn: () => authApi.getSocialProviders(),
    staleTime: 5 * 60 * 1000,
  });
  const showGoogle = socialProviders?.google ?? false;
  const showMicrosoft = socialProviders?.microsoft ?? false;
  const anySocial = showGoogle || showMicrosoft;

  // AgentDash: SSO — where Better Auth lands the user after the OAuth
  // round-trip. Mirrors the email flow: trial-claim sign-ups keep their
  // `next` deep link, other sign-ups go to /company-create, and sign-ins go
  // wherever they were already heading (preserving `next` / remembered invite).
  const socialCallbackURL = useMemo(() => {
    const rawNext = searchParams.get("next");
    const isTrialClaim = !!rawNext && rawNext.startsWith("/trial/claim");
    if (isTrialClaim) return rawNext as string;
    return mode === "sign_up" ? "/company-create" : nextPath;
  }, [searchParams, mode, nextPath]);

  const socialMutation = useMutation({
    mutationFn: (provider: "google" | "microsoft") =>
      authApi.signInSocial({ provider, callbackURL: socialCallbackURL }),
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Social sign-in failed");
    },
  });

  useEffect(() => {
    if (session) {
      navigate(nextPath, { replace: true });
    }
  }, [session, navigate, nextPath]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "sign_in") {
        await authApi.signInEmail({ email: email.trim(), password });
        return;
      }
      await authApi.signUpEmail({
        name: name.trim(),
        email: email.trim(),
        password,
      });
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      // AgentDash (Phase E): fresh sign-ups land on /company-create so the
      // user explicitly names their workspace before the assess + CoS flow.
      // Sign-ins go to wherever they were already heading (preserves
      // ?next=… deep links and the remembered invite path).
      //
      // AgentDash (Test Drive, Slice 4): the trial conversion CTA signs the
      // user up with ?next=/trial/claim. Those users already HAVE a workspace
      // (the trial company they're about to claim), so honor the explicit next
      // and skip /company-create.
      const rawNext = searchParams.get("next");
      const isTrialClaim = !!rawNext && rawNext.startsWith("/trial/claim");
      const destination = mode === "sign_up" ? (isTrialClaim ? rawNext : "/company-create") : nextPath;
      navigate(destination, { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Authentication failed");
    },
  });

  const canSubmit =
    email.trim().length > 0 &&
    password.trim().length > 0 &&
    (mode === "sign_in" || (name.trim().length > 0 && password.trim().length >= 8));

  if (isSessionLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-surface-page">
      {/* Left half — form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Sparkles className="h-4 w-4 text-text-tertiary" />
            <span className="text-sm font-medium text-text-primary">AgentDash</span>
          </div>

          <h1 className="text-2xl font-semibold text-text-primary">
            {mode === "sign_in" ? "Welcome back" : "Create your workspace"}
          </h1>
          <p className="mt-2 text-sm text-text-secondary">
            {mode === "sign_in"
              ? "Use your email and password to access this instance."
              : "Create an account for this instance. Email confirmation is not required in v1."}
          </p>

          {/* AgentDash: SSO — social sign-in buttons. Each renders only when the
              server reports its provider is configured, so the block stays
              hidden until OAuth credentials are added in the environment. */}
          {anySocial && (
            <div className="mt-6 space-y-3">
              {showGoogle && (
                <button
                  type="button"
                  disabled={socialMutation.isPending}
                  onClick={() => {
                    setError(null);
                    socialMutation.mutate("google");
                  }}
                  className="flex w-full items-center justify-center gap-2.5 rounded-md border border-border-soft bg-surface-raised px-3 py-2 text-sm font-medium text-text-primary outline-none transition-colors hover:border-accent-500 focus:border-accent-500 focus:ring-2 focus:ring-accent-200 disabled:opacity-50"
                >
                  <GoogleGlyph />
                  Continue with Google
                </button>
              )}
              {showMicrosoft && (
                <button
                  type="button"
                  disabled={socialMutation.isPending}
                  onClick={() => {
                    setError(null);
                    socialMutation.mutate("microsoft");
                  }}
                  className="flex w-full items-center justify-center gap-2.5 rounded-md border border-border-soft bg-surface-raised px-3 py-2 text-sm font-medium text-text-primary outline-none transition-colors hover:border-accent-500 focus:border-accent-500 focus:ring-2 focus:ring-accent-200 disabled:opacity-50"
                >
                  <MicrosoftGlyph />
                  Continue with Microsoft
                </button>
              )}
            </div>
          )}

          {anySocial && (
            <div className="mt-5 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-border-soft" />
              <span className="text-xs text-text-tertiary">or</span>
              <span className="h-px flex-1 bg-border-soft" />
            </div>
          )}

          <form
            className="mt-6 space-y-4"
            method="post"
            action={mode === "sign_up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email"}
            onSubmit={(event) => {
              event.preventDefault();
              if (mutation.isPending) return;
              if (!canSubmit) {
                setError("Please fill in all required fields.");
                return;
              }
              mutation.mutate();
            }}
          >
            {mode === "sign_up" && (
              <div>
                <label htmlFor="name" className="text-xs text-text-secondary mb-1 block font-medium">Name</label>
                <input
                  id="name"
                  name="name"
                  className="w-full rounded-md border border-border-soft bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-500 focus:ring-2 focus:ring-accent-200 transition-[color,box-shadow]"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  autoFocus
                />
              </div>
            )}
            <div>
              <label htmlFor="email" className="text-xs text-text-secondary mb-1 block font-medium">Email</label>
              <input
                id="email"
                name="email"
                className="w-full rounded-md border border-border-soft bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-500 focus:ring-2 focus:ring-accent-200 transition-[color,box-shadow]"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                autoFocus={mode === "sign_in"}
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="password" className="text-xs text-text-secondary font-medium">Password</label>
                {mode === "sign_in" && (
                  <Link
                    to="/forgot-password"
                    className="text-xs text-text-secondary underline underline-offset-2 hover:text-accent-500 transition-colors"
                  >
                    Forgot password?
                  </Link>
                )}
              </div>
              <input
                id="password"
                name="password"
                className="w-full rounded-md border border-border-soft bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-500 focus:ring-2 focus:ring-accent-200 transition-[color,box-shadow]"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
              />
            </div>
            {error && <p className="text-xs text-danger-500">{error}</p>}
            <Button
              type="submit"
              disabled={mutation.isPending}
              aria-disabled={!canSubmit || mutation.isPending}
              className={`w-full ${!canSubmit && !mutation.isPending ? "opacity-50" : ""}`}
            >
              {mutation.isPending
                ? "Working…"
                : mode === "sign_in"
                  ? "Sign In"
                  : "Create Account"}
            </Button>
          </form>

          <div className="mt-5 text-sm text-text-secondary">
            {mode === "sign_in" ? "Need an account?" : "Already have an account?"}{" "}
            <button
              type="button"
              className="font-medium text-text-primary underline underline-offset-2 hover:text-accent-500 transition-colors"
              onClick={() => {
                setError(null);
                setMode(mode === "sign_in" ? "sign_up" : "sign_in");
              }}
            >
              {mode === "sign_in" ? "Create one" : "Sign in"}
            </button>
          </div>
        </div>
      </div>

      {/* Right half — Live Briefing card from the marketing landing page
          (one human + four AI agents, with a slow coral row indicator).
          Wrapped in `mkt-root` so the marketing typography vars
          (`--mkt-rule`, `--mkt-ink`, `--mkt-font-serif`, etc.) resolve
          for the LiveBriefing styles. Hidden on mobile to keep the form
          column readable on small viewports. */}
      <div className="hidden md:flex w-1/2 items-center justify-center overflow-hidden bg-surface-page px-12">
        <div className="mkt-root w-full max-w-xl">
          <LiveBriefing />
        </div>
      </div>
    </div>
  );
}
