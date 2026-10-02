// AgentDash (#767, SC-6): claim a hosted box from the one-time link the
// control plane sends: https://<slug>.agentdash.cloud/claim#code=<code>&email=<email>
// (older links carried the email as ?email=, which still works).
//
// The code travels in the URL FRAGMENT, which browsers never send to a
// server or put in a Referer, and this page removes it from the address bar
// as soon as it has read it. The email is shown read-only: the box accepts
// the code only for that email, only while it has no users, and only once.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
// AgentDash: the brand mark next to the wordmark, same as the app rail and favicon.
import { AgentDashMark } from "@/components/brand/AgentDashMark";
import { useNavigate, useSearchParams, Link } from "@/lib/router";
import { AuthApiError, authApi } from "../api/auth";
import { refreshAccessQueries } from "../lib/access-refresh";
import { Button } from "@/components/ui/button";

export const MIN_CLAIM_PASSWORD_LENGTH = 12;
/** /claim only renders on a box, so "Sign in" is always the box's own sign-in. */
export const CLAIM_SIGN_IN_PATH = "/auth?next=%2F";

/** The claim code from a fragment like `#code=AGD-…` (also tolerates `#AGD-…`). */
export function readClaimCodeFromHash(hash: string): string | null {
  const raw = hash.replace(/^#/, "");
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const code = (params.get("code") ?? (raw.includes("=") ? "" : raw)).trim();
  return code.length > 0 ? code : null;
}

/** The claim email from the fragment (`#code=…&email=…`), or null. */
export function readClaimEmailFromHash(hash: string): string | null {
  const raw = hash.replace(/^#/, "");
  if (!raw.includes("=")) return null;
  const email = (new URLSearchParams(raw).get("email") ?? "").trim();
  return email.length > 0 ? email : null;
}

export function claimErrorMessage(err: unknown): string {
  if (err instanceof AuthApiError) {
    if (err.code === "claim_code_used") return "This claim link has already been used. Sign in with the account that claimed this workspace.";
    if (err.code === "claim_email_mismatch") return "This claim link belongs to a different email address.";
    if (err.code === "invite_code_required") return "This claim link is not valid any more. Ask for a new link from the page where you signed up.";
    if (err.status === 429) return "Too many attempts. Wait a few minutes and try again.";
    return err.message;
  }
  return err instanceof Error ? err.message : "Could not claim this workspace.";
}

export function ClaimPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  // AgentDash (#836): the email rides in the fragment (never logged); ?email= is the older form.
  const [hashEmail] = useState<string | null>(() => (typeof window === "undefined" ? null : readClaimEmailFromHash(window.location.hash)));
  const email = useMemo(() => (hashEmail ?? searchParams.get("email") ?? "").trim(), [hashEmail, searchParams]);
  // Read the fragment once, then drop it from the address bar and history.
  const [code] = useState<string | null>(() => (typeof window === "undefined" ? null : readClaimCodeFromHash(window.location.hash)));
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.hash) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
  }, []);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);

  const passwordProblem =
    password.length > 0 && password.length < MIN_CLAIM_PASSWORD_LENGTH
      ? `Use at least ${MIN_CLAIM_PASSWORD_LENGTH} characters.`
      : repeat.length > 0 && repeat !== password
        ? "The passwords do not match."
        : null;
  const canSubmit =
    Boolean(code) && email.length > 0 && name.trim().length > 0 && password.length >= MIN_CLAIM_PASSWORD_LENGTH && repeat === password;

  const mutation = useMutation({
    mutationFn: async () => {
      await authApi.signUpEmail({ name: name.trim(), email, password, inviteCode: code ?? "" });
      // Sign-up normally starts a session; sign in explicitly if it did not.
      const session = await authApi.getSession().catch(() => null);
      if (!session) await authApi.signInEmail({ email, password });
    },
    onSuccess: async () => {
      setError(null);
      // AgentDash: refetch session, board access and health before the gate sees them.
      await refreshAccessQueries(queryClient);
      navigate("/cos", { replace: true });
    },
    onError: (err) => setError(claimErrorMessage(err)),
  });

  const incomplete = !code || !email;

  return (
    <div className="fixed inset-0 flex overflow-y-auto bg-surface-page">
      <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
        <div className="flex items-center gap-2 mb-8">
          <AgentDashMark size={20} />
          <span className="text-sm font-medium text-text-primary">AgentDash</span>
        </div>
        <h1 className="text-2xl font-semibold text-text-primary">Claim your workspace</h1>
        {incomplete ? (
          <p className="mt-4 text-sm text-text-secondary" role="alert">
            This claim link is incomplete. Open the link from your email again, or ask for a new one from the page where you signed up.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-text-secondary">Create the first account on this workspace. You will be its admin.</p>
            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (mutation.isPending) return;
                if (!canSubmit) {
                  setError(passwordProblem ?? "Please fill in every field.");
                  return;
                }
                mutation.mutate();
              }}
            >
              <div>
                <label htmlFor="claim-email" className="text-xs text-text-secondary mb-1 block">Email</label>
                <input id="claim-email" type="email" value={email} readOnly aria-readonly="true"
                  className="w-full rounded-md border border-border-soft bg-surface-sunken px-3 py-2 text-sm text-text-secondary" />
              </div>
              <div>
                <label htmlFor="claim-name" className="text-xs text-text-secondary mb-1 block">Your name</label>
                <input id="claim-name" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} autoComplete="name" autoFocus
                  className="w-full rounded-md border border-border-soft bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-200" />
              </div>
              <div>
                <label htmlFor="claim-password" className="text-xs text-text-secondary mb-1 block">Password ({MIN_CLAIM_PASSWORD_LENGTH}+ characters)</label>
                <input id="claim-password" type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError(null); }} autoComplete="new-password"
                  className="w-full rounded-md border border-border-soft bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-200" />
              </div>
              <div>
                <label htmlFor="claim-repeat" className="text-xs text-text-secondary mb-1 block">Repeat the password</label>
                <input id="claim-repeat" type="password" value={repeat} onChange={(e) => { setRepeat(e.target.value); setError(null); }} autoComplete="new-password"
                  className="w-full rounded-md border border-border-soft bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-200" />
              </div>
              {(error ?? passwordProblem) && (
                <p className="text-xs text-destructive" role="alert">{error ?? passwordProblem}</p>
              )}
              <Button type="submit" className="w-full" disabled={!canSubmit || mutation.isPending}>
                {mutation.isPending ? "Claiming…" : "Claim workspace"}
              </Button>
            </form>
          </>
        )}
        <p className="mt-6 text-xs text-text-tertiary">
          {/* AgentDash: the box's own sign-in, never www's /find (its API exists only on www). */}
          Already claimed it? <Link to={CLAIM_SIGN_IN_PATH}>Sign in</Link>
        </p>
      </div>
    </div>
  );
}
