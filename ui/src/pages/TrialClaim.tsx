// AgentDash (Test Drive, Slice 4): the post-signup claim handoff.
//
// Reached at /trial/claim AFTER the user has authenticated (the conversion CTA
// on /trial routes here via /auth?next=/trial/claim). On mount it reads the
// trial token stashed in localStorage, calls POST /api/trial/:token/claim to
// bind the ephemeral trial workspace to the now-signed-in account (owner
// membership + free tier + signup credit), then redirects into the claimed
// company's dashboard. No token / a failed claim shows a friendly fallback.

import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { Link, useNavigate } from "@/lib/router";
import { ApiError } from "../api/client";
import { trialApi } from "../api/trial";
import { clearTrialStorage, readStoredToken } from "../lib/trial-storage";
import { queryKeys } from "../lib/queryKeys";

export function TrialClaimPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const ranRef = useRef(false);

  const claim = useMutation({
    mutationFn: async () => {
      const token = readStoredToken();
      if (!token) throw new Error("no_token");
      return trialApi.claim(token);
    },
    onSuccess: async (result) => {
      clearTrialStorage();
      // Make the freshly-bound company visible to the gate + company context
      // before we route into it.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.companies.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess }),
      ]);
      const dest = result.companyPrefix
        ? `/${result.companyPrefix}/dashboard`
        : "/";
      navigate(dest, { replace: true });
    },
    onError: (err) => {
      if (err instanceof Error && err.message === "no_token") {
        setError(
          "we couldn't find a trial to claim — it may already be linked to your account.",
        );
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        clearTrialStorage();
        setError("this trial has already been claimed by another account.");
        return;
      }
      setError("we couldn't finish setting up your workspace — head into the app to continue.");
    },
  });

  // Fire exactly once on mount (StrictMode double-invoke guard).
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    claim.mutate();
  }, [claim]);

  if (error) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-5 py-20 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-[var(--accent-500)] text-white">
          <Sparkles className="size-6" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
            almost there
          </h1>
          <p className="mt-2 text-base leading-7 text-muted-foreground">{error}</p>
        </div>
        <Link
          to="/"
          className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent-500)] px-6 py-3 text-base font-semibold text-white transition-opacity hover:opacity-90"
        >
          go to the app
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-20 text-center">
      <Loader2 className="size-6 animate-spin text-[var(--accent-500)]" />
      <p className="text-base text-foreground">setting up your workspace…</p>
      <p className="text-sm text-muted-foreground">
        keeping Scout, your draft, and your free credit.
      </p>
    </div>
  );
}
