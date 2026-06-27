// AgentDash (Test Drive, Slice 2): the PUBLIC no-signup trial experience.
//
// A single full-screen page with three visual states — LAND (hero + form),
// WORKING (watch Scout draft), and ARTIFACT (the outreach sequence) — plus a
// friendly credit-exhausted state. Routed at /trial OUTSIDE CloudAccessGate
// (see ui/src/App.tsx), so there is no sidebar, no auth, no company context.
//
// Backend: server/src/routes/trial.ts (Slice 1). The trial token is the only
// credential; we persist it in sessionStorage so a refresh resumes the run.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  Copy,
  Loader2,
  Mail,
  Linkedin,
  Lightbulb,
  Sparkles,
  Target,
} from "lucide-react";
import { Link } from "@/lib/router";
import { ApiError } from "../api/client";
import {
  trialApi,
  type TrialArtifact,
  type TrialOutreachContent,
} from "../api/trial";

type View = "land" | "working" | "artifact" | "exhausted";

const TRIAL_TOKEN_KEY = "agentdash.trial.token";

const WORKING_STATUS_LINES = [
  "reading your market…",
  "researching the angle…",
  "drafting touch 1 of 3…",
  "drafting touch 2 of 3…",
  "drafting touch 3 of 3…",
  "polishing the copy…",
];

function readStoredToken(): string | null {
  try {
    return window.sessionStorage.getItem(TRIAL_TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeStoredToken(token: string | null) {
  try {
    if (token) window.sessionStorage.setItem(TRIAL_TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TRIAL_TOKEN_KEY);
  } catch {
    /* sessionStorage unavailable (private mode) — token still lives in state */
  }
}

function formatDollars(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

function buildPlainText(artifact: TrialArtifact): string {
  const { title, content } = artifact;
  const lines: string[] = [title, "", content.summary, ""];
  for (const touch of content.touches) {
    lines.push(`— Day ${touch.day} · ${touch.channel} —`);
    if (touch.subject) lines.push(`Subject: ${touch.subject}`);
    lines.push(touch.body, "");
  }
  if (content.tips.length > 0) {
    lines.push("Tips:");
    for (const tip of content.tips) lines.push(`• ${tip}`);
  }
  return lines.join("\n").trim();
}

function channelIcon(channel: string) {
  const c = channel.toLowerCase();
  if (c.includes("linkedin")) return <Linkedin className="size-3.5" />;
  return <Mail className="size-3.5" />;
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

function ScoutChip() {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground">
      <span className="flex size-6 items-center justify-center rounded-full bg-[var(--accent-500)] text-white">
        <Target className="size-3.5" />
      </span>
      Scout
    </span>
  );
}

function WorkingState({ reducedMotion }: { reducedMotion: boolean }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reducedMotion) return;
    const id = window.setInterval(() => {
      setStep((s) => Math.min(s + 1, WORKING_STATUS_LINES.length - 1));
    }, 2600);
    return () => window.clearInterval(id);
  }, [reducedMotion]);

  if (reducedMotion) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-5 py-16 text-center">
        <ScoutChip />
        <div className="flex items-center gap-3 text-base text-foreground">
          <Loader2 className="size-5 animate-spin text-[var(--accent-500)]" />
          Scout is drafting your sequence…
        </div>
      </div>
    );
  }

  const progress = Math.round(((step + 1) / WORKING_STATUS_LINES.length) * 90);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-6 py-16 text-center">
      <div className="relative">
        <span className="absolute inset-0 animate-ping rounded-full bg-[var(--accent-500)]/25" />
        <span className="relative flex size-16 items-center justify-center rounded-full bg-[var(--accent-500)] text-white">
          <Target className="size-7" />
        </span>
      </div>
      <div>
        <p className="text-lg font-semibold text-foreground">Scout is on it</p>
        <p
          key={step}
          className="mt-1 text-base text-muted-foreground transition-opacity duration-500"
        >
          {WORKING_STATUS_LINES[step]}
        </p>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-[var(--accent-500)] transition-all duration-700 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        a real agent is doing a real piece of work — give it a few seconds
      </p>
    </div>
  );
}

function CreditMeter({
  remainingCents,
  totalCents,
}: {
  remainingCents: number;
  totalCents: number;
}) {
  const pct =
    totalCents > 0 ? Math.max(0, Math.min(100, (remainingCents / totalCents) * 100)) : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-border">
        <div
          className="h-full rounded-full bg-[var(--success-500)] transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground">
        {formatDollars(remainingCents)} of {formatDollars(totalCents)} free credit left
      </span>
    </div>
  );
}

