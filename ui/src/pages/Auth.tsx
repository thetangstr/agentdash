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
      // AgentDash: new sign-ups land on the CoS onboarding v2 conversation.
      const destination = mode === "sign_up" ? "/cos" : nextPath;
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
