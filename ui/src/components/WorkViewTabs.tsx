import type { Issue } from "@paperclipai/shared";
import { Link, useLocation } from "@/lib/router";
import { cn } from "../lib/utils";

/**
 * AgentDash: one UX — the two Inbox views MK used every day, kept on Work.
 *
 * "Touched by me" is the issues the person created, commented on, was
 * assigned or otherwise acted on (the server's `touchedByUserId=me`, the
 * query the old Inbox's Recent tab made). "Unread" narrows that to issues
 * with activity since the person last opened them (`isUnreadForMe`, which
 * the server fills in for a touched-by query). Opening an issue marks it
 * read, as before.
 */
export const WORK_VIEWS = ["all", "touched", "unread"] as const;
export type WorkView = (typeof WORK_VIEWS)[number];

const LABELS: Record<WorkView, string> = {
  all: "All",
  touched: "Touched by me",
  unread: "Unread",
};

export function parseWorkView(value: string | null | undefined): WorkView {
  return (WORK_VIEWS as readonly string[]).includes(value ?? "") ? (value as WorkView) : "all";
}

/** The issue-list filters a view adds (both resolve "me" on the server). */
export function workViewFilters(view: WorkView): { touchedByUserId?: string; unreadForUserId?: string } {
  if (view === "touched") return { touchedByUserId: "me" };
  if (view === "unread") return { touchedByUserId: "me", unreadForUserId: "me" };
  return {};
}

/** Unread is filtered on the server; this keeps a stale page from showing an issue just read. */
export function filterIssuesForWorkView(issues: Issue[], view: WorkView): Issue[] {
  return view === "unread" ? issues.filter((issue) => issue.isUnreadForMe !== false) : issues;
}

/**
 * The Work URL for a view, keeping every other query parameter (search,
 * assignee, workspace, participant agent) as it is.
 */
export function workViewHref(view: WorkView, currentSearch: string): string {
  const params = new URLSearchParams(currentSearch);
  if (view === "all") params.delete("view");
  else params.set("view", view);
  const query = params.toString();
  return query ? `/issues?${query}` : "/issues";
}

export function WorkViewTabs({ view }: { view: WorkView }) {
  const { search } = useLocation();
  return (
    <nav aria-label="Work views" className="flex flex-wrap items-center gap-1" data-testid="work-view-tabs">
      {WORK_VIEWS.map((option) => {
        const active = option === view;
        return (
          <Link
            key={option}
            to={workViewHref(option, search)}
            aria-current={active ? "page" : undefined}
            data-testid={`work-view-${option}`}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors max-sm:inline-flex max-sm:min-h-11 max-sm:min-w-11 max-sm:items-center max-sm:justify-center",
              active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {LABELS[option]}
          </Link>
        );
      })}
    </nav>
  );
}