function TouchCard({
  touch,
}: {
  touch: TrialOutreachContent["touches"][number];
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-50,rgba(0,0,0,0.04))] px-2.5 py-1 text-xs font-medium text-[var(--accent-600,var(--accent-500))]">
        {channelIcon(touch.channel)}
        Day {touch.day} · {touch.channel}
      </span>
      {touch.subject ? (
        <p className="mt-3 font-semibold text-foreground">{touch.subject}</p>
      ) : null}
      <p className="mt-2 whitespace-pre-line text-sm leading-6 text-foreground">
        {touch.body}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function TrialLandingPage() {
  const reducedMotion = usePrefersReducedMotion();

  const [view, setView] = useState<View>("land");
  const [token, setToken] = useState<string | null>(null);
  const [icp, setIcp] = useState("");
  const [senderContext, setSenderContext] = useState("");
  const [artifact, setArtifact] = useState<TrialArtifact | null>(null);
  const [creditCents, setCreditCents] = useState(0);
  const [creditRemainingCents, setCreditRemainingCents] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  // Resume from a prior session on refresh (best-effort).
  useEffect(() => {
    const stored = readStoredToken();
    if (!stored) return;
    setToken(stored);
    let cancelled = false;
    trialApi
      .getSnapshot(stored)
      .then((snap) => {
        if (cancelled) return;
        setCreditCents(snap.session.creditCents);
        setCreditRemainingCents(snap.session.creditRemainingCents);
        const latest = snap.artifacts[snap.artifacts.length - 1];
        if (latest) {
          setArtifact({ title: latest.title, content: latest.content });
          setView("artifact");
        }
      })
      .catch(() => {
        // Stale/expired token — drop it and stay on the landing form.
        writeStoredToken(null);
        setToken(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const runMutation = useMutation({
    mutationFn: async () => {
      let activeToken = token;
      if (!activeToken) {
        const session = await trialApi.createSession();
        activeToken = session.token;
        setToken(activeToken);
        setCreditCents(session.creditCents);
        setCreditRemainingCents(session.creditCents);
        writeStoredToken(activeToken);
      }
      return trialApi.run(activeToken, "sales_outreach", {
        icp: icp.trim(),
        senderContext: senderContext.trim() || undefined,
      });
    },
    onMutate: () => {
      setError(null);
      setView("working");
    },
    onSuccess: (result) => {
      setArtifact(result.artifact);
      setCreditCents(result.creditCents);
      setCreditRemainingCents(result.creditRemainingCents);
      setView("artifact");
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        if (err.status === 402) {
          setView("exhausted");
          return;
        }
        if (err.status === 410) {
          writeStoredToken(null);
          setToken(null);
          setError("your trial session expired — start a fresh one below.");
          setView("land");
          return;
        }
        if (err.status === 404) {
          writeStoredToken(null);
          setToken(null);
          setError("we lost track of that session — try running it again.");
          setView("land");
          return;
        }
        setError(
          err.status === 0
            ? "couldn't reach the server — check your connection and try again."
            : err.message || "something went wrong — give it another go.",
        );
      } else {
        setError("something went wrong — give it another go.");
      }
      setView("land");
    },
  });

  const canSubmit = icp.trim().length > 0 && !runMutation.isPending;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    runMutation.mutate();
  }

  function handleRunAnother() {
    setArtifact(null);
    setError(null);
    setView("land");
  }

  async function handleCopy() {
    if (!artifact) return;
    try {
      await navigator.clipboard.writeText(buildPlainText(artifact));
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("couldn't copy to your clipboard — select the text manually.");
    }
  }

  const heroTitleClass =
    "text-4xl font-bold leading-[1.05] tracking-[-0.04em] text-foreground sm:text-5xl";

  return (
    <div className="min-h-screen bg-background px-6 py-12 text-foreground">
      <div className="mx-auto w-full max-w-2xl">
        {/* LAND ---------------------------------------------------------- */}
        {view === "land" ? (
          <div className="flex flex-col items-center text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              <Sparkles className="size-3.5 text-[var(--accent-500)]" />
              no signup · 90 seconds
            </span>
            <h1 className={`mt-6 ${heroTitleClass}`}>
              watch an AI agent do a real piece of your job
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground">
              tell Scout who you&apos;re selling to. it&apos;ll draft a
              personalized 3-touch cold-outreach sequence — the kind of thing your
              SDR would spend an afternoon on. no account, no card.
            </p>

            <form
              onSubmit={handleSubmit}
              className="mt-8 w-full max-w-xl space-y-4 text-left"
            >
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-foreground">
                  who are you selling to?
                </span>
                <textarea
                  value={icp}
                  onChange={(e) => setIcp(e.target.value)}
                  rows={3}
                  required
                  autoFocus
                  placeholder="heads of ops at 50-200 person freight brokerages"
                  className="w-full resize-none rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-[var(--accent-500)]"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-foreground">
                  what do you sell?{" "}
                  <span className="font-normal text-muted-foreground">(optional)</span>
                </span>
                <input
                  value={senderContext}
                  onChange={(e) => setSenderContext(e.target.value)}
                  placeholder="a TMS that cuts back-office hours in half"
                  className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-[var(--accent-500)]"
                />
              </label>

              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[var(--accent-500)] px-6 py-3.5 text-base font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Run it
                <ArrowRight className="size-5" />
              </button>
            </form>

            <p className="mt-10 text-xs text-muted-foreground">
              already have an account?{" "}
              <Link
                to="/auth"
                className="text-foreground underline underline-offset-2 hover:text-[var(--accent-500)]"
              >
                sign in
              </Link>
            </p>
          </div>
        ) : null}

        {/* WORKING ------------------------------------------------------- */}
        {view === "working" ? <WorkingState reducedMotion={reducedMotion} /> : null}

        {/* ARTIFACT ------------------------------------------------------ */}
        {view === "artifact" && artifact ? (
          <div className="space-y-6">
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
                    {artifact.title}
                  </h1>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Target className="size-3.5 text-[var(--accent-500)]" />
                    drafted autonomously by Scout
                  </p>
                </div>
                <CreditMeter
                  remainingCents={creditRemainingCents}
                  totalCents={creditCents}
                />
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-card p-5">
              <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                the angle
              </p>
              <p className="mt-2 text-sm leading-6 text-foreground">
                {artifact.content.summary}
              </p>
            </div>

            <div className="space-y-4">
              {artifact.content.touches.map((touch, i) => (
                <TouchCard key={i} touch={touch} />
              ))}
            </div>

            {artifact.content.tips.length > 0 ? (
              <div className="rounded-2xl border border-border bg-card p-5">
                <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                  <Lightbulb className="size-3.5 text-[var(--accent-500)]" />
                  tips before you send
                </p>
                <ul className="mt-3 space-y-2">
                  {artifact.content.tips.map((tip, i) => (
                    <li
                      key={i}
                      className="flex gap-2 text-sm leading-6 text-muted-foreground"
                    >
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-[var(--accent-500)]" />
                      {tip}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-6">
              <Link
                to="/auth"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent-500)] px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                <Sparkles className="size-4" />
                keep this + get free credit
              </Link>
              <button
                type="button"
                onClick={handleRunAnother}
                className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-[var(--accent-500)]"
              >
                run another
              </button>
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-[var(--accent-500)]"
              >
                {copied ? (
                  <>
                    <Check className="size-4 text-[var(--success-500)]" />
                    copied
                  </>
                ) : (
                  <>
                    <Copy className="size-4" />
                    copy
                  </>
                )}
              </button>
            </div>
          </div>
        ) : null}

        {/* EXHAUSTED ----------------------------------------------------- */}
        {view === "exhausted" ? (
          <div className="mx-auto flex max-w-md flex-col items-center gap-5 py-16 text-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-[var(--accent-500)] text-white">
              <Sparkles className="size-6" />
            </span>
            <div>
              <h1 className="text-2xl font-bold tracking-[-0.02em] text-foreground">
                you&apos;ve used your free taste
              </h1>
              <p className="mt-2 text-base leading-7 text-muted-foreground">
                sign up to keep Scout, get more credit, and put it to work on your
                real pipeline.
              </p>
            </div>
            <Link
              to="/auth"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent-500)] px-6 py-3 text-base font-semibold text-white transition-opacity hover:opacity-90"
            >
              sign up to keep Scout
              <ArrowRight className="size-5" />
            </Link>
            {artifact ? (
              <button
                type="button"
                onClick={() => setView("artifact")}
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                back to your draft
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
