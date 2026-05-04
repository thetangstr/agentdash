// AgentDash: forgot-password screen. Hands the email off to Better
// Auth's /api/auth/forget-password; on success we show "check your
// email" without revealing whether the address actually exists (we
// trust Better Auth's response not to leak that). The reset link in
// the email points at /reset-password?token=… (see ResetPassword.tsx).

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import { authApi } from "../api/auth";
import { LiveBriefing } from "../marketing/sections/LiveBriefing";
import "../marketing/sections/LiveBriefing.css";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const mutation = useMutation({
    mutationFn: () =>
      authApi.forgetPassword({
        email: email.trim(),
        redirectTo: `${window.location.origin}/reset-password`,
      }),
    onSuccess: () => {
      setError(null);
      setSubmitted(true);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Couldn't send the reset email.");
    },
  });

  const canSubmit = email.trim().length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  return (
    <div className="fixed inset-0 flex bg-surface-page">
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Sparkles className="h-4 w-4 text-text-tertiary" />
            <span className="text-sm font-medium text-text-primary">AgentDash</span>
          </div>

          <h1 className="text-2xl font-semibold text-text-primary">Reset your password</h1>
          <p className="mt-2 text-sm text-text-secondary">
            We'll email you a link to choose a new one.
          </p>

          {submitted ? (
            <div className="mt-6 rounded-md border border-border-soft bg-surface-raised p-4 text-sm text-text-primary">
              <p>
                If an account exists for <span className="font-medium">{email.trim()}</span>, we just
                sent a reset link. Check your inbox (and spam folder) — the link expires in 1 hour.
              </p>
              <p className="mt-3 text-xs text-text-secondary">
                Having trouble? The email service may not be working — please contact the administrator.
              </p>
            </div>
          ) : (
            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (mutation.isPending || !canSubmit) return;
                mutation.mutate();
              }}
            >
              <div>
                <label htmlFor="email" className="text-xs text-text-secondary mb-1 block font-medium">
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  className="w-full rounded-md border border-border-soft bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-500 focus:ring-2 focus:ring-accent-200 transition-[color,box-shadow]"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              {error && <p className="text-xs text-danger-500">{error}</p>}
              <Button
                type="submit"
                disabled={mutation.isPending}
                aria-disabled={!canSubmit || mutation.isPending}
                className={`w-full ${!canSubmit && !mutation.isPending ? "opacity-50" : ""}`}
              >
                {mutation.isPending ? "Sending…" : "Send reset link"}
              </Button>
            </form>
          )}

          <div className="mt-5 text-sm text-text-secondary">
            Remembered it?{" "}
            <Link
              to="/auth"
              className="font-medium text-text-primary underline underline-offset-2 hover:text-accent-500 transition-colors"
            >
              Back to sign in
            </Link>
          </div>
        </div>
      </div>

      <div className="hidden md:flex w-1/2 items-center justify-center overflow-hidden bg-surface-page px-12">
        <div className="mkt-root w-full max-w-xl">
          <LiveBriefing />
        </div>
      </div>
    </div>
  );
}
