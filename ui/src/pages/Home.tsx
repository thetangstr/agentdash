import { PendingQuestionRow } from "../components/WorkforceQuestions";
// AgentDash: one-UX (doc/plans/2026-09-30-one-ux.md) — the one Dashboard every
// company lands on at /dashboard, titled "Home" to match the sidebar.
//
// Top half, UX-3 (#784): Waiting on you, Working now, Shipped this week, with
// the hosted first-run nudges (#786) above them. Bottom half: the control-plane
// panels (components/dashboard/ControlPlanePanels) — agents, open issues,
// spend, the agent fleet and recent activity. It never branches on the profile.
// Every number is rendered directly from the list it counts — no count-up
// animation, so a tab that was in the background shows the real numbers the
// moment it is looked at.
import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, MessageSquare, PackageCheck, RadioTower, ShieldQuestion } from "lucide-react";
import type { WaitingOnYou, WorkingNowItem } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { dashboardApi } from "../api/dashboard";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { issueUrl } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { ShippedWorkProductRow } from "../components/ShippedWorkProductRow";
import { ReviewWaitingRow } from "../components/ReviewWaitingRow";
import { decisionsListLength, useDecisionsCount } from "../hooks/useDecisionsBadge";
import { FirstRunHomeNudges } from "../components/FirstRunHomeNudges";
import { ControlPlanePanels } from "../components/dashboard/ControlPlanePanels";
import { useIsPhone } from "../hooks/useIsPhone";

export const HOME_LIST_LIMIT = 6;
export const WAITING_EMPTY_TEXT = "Nothing needs you right now. Decisions and issues assigned to you show up here.";
export const WORKING_EMPTY_TEXT = "No agent is working right now.";
export const SHIPPED_WEEK_EMPTY_TEXT = "Nothing shipped this week yet. Work you accept shows up here, with what it cost.";
// AgentDash: mobile lists — the one-line phone versions of the empty states.
export const WAITING_EMPTY_SHORT_TEXT = "Nothing needs you right now.";
export const SHIPPED_WEEK_EMPTY_SHORT_TEXT = "Nothing shipped this week yet.";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The first word of a person's name; null for the synthetic local operator. */
export function firstNameFor(user: { id?: string | null; name?: string | null } | null | undefined): string | null {
  if (!user) return null;
  if (user.id === "local-board") return null;
  const first = (user.name ?? "").trim().split(/\s+/)[0] ?? "";
  if (!first || /^(board|local)$/i.test(first)) return null;
  return first;
}

export function greetingFor(date: Date): string {
  const h = date.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** "4m", "1h 12m", "2d" — how long a run has been going. */
export function formatElapsed(fromIso: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 60_000));
  if (minutes < 1) return "just started";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Waiting on you = waiting approvals, manual issues assigned to you,
 *  questions and reviews waiting —
 *  the one definition in useDecisionsBadge that the badge also reads. */
export function waitingCount(data: WaitingOnYou | undefined): number {
  return decisionsListLength(data);
}

