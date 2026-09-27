// AgentDash (GH #786, UX-5): what Home adds for the first run. Home already has
// "Working now" and "Plan with your Chief of Staff"; this adds only:
//   - while setup is incomplete: "Finish setting up" with the next step, a link
//     back to /setup (or, when the model key is missing and this person cannot
//     set it, who can);
//   - once the first issue exists: "Connect Muse so you can do this from your
//     phone", linking to the in-app assistant instructions. Dismissible.
// Only when the server says so (`showHomeNudge`): a hosted box, and a company
// created after the first run shipped or one with no issues yet. Established
// companies and self-hosted installs see nothing; /setup stays reachable.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Smartphone, X } from "lucide-react";
import { firstRunApi, type FirstRunStep } from "@/api/firstRun";
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
  Record<Exclude<FirstRunStep, "done">, { text: string; action: string }>
> = {
  repo: {
    text: "Connect a repo so your agents have somewhere to work.",
    action: "Connect GitHub",
  },
};

function dismissKey(companyId: string) {
  return `agentdash.connectAssistantCard.dismissed.${companyId}`;
}

function readDismissed(companyId: string): boolean {
  try {
    return window.localStorage.getItem(dismissKey(companyId)) === "1";
  } catch {
    return false;
  }
}

export function FirstRunHomeNudges({ companyId }: { companyId: string }) {
  const [dismissed, setDismissed] = useState(() => readDismissed(companyId));
  const { data } = useQuery({
    queryKey: queryKeys.firstRun(companyId),
    queryFn: () => firstRunApi.status(companyId),
  });
  if (!data || !data.applies || !data.showHomeNudge) return null;

  if (data.nextStep !== "done") {
    if (!data.canManage) return null;
    const blockedOnModel = data.nextStep === "model" && !data.canConfigureModel;
    return (
      <section
        className="rounded-xl border border-border bg-card px-4 py-3 text-sm"
        data-testid="first-run-home-resume"
        aria-label="Finish setting up"
      >
        <div className="font-semibold">Finish setting up</div>
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

  if (dismissed) return null;
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
          try {
            window.localStorage.setItem(dismissKey(companyId), "1");
          } catch {
            // per-viewer convenience only
          }
          setDismissed(true);
        }}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}
