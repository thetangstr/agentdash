import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "../marketing/components/Button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { Sparkles } from "lucide-react";

type AuthMode = "sign_in" | "sign_up";

// AgentDash (AGE-55): FRE Plan B — read disableSignUp from /api/health so the
// UI can hide the signup affordance when the server runs in invite-only mode.
type HealthResponse = {
  features?: {
    disableSignUp?: boolean;
  };
};

async function fetchAuthFeatures(): Promise<{ disableSignUp: boolean }> {
  try {
    const res = await fetch("/api/health", { credentials: "include" });
    if (!res.ok) return { disableSignUp: false };
    const payload = (await res.json()) as HealthResponse;
    return { disableSignUp: Boolean(payload.features?.disableSignUp) };
  } catch {
    return { disableSignUp: false };
  }
}

export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("sign_in");

  // AgentDash (AGE-55): hide the signup tab/CTA when the server reports
  // disableSignUp=true. Defaults to allowing signup so existing dev flows
  // keep working until the health request returns.
  const { data: authFeatures } = useQuery({
    queryKey: ["auth", "features"],
    queryFn: fetchAuthFeatures,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const disableSignUp = authFeatures?.disableSignUp ?? false;
  // Force sign-in mode if signup is disabled (defensive against race where the
  // user toggled to sign_up before health resolved).
  useEffect(() => {
    if (disableSignUp && mode === "sign_up") {
      setMode("sign_in");
    }
  }, [disableSignUp, mode]);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const nextPath = useMemo(() => searchParams.get("next") || "/", [searchParams]);
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
      navigate(nextPath, { replace: true });
    },
    onError: (err) => {
      // AgentDash (AGE-101): translate AGE-60 / AGE-100 server codes to
      // friendlier inline copy instead of dumping the raw server message.
      const code = (err as { code?: unknown }).code;
      if (code === "pro_requires_corp_email") {
        setError(
          "Pro accounts require a company email. Please sign up with your work email or use the Free self-hosted plan.",
        );
        return;
      }
      if (code === "free_tier_seat_cap") {
        setError(
          "Self-hosted Free supports one human user. Upgrade to Pro to invite teammates.",
        );
        return;
      }
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
    <div className="mkt-root" style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
      <div className="fixed inset-0 flex">
      {/* Left half — form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">AgentDash</span>
          </div>

          <h1 className="mkt-display-section">
            {mode === "sign_in" ? "Sign in to AgentDash" : "Create your AgentDash account"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
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
                <label htmlFor="name" className="text-xs text-muted-foreground mb-1 block">Name</label>
                <input
                  id="name"
                  name="name"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  autoFocus
                />
              </div>
            )}
            <div>
              <label htmlFor="email" className="text-xs text-muted-foreground mb-1 block">Email</label>
              <input
                id="email"
                name="email"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                autoFocus={mode === "sign_in"}
              />
            </div>
            <div>
              <label htmlFor="password" className="text-xs text-muted-foreground mb-1 block">Password</label>
              <input
                id="password"
                name="password"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button
              type="submit"
              className={`w-full ${(!canSubmit || mutation.isPending) ? "opacity-50" : ""}`}
            >
              {mutation.isPending
                ? "Working…"
                : mode === "sign_in"
                  ? "Sign In"
                  : "Create Account"}
            </Button>
          </form>

          {/* AgentDash (AGE-55): hide the signup affordance when server
              reports disableSignUp=true. Invite-only instances surface a
              brief explanation instead. */}
          {disableSignUp ? (
            mode === "sign_in" ? (
              <p
                className="mt-5 text-sm text-muted-foreground"
                data-testid="auth-invite-only-notice"
              >
                Sign-up is disabled on this instance. Ask a teammate to invite you.
              </p>
            ) : null
          ) : (
            <div className="mt-5 text-sm text-muted-foreground">
              {mode === "sign_in" ? "Need an account?" : "Already have an account?"}{" "}
              <button
                type="button"
                className="font-medium text-foreground underline underline-offset-2"
                onClick={() => {
                  setError(null);
                  setMode(mode === "sign_in" ? "sign_up" : "sign_in");
                }}
                data-testid="auth-toggle-mode"
              >
                {mode === "sign_in" ? "Create one" : "Sign in"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Right half — ASCII art animation (hidden on mobile) */}
      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
      </div>
    </div>
  );
}
