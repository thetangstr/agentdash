// AgentDash (GH #786, UX-5): what Home adds for the first run. Home already has
// "Working now" and "Plan with your Chief of Staff"; this adds only:
//   - while setup is incomplete: "Finish setting up" with the next step, a link
//     back to /setup (or, when the model key is missing and this person cannot
//     set it, who can);
//   - once the first issue exists: "Connect Muse so you can do this from your
//     phone", linking to the in-app assistant instructions. Dismissible.
// The repo step is optional (not every company works in code): it reads
// "Working with code? Connect GitHub", can be dismissed per person per company
// (stored server-side as the `home:connect-github` dismissal, which is keyed
// by the signed-in user; no browser copy, since a browser can be shared by
// several people), and disappears once the company ships work without one.
// Only when the server says so (`showHomeNudge`): a hosted box, and a company
// created after the first run shipped or one with no issues yet. Established
// companies and self-hosted installs see nothing; /setup stays reachable.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Smartphone, X } from "lucide-react";
import { assistantGrantsApi } from "@/api/assistant-grants";
import { firstRunApi, type FirstRunStatus, type FirstRunStep } from "@/api/firstRun";
import { inboxDismissalsApi } from "@/api/inboxDismissals";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

const NEXT_LABEL: Record<Exclude<FirstRunStep, "done">, string> = {
  model: "connect a model provider",
  repo: "connect your GitHub repo",
  first_issue: "tell your team what to build first",
};

// AgentDash: UX-11 — the repo step speaks the plan's empty-state copy and
// names the action after what it does, not the setup flow it resumes.
const STEP_COPY: Partial<
  Record<Exclude<FirstRunStep, "done">, { title?: string; text: string; action: string }>
> = {
  repo: {
    title: "Working with code? Connect GitHub",
    text: "Connect a repo so your agents have somewhere to work. Skip this if your team does not work in code.",
    action: "Connect GitHub",
  },
};

/** The server-side dismissal key for the optional GitHub step (per person, per company). */
export const CONNECT_GITHUB_DISMISSAL_KEY = "home:connect-github";

function dismissKey(companyId: string) {
  return `agentdash.connectAssistantCard.dismissed.${companyId}`;
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // per-viewer convenience only
  }
}

/** Whether Home should offer the optional GitHub step at all. */
export function repoStepHidden(status: Partial<Pick<FirstRunStatus, "repo">>, dismissed: boolean): boolean {
  return dismissed || Boolean(status.repo?.shippedWithoutRepo);
}

export function FirstRunHomeNudges({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [dismissed, setDismissed] = useState(() => readFlag(dismissKey(companyId)));
  // Hides the card at once, before (or even if) the server save lands.
  const [githubDismissedNow, setGithubDismissedNow] = useState(false);
  const { data } = useQuery({
    queryKey: queryKeys.firstRun(companyId),
    queryFn: () => firstRunApi.status(companyId),
  });
  // The person's dismissals, read only while the repo step is the next one.
  const dismissalsKey = ["home", companyId, "dismissals"] as const;
  const dismissals = useQuery({
    queryKey: dismissalsKey,
    queryFn: () => inboxDismissalsApi.list(companyId),
    enabled: data?.nextStep === "repo" && data.applies && data.showHomeNudge && data.canManage,
    retry: false,
  });
  const dismissGithub = useMutation({
    mutationFn: () => inboxDismissalsApi.dismiss(companyId, CONNECT_GITHUB_DISMISSAL_KEY),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: dismissalsKey });
    },
  });
  const githubDismissed =
    githubDismissedNow ||
    (Array.isArray(dismissals.data) &&
      dismissals.data.some((dismissal) => dismissal.itemKey === CONNECT_GITHUB_DISMISSAL_KEY));
  // AgentDash (GH #793): once a grant exists the card has done its job — only
  // ask while the person has no assistant connected. Queried lazily so a
  // mid-setup company never calls it.
  const grants = useQuery({
    queryKey: ["assistant", "me", "grants", companyId],
    queryFn: () => assistantGrantsApi.listMine(companyId),
    enabled: data?.nextStep === "done" && data.applies && data.showHomeNudge,
    retry: false,
  });
  if (!data || !data.applies || !data.showHomeNudge) return null;

  if (data.nextStep !== "done") {
    if (!data.canManage) return null;
    if (data.nextStep === "repo" && repoStepHidden(data, githubDismissed)) return null;
    const optionalRepo = data.nextStep === "repo";
    const blockedOnModel = data.nextStep === "model" && !data.canConfigureModel;
    return (
      <section
        className="relative rounded-xl border border-border bg-card px-4 py-3 text-sm"
        data-testid="first-run-home-resume"
        aria-label={optionalRepo ? "Connect GitHub (optional)" : "Finish setting up"}
      >
        <div className={optionalRepo ? "pr-7 font-semibold" : "font-semibold"}>{STEP_COPY[data.nextStep]?.title ?? "Finish setting up"}</div>
        {optionalRepo ? (
          <button
            type="button"
            aria-label="Dismiss the Connect GitHub card"
            className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => {
              setGithubDismissedNow(true);
              dismissGithub.mutate();
            }}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
        {blockedOnModel ? (
          <p className="mt-1 text-muted-foreground">
            Your agents need a model provider key before they can work. The instance administrator adds it; ask them
            to open setup.
          </p>
        ) : (
          <>
            {STEP_COPY[data.nextStep] ? (
              <p className="mt-1 text-muted-foreground">{STEP_COPY[data.nextStep]!.text}</p>
            ) : (
              <p className="mt-1 text-muted-foreground">Next: {NEXT_LABEL[data.nextStep]}.</p>
            )}
            <Button asChild size="sm" className="mt-3">
              <Link to="/setup">{STEP_COPY[data.nextStep]?.action ?? "Continue setup"}</Link>
            </Button>
          </>
        )}
      </section>
    );
  }

  if (dismissed || (grants.data?.grants.length ?? 0) > 0) return null;
  return (
    <section
      className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm"
      data-testid="connect-muse"
      aria-label="Connect your assistant"
    >
      <Smartphone className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">Connect Muse so you can do this from your phone</div>
        <p className="mt-1 text-muted-foreground">Ask for work and hear what shipped from your assistant.</p>
        <Button asChild size="sm" variant="outline" className="mt-3">
          <Link to="/connect-assistant">Show me how</Link>
        </Button>
      </div>
      <button
        type="button"
        aria-label="Dismiss the Connect Muse card"
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => {
          writeFlag(dismissKey(companyId));
          setDismissed(true);
        }}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}