function Block({
  title,
  count,
  action,
  testId,
  children,
}: {
  title: string;
  count: number | null;
  action?: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card" data-testid={testId} aria-label={title}>
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          {count !== null ? (
            <span
              data-testid={`${testId}-count`}
              className="inline-flex min-w-6 items-center justify-center rounded-full bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums"
            >
              {count}
            </span>
          ) : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function ErrorLine({ what }: { what: string }) {
  return (
    <div role="alert" className="px-4 py-5 text-sm text-destructive" data-testid="home-block-error">
      Couldn't load {what}. It retries on its own; refresh to try now.
    </div>
  );
}

function EmptyLine({
  icon: Icon,
  text,
  shortText,
  action,
}: {
  icon: typeof CircleCheck;
  text: string;
  /** What a phone shows instead: one compact line next to the icon. */
  shortText?: string;
  action?: ReactNode;
}) {
  const isPhone = useIsPhone();
  if (isPhone) {
    return (
      <div className="flex min-h-11 items-center gap-2 px-4 py-2 text-xs text-muted-foreground" data-testid="home-empty-line">
        <Icon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1">{shortText ?? text}</span>
        {action}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-5 text-sm text-muted-foreground sm:flex-row sm:items-center">
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1">{text}</span>
      {action}
    </div>
  );
}

function MoreLine({ count, to, noun }: { count: number; to: string; noun: string }) {
  if (count <= 0) return null;
  return (
    <Link to={to} className="block px-4 py-2 text-xs text-muted-foreground hover:text-foreground hover:underline max-sm:py-3.5">
      and {count} more {noun}
    </Link>
  );
}

function WaitingOnYouBlock({
  data,
  failed,
  otherCount,
}: {
  data: WaitingOnYou | undefined;
  failed: boolean;
  /** Items Decisions shows beyond its main list (steward asks, questions, failed runs, …). */
  otherCount: number;
}) {
  const { selectedCompanyId } = useCompany();
  const decisions = data?.decisions ?? [];
  const tasks = data?.tasksAssignedToYou ?? [];
  const shownDecisions = decisions.slice(0, HOME_LIST_LIMIT);
  const shownTasks = tasks.slice(0, HOME_LIST_LIMIT);
  const moreDecisions = (data?.total ?? 0) - shownDecisions.length;
  const moreTasks = (data?.tasksAssignedToYouTotal ?? 0) - shownTasks.length;
  // The same total the sidebar badge and the Decisions header show.
  const count = waitingCount(data) + otherCount;
  return (
    <Block title="Waiting on you" count={data ? count : null} testId="home-waiting">
      {failed && !data ? <ErrorLine what="what is waiting on you" /> : null}
      {data && count === 0 ? <EmptyLine icon={CircleCheck} text={WAITING_EMPTY_TEXT} shortText={WAITING_EMPTY_SHORT_TEXT} /> : null}
      <ul className="divide-y divide-border">
        {shownDecisions.map((decision) => (
          <li key={decision.approvalId} data-testid="home-waiting-row" className="flex items-start gap-3 px-4 py-2.5">
            <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <Link to={`/approvals/${decision.approvalId}`} className="text-sm font-medium hover:underline">
                {decision.summary}
              </Link>
              <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                <span>Decision</span>
                {decision.relatedItem ? (
                  <>
                    <span aria-hidden>·</span>
                    <span>
                      {decision.relatedItem.identifier ? `${decision.relatedItem.identifier} ` : ""}
                      {decision.relatedItem.title ?? ""}
                    </span>
                  </>
                ) : null}
                {decision.waitingSince ? (
                  <>
                    <span aria-hidden>·</span>
                    <span>waiting {timeAgo(decision.waitingSince)}</span>
                  </>
                ) : null}
                {!decision.canDecide ? (
                  <>
                    <span aria-hidden>·</span>
                    <span>someone else decides this</span>
                  </>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {(data?.reviewsWaiting?.length ?? 0) > 0 ? (
        <ul className="divide-y divide-border border-t border-border">
          {data!.reviewsWaiting!.slice(0, HOME_LIST_LIMIT).map((review) => (
            <ReviewWaitingRow key={review.issueId} review={review} testId="home-waiting-row" />
          ))}
        </ul>
      ) : null}
      <MoreLine
        count={(data?.reviewsWaitingTotal ?? 0) - Math.min(data?.reviewsWaiting?.length ?? 0, HOME_LIST_LIMIT)}
        to="/decisions"
        noun="reviews"
      />
      {selectedCompanyId && <ul className="divide-y border-t">{data?.pendingQuestions?.slice(0, HOME_LIST_LIMIT).map(question => <PendingQuestionRow key={`${selectedCompanyId}:${question.interactionId}`} companyId={selectedCompanyId} question={question}/>)}</ul>}
      <MoreLine count={(data?.pendingQuestionsTotal ?? 0) - Math.min(data?.pendingQuestions?.length ?? 0, HOME_LIST_LIMIT)} to="/decisions" noun="questions"/>
      {/* UX-7 (#788): the rest of this list lives on the Decisions page now. */}
      <MoreLine count={moreDecisions} to="/decisions" noun={moreDecisions === 1 ? "decision" : "decisions"} />
      <ul className={shownDecisions.length > 0 ? "divide-y divide-border border-t border-border" : "divide-y divide-border"}>
        {shownTasks.map((task) => (
          <li key={task.issueId} data-testid="home-waiting-row" className="flex items-start gap-3 px-4 py-2.5">
            <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
            <div className="min-w-0 flex-1">
              <Link to={issueUrl({ id: task.issueId, identifier: task.identifier })} className="text-sm font-medium hover:underline">
                {task.identifier ? <span className="text-muted-foreground">{task.identifier} </span> : null}
                {task.title}
              </Link>
              <div className="text-xs text-muted-foreground">
                Issue assigned to you · {task.status.replace(/_/g, " ")} · updated {timeAgo(task.updatedAt)}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <MoreLine
        count={moreTasks}
        to="/issues?assignee=__me"
        noun={moreTasks === 1 ? "issue assigned to you" : "issues assigned to you"}
      />
      <MoreLine count={otherCount} to="/decisions" noun="waiting in Decisions" />
    </Block>
  );
}

function WorkingRow({ item }: { item: WorkingNowItem }) {
  return (
    <li data-testid="home-working-row" className="flex items-start gap-3 px-4 py-2.5">
      <span className="relative mt-1.5 flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      <div className="min-w-0 flex-1">
        {item.issue ? (
          <Link to={issueUrl(item.issue)} className="text-sm font-medium hover:underline">
            {item.issue.identifier ? <span className="text-muted-foreground">{item.issue.identifier} </span> : null}
            {item.issue.title}
          </Link>
        ) : (
          <span className="text-sm font-medium">Working outside an issue</span>
        )}
        <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>{item.agent.name}</span>
          <span aria-hidden>·</span>
          <span>{item.status === "queued" ? "queued" : formatElapsed(item.startedAt)}</span>
          {item.lastStep ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{item.lastStep}</span>
            </>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function Home() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Home" }]);
  }, [setBreadcrumbs]);

  const enabled = !!selectedCompanyId;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const { data: summary } = useQuery({
    queryKey: queryKeys.dashboard(selectedCompanyId ?? ""),
    queryFn: () => dashboardApi.summary(selectedCompanyId!),
    enabled,
  });
  // One count with the sidebar badge and the Decisions page (useDecisionsCount).
  const { waiting, isError: waitingFailed, sources: decisionsSources } = useDecisionsCount(selectedCompanyId);
  const { data: working, isError: workingFailed } = useQuery({
    queryKey: queryKeys.home.workingNow(selectedCompanyId ?? ""),
    queryFn: () => dashboardApi.workingNow(selectedCompanyId!),
    enabled,
    refetchInterval: 15_000,
  });
  // "This week" rounded down to the hour, so the query key is stable across renders.
  const weekAgo = new Date(Math.floor((Date.now() - WEEK_MS) / 3_600_000) * 3_600_000).toISOString();
  const { data: shipped, isError: shippedFailed } = useQuery({
    queryKey: queryKeys.shipped(selectedCompanyId ?? "", { since: weekAgo, accepted: true }),
    queryFn: () => issuesApi.listShipped(selectedCompanyId!, { since: weekAgo, limit: HOME_LIST_LIMIT, accepted: true }),
    enabled,
    refetchInterval: 60_000,
  });

  if (!selectedCompanyId) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Select a workspace to see its home.</div>;
  }

  const firstName = firstNameFor(session?.user);
  const openIssues = summary?.tasks.open ?? null;
  const workingItems = working?.items ?? [];
  const shippedItems = shipped?.items ?? [];

  return (
    <div className="mx-auto w-full max-w-[1080px] space-y-6 px-1 py-6 sm:px-4" data-testid="home">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground max-sm:text-xs">
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
          </div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight" data-testid="home-greeting">
            {greetingFor(new Date())}
            {firstName ? `, ${firstName}` : ""}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground" data-testid="home-subline">
            {/* Agents and open issues are counted once, in the stat tiles below. */}
            {selectedCompany?.name ?? "Your workspace"}
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0 max-sm:h-11">
          <Link to="/cos" data-testid="home-plan-with-cos">
            <MessageSquare className="mr-1.5 h-4 w-4" />
            Plan with your Chief of Staff
          </Link>
        </Button>
      </div>

      {/* AgentDash (GH #786): finish setup, then connect an assistant */}
      <FirstRunHomeNudges companyId={selectedCompanyId} />

      <WaitingOnYouBlock data={waiting} failed={waitingFailed} otherCount={decisionsSources.total} />

      <Block
        title="Working now"
        count={working ? working.total : null}
        testId="home-working"
        action={
          <Link
            to="/dashboard/live"
            className="text-xs text-muted-foreground hover:text-foreground hover:underline max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:min-w-11 max-sm:items-center max-sm:justify-end"
          >
            All runs
          </Link>
        }
      >
        {workingFailed && !working ? <ErrorLine what="the runs in progress" /> : null}
        {working && working.total === 0 ? (
          openIssues === 0 ? (
            <EmptyLine
              icon={RadioTower}
              text="Tell your team what to build. One sentence is enough."
              action={
                <Button asChild size="sm" variant="outline">
                  <Link to="/cos">Ask</Link>
                </Button>
              }
            />
          ) : (
            <EmptyLine icon={RadioTower} text={WORKING_EMPTY_TEXT} />
          )
        ) : null}
        <ul className="divide-y divide-border">
          {workingItems.map((item) => (
            <WorkingRow key={item.runId} item={item} />
          ))}
        </ul>
        <MoreLine count={(working?.total ?? 0) - workingItems.length} to="/dashboard/live" noun="running" />
      </Block>

      <Block
        title="Shipped this week"
        count={shipped ? shipped.total : null}
        testId="home-shipped"
        action={
          <Link
            to="/shipped"
            className="text-xs text-muted-foreground hover:text-foreground hover:underline max-sm:-my-3 max-sm:inline-flex max-sm:min-h-11 max-sm:min-w-11 max-sm:items-center max-sm:justify-end"
          >
            All shipped
          </Link>
        }
      >
        {shippedFailed && !shipped ? <ErrorLine what="what shipped this week" /> : null}
        {shipped && shipped.total === 0 ? <EmptyLine icon={PackageCheck} text={SHIPPED_WEEK_EMPTY_TEXT} shortText={SHIPPED_WEEK_EMPTY_SHORT_TEXT} /> : null}
        <div className="divide-y divide-border">
          {shippedItems.map((product) => (
            <ShippedWorkProductRow key={product.id} product={product} compactOnPhone />
          ))}
        </div>
        <MoreLine count={(shipped?.total ?? 0) - shippedItems.length} to="/shipped" noun="shipped" />
      </Block>

      <ControlPlanePanels companyId={selectedCompanyId} />
    </div>
  );
}

/** The /dashboard route element (App.tsx). One page for every company. */
export const DashboardHome = Home;
