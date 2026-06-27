// AgentDash (Test Drive, Slice 3): the PUBLIC, read-only shared-artifact view.
//
// Reached at /share/:shareToken — rendered OUTSIDE CloudAccessGate (see
// ui/src/App.tsx), so there is no sidebar, no auth, no company context. A
// colleague opens the link, sees an artifact an AgentDash agent drafted
// autonomously, and gets a single CTA to run one on their own work.
//
// Backend: GET /api/trial/share/:shareToken (server/src/routes/trial.ts).

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Sparkles, Target } from "lucide-react";
import { Link, useParams } from "@/lib/router";
import { trialApi } from "../api/trial";
import { ArtifactView } from "../components/trial/ArtifactView";

export function SharedArtifactPage() {
  const { shareToken } = useParams<{ shareToken?: string }>();

  const query = useQuery({
    queryKey: ["trial", "share", shareToken],
    queryFn: () => trialApi.getShared(shareToken as string),
    enabled: !!shareToken,
    retry: false,
  });

  return (
    <div className="min-h-screen bg-background px-6 py-12 text-foreground">
      <div className="mx-auto w-full max-w-2xl">
        {query.isLoading ? (
          <p className="py-16 text-center text-sm text-muted-foreground">loading…</p>
        ) : query.isError || !query.data ? (
          <div className="mx-auto flex max-w-md flex-col items-center gap-5 py-16 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-[var(--accent-500)] text-white">
              <Sparkles className="size-6" />
            </span>
            <div>
              <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
                this link isn&apos;t available
              </h1>
              <p className="mt-2 text-base leading-7 text-muted-foreground">
                the shared draft may have expired or the link is wrong. you can
                still run your own in about 90 seconds.
              </p>
            </div>
            <Link
              to="/trial"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent-500)] px-6 py-3 text-base font-semibold text-white transition-opacity hover:opacity-90"
            >
              run one on your own work
              <ArrowRight className="size-5" />
            </Link>
          </div>
        ) : (
          <div className="space-y-6">
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              <Sparkles className="size-3.5 text-[var(--accent-500)]" />
              drafted autonomously by an AgentDash agent
            </span>

            <div>
              <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
                {query.data.title}
              </h1>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                <Target className="size-3.5 text-[var(--accent-500)]" />
                {query.data.agentName
                  ? `${query.data.agentName} did this on its own — no human wrote it`
                  : "an AgentDash agent did this on its own — no human wrote it"}
              </p>
            </div>

            <ArtifactView content={query.data.content} />

            <div className="rounded-2xl border border-border bg-card p-6 text-center">
              <p className="text-base font-semibold text-foreground">
                want one of these for your own pipeline?
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                no signup, no card — watch an agent draft it in about 90 seconds.
              </p>
              <Link
                to="/trial"
                className="mt-4 inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent-500)] px-6 py-3 text-base font-semibold text-white transition-opacity hover:opacity-90"
              >
                run one on your own work
                <ArrowRight className="size-5" />
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
