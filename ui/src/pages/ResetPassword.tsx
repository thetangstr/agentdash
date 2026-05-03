// AgentDash: reset-password screen. The user lands here from the link
// in the password-reset email. We pull the `?token=` from the URL,
// take a new password, and POST both to /api/auth/reset-password. On
// success we bounce them back to the sign-in form.

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate, useSearchParams, Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import { authApi } from "../api/auth";
import { LiveBriefing } from "../marketing/sections/LiveBriefing";
import "../marketing/sections/LiveBriefing.css";

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Bounce immediately if there's no token — otherwise the user would
  // see a confusing "couldn't reset" after typing.
  useEffect(() => {
    if (!token) setError("Missing reset token. Request a new email from the forgot-password page.");
  }, [token]);

  const mutation = useMutation({
    mutationFn: () => authApi.resetPassword({ newPassword: password, token }),
    onSuccess: () => {
      setError(null);
      setSuccess(true);
      // Hold the success banner for a beat, then send them to sign in.
      window.setTimeout(() => navigate("/auth", { replace: true }), 1800);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Couldn't reset the password.");
    },
  });

  const passwordMismatch = password.length > 0 && confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < 8;
  const canSubmit = !!token && password.length >= 8 && password === confirm;

  return (
    <div className="fixed inset-0 flex bg-surface-page">
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Sparkles className="h-4 w-4 text-text-tertiary" />
            <span className="text-sm font-medium text-text-primary">AgentDash</span>
          </div>

          <h1 className="text-2xl font-semibold text-text-primary">Choose a new password</h1>
          <p className="mt-2 text-sm text-text-secondary">
            At least 8 characters. You'll sign in again with the new password.
          </p>

          {success ? (
            <div className="mt-6 rounded-md border border-border-soft bg-surface-raised p-4 text-sm text-text-primary">
              Password updated. Sending you to the sign-in page…
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
                <label htmlFor="password" className="text-xs text-text-secondary mb-1 block font-medium">
                  New password
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  className="w-full rounded-md border border-border-soft bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-500 focus:ring-2 focus:ring-accent-200 transition-[color,box-shadow]"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                {tooShort && (
                  <p className="mt-1 text-xs text-text-tertiary">At least 8 characters.</p>
                )}
              </div>
              <div>
                <label htmlFor="confirm" className="text-xs text-text-secondary mb-1 block font-medium">
                  Confirm new password
                </label>
                <input
                  id="confirm"
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  className="w-full rounded-md border border-border-soft bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-500 focus:ring-2 focus:ring-accent-200 transition-[color,box-shadow]"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                />
                {passwordMismatch && (
                  <p className="mt-1 text-xs text-danger-500">Passwords don't match.</p>
                )}
              </div>
              {error && <p className="text-xs text-danger-500">{error}</p>}
              <Button
                type="submit"
                disabled={mutation.isPending || !canSubmit}
                aria-disabled={!canSubmit || mutation.isPending}
                className={`w-full ${!canSubmit && !mutation.isPending ? "opacity-50" : ""}`}
              >
                {mutation.isPending ? "Updating…" : "Update password"}
              </Button>
            </form>
          )}

          <div className="mt-5 text-sm text-text-secondary">
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
