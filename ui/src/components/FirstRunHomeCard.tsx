// AgentDash (GH #786, UX-5): the first run's landing card on Home.
//
// While setup is incomplete it says what is next and links back to /setup (so
// a founder who left mid-flow can resume from Home). Once the first issue
// exists it shows it in "Working now", offers "Plan with your Chief of Staff"
// (the CoS interview, now optional) and "Connect Muse so you can do this from
// your phone". Dismissible per workspace. Default profile only: the server
// reports `applies: false` for agentdash_mk and the card renders nothing.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { firstRunApi, type FirstRunStep } from "@/api/firstRun";
import { queryKeys } from "@/lib/queryKeys";

const NEXT_LABEL: Record<Exclude<FirstRunStep, "done">, string> = {
  model: "connect a model provider",
  repo: "connect your GitHub repo",
  first_issue: "tell your team what to build first",
};

function dismissKey(companyId: string) {
  return `agentdash.firstRunHomeCard.dismissed.${companyId}`;
}

function readDismissed(companyId: string): boolean {
  try {
    return window.localStorage.getItem(dismissKey(companyId)) === "1";
  } catch {
    return false;
  }
}

export function FirstRunHomeCard({ companyId, issuePrefix }: { companyId: string; issuePrefix: string }) {
  const [dismissed, setDismissed] = useState(() => readDismissed(companyId));
  const { data } = useQuery({
    queryKey: queryKeys.firstRun(companyId),
    queryFn: () => firstRunApi.status(companyId),
    refetchInterval: (query) => (query.state.data?.nextStep === "done" ? 15_000 : false),
  });
  if (!data || !data.applies) return null;

  if (data.nextStep !== "done") {
    if (!data.canManage) return null;
    return (
      <div className="mt-6 rounded-lg border border-border bg-card p-4 text-sm" data-testid="first-run-home-resume">
        <div className="font-semibold">Finish setting up</div>
        <p className="mt-1 text-muted-foreground">Next: {NEXT_LABEL[data.nextStep]}.</p>
        <a className="mt-3 inline-block font-medium underline" href="/setup">
          Continue setup
        </a>
      </div>
    );
  }

  if (dismissed) return null;
  const issue = data.firstIssue;
  const issueHref = issue.identifier ? `/${issuePrefix}/issues/${issue.identifier}` : null;
  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-4 text-sm" data-testid="first-run-home-card">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Working now</div>
          <p className="mt-1">
            {issueHref ? (
              <a className="font-medium underline" href={issueHref}>
                {issue.identifier} {issue.title}
              </a>
            ) : (
              <span className="font-medium">{issue.title}</span>
            )}
            {issue.assigneeName ? <span className="text-muted-foreground"> · {issue.assigneeName}</span> : null}
            {issue.status ? <span className="text-muted-foreground"> · {issue.status.replace(/_/g, " ")}</span> : null}
          </p>
          <p className="mt-1 text-muted-foreground">
            Your engineer works on a branch and opens a pull request. The first one usually takes 20 to 30 minutes.
          </p>
        </div>
        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          onClick={() => {
            try {
              window.localStorage.setItem(dismissKey(companyId), "1");
            } catch {
              // per-viewer convenience only
            }
            setDismissed(true);
          }}
        >
          Dismiss
        </button>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <a className="rounded-md border border-border px-3 py-2 hover:bg-muted" href="/cos" data-testid="plan-with-cos">
          <div className="font-medium">Plan with your Chief of Staff</div>
          <div className="text-xs text-muted-foreground">Talk through goals and the team you need. Optional.</div>
        </a>
        <a className="rounded-md border border-border px-3 py-2 hover:bg-muted" href="/mcp" data-testid="connect-muse">
          <div className="font-medium">Connect Muse so you can do this from your phone</div>
          <div className="text-xs text-muted-foreground">Ask for work and hear what shipped from your assistant.</div>
        </a>
      </div>
    </div>
  );
}
