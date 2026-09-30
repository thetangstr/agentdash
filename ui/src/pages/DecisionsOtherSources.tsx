import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { AlertTriangle, Bot, HelpCircle, ShieldAlert, UserPlus } from "lucide-react";
import type { ReactNode } from "react";
import { stewardshipsApi, type InboxItem } from "../api/stewardships";
import { connectorSendExecutionsApi } from "../api/connector-send-executions";
import { accessApi } from "../api/access";
import { timeAgo } from "../lib/timeAgo";

/**
 * AgentDash: one UX (doc/plans/2026-09-30-one-ux.md) — the item sources the
 * MK Inbox showed, folded into Decisions for every company.
 *
 * Each source reads its own server route. Several of those routes are
 * capability-gated on the server (they 404 for a company without the
 * capability) or authority-gated (403 for a member who may not see them).
 * Either way the section is simply absent: a failed source renders nothing
 * and never an error, so a company without the capability sees the plain
 * Decisions page. There is no client-side profile check — the server's
 * answer is the capability check.
 *
 * Steward and override approvals overlap the main list (waiting-on-you
 * already scopes approvals to the agents a person stewards), so rows already
 * shown above are dropped here rather than listed twice.
 */

/** Resolve to null on any failure — a gated source is absent, not an error. */
async function orNull<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

const ASKS: Record<string, string> = {
  hire_agent: "wants to hire another agent",
  approve_ceo_strategy: "wants sign-off on the strategy",
  budget_override_required: "has run out of budget and cannot continue",
  request_board_approval: "wants board approval",
  mandate_violation: "did something its mandate does not allow",
  connector_send: "wants to send something outside the company",
  inbound_content_review: "wants to release content that was held back",
  deliverable_review: "needs your sign-off on a deliverable",
  workflow_recommendation: "has a suggestion about how this work runs",
};

export function stewardItemSummary(item: InboxItem): string {
  const who = item.requestingAgent?.name ?? "Your agent";
  const ask = ASKS[item.type];
  return ask ? `${who} ${ask}` : `${who}: ${item.type.replace(/_/g, " ")}`;
}

function Section({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card" aria-label={label} data-testid={testId}>
      <header className="border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</h2>
      </header>
      <ul className="divide-y divide-border">{children}</ul>
    </section>
  );
}

function Row({
  icon,
  to,
  title,
  detail,
  testId,
}: {
  icon: ReactNode;
  to: string;
  title: string;
  detail?: string | null;
  testId: string;
}) {
  return (
    <li data-testid={testId} className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <Link to={to} className="text-sm font-medium leading-5 hover:underline">
          {title}
        </Link>
        {detail ? <div className="text-xs text-muted-foreground">{detail}</div> : null}
      </div>
    </li>
  );
}

/** Query keys owned by this page. The sources resolve to null on failure,
 *  which the pages sharing these routes do not expect in their caches. */
export const decisionsSourceKeys = {
  stewardInbox: (companyId: string) => ["decisions", "sources", companyId, "steward-inbox"] as const,
  overrideInbox: (companyId: string) => ["decisions", "sources", companyId, "override-inbox"] as const,
  factRequests: (companyId: string) => ["decisions", "sources", companyId, "fact-requests"] as const,
  connectorSends: (companyId: string) => ["decisions", "sources", companyId, "connector-sends"] as const,
  joinRequests: (companyId: string) => ["decisions", "sources", companyId, "join-requests"] as const,
};

export function useDecisionsOtherSources(
  companyId: string | null | undefined,
  shownApprovalIds: ReadonlySet<string>,
) {
  const id = companyId ?? "";
  // A source that answered null (gated off, or not this person's to see) is
  // not polled again on this mount — a company without the capability should
  // not pay five 404s every 30 seconds.
  const common = {
    enabled: !!companyId,
    retry: false,
    refetchInterval: (query: { state: { data: unknown } }) =>
      query.state.data === null ? false : 30_000,
  } as const;
  // The approvals this person's own agent is stopped on (steward inbox, open only).
  const { data: stewardInbox } = useQuery({
    queryKey: decisionsSourceKeys.stewardInbox(id),
    queryFn: () => orNull(() => stewardshipsApi.getMyInbox(id)),
    ...common,
  });
  // The owner/admin override view. The server answers only for people with
  // that authority, so a successful answer is the entry point's permission.
  const { data: overrideInbox } = useQuery({
    queryKey: decisionsSourceKeys.overrideInbox(id),
    queryFn: () => orNull(() => stewardshipsApi.getOverrideInbox(id)),
    ...common,
  });
  // Questions the person's agent could not answer without them.
  const { data: factRequests } = useQuery({
    queryKey: decisionsSourceKeys.factRequests(id),
    queryFn: () => orNull(() => stewardshipsApi.myFactRequests(id)),
    ...common,
  });
  // Outside writes whose outcome is unknown and need a human verdict.
  const { data: connectorSends } = useQuery({
    queryKey: decisionsSourceKeys.connectorSends(id),
    queryFn: () => orNull(() => connectorSendExecutionsApi.listUnresolved(id)),
    ...common,
  });
  // People waiting to join the company.
  const { data: joinRequests } = useQuery({
    queryKey: decisionsSourceKeys.joinRequests(id),
    queryFn: () => orNull(() => accessApi.listJoinRequests(id, "pending_approval")),
    ...common,
  });

  const stewardItems = (stewardInbox?.items ?? []).filter(
    (item) =>
      item.status !== "approved" &&
      item.status !== "rejected" &&
      !shownApprovalIds.has(item.approvalId),
  );
  const stewardShownIds = new Set(stewardItems.map((item) => item.approvalId));
  const overrideCount = (overrideInbox?.items ?? []).filter(
    (item) => !shownApprovalIds.has(item.approvalId) && !stewardShownIds.has(item.approvalId),
  ).length;
  const questions = factRequests?.factRequests ?? [];
  const sends = connectorSends?.items ?? [];
  const joins = Array.isArray(joinRequests) ? joinRequests : [];
  return {
    agentName: stewardInbox?.stewardedAgent?.name ?? null,
    stewardItems,
    overrideCount,
    questions,
    sends,
    joins,
    total: stewardItems.length + overrideCount + questions.length + sends.length + joins.length,
  };
}

export type DecisionsOtherSourcesData = ReturnType<typeof useDecisionsOtherSources>;

export function DecisionsOtherSources({ sources }: { sources: DecisionsOtherSourcesData }) {
  const { agentName, stewardItems, overrideCount, questions, sends, joins } = sources;

  return (
    <>
      {stewardItems.length > 0 ? (
        <Section label={agentName ? `${agentName} is waiting on you` : "Your agent is waiting on you"} testId="decisions-steward">
          {stewardItems.map((item) => (
            <Row
              key={item.approvalId}
              testId="decisions-steward-row"
              icon={<Bot className="h-4 w-4 text-amber-600" />}
              to={`/approvals/${item.approvalId}`}
              title={stewardItemSummary(item)}
              detail={[
                item.risk?.reason ?? null,
                item.sourceIssues[0] ? `${item.sourceIssues[0].identifier} ${item.sourceIssues[0].title}` : null,
                `waiting ${timeAgo(item.createdAt)}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          ))}
        </Section>
      ) : null}

      {questions.length > 0 ? (
        <Section label="Questions from your agent" testId="decisions-questions">
          {questions.map((question) => (
            <Row
              key={question.id}
              testId="decisions-question-row"
              icon={<HelpCircle className="h-4 w-4 text-sky-600" />}
              to="/my-agent"
              title={question.question}
              detail={question.createdAt ? `asked ${timeAgo(question.createdAt)}` : null}
            />
          ))}
        </Section>
      ) : null}

      {sends.length > 0 ? (
        <Section label="Outside writes to confirm" testId="decisions-connector-sends">
          {sends.map((send) => (
            <Row
              key={send.id}
              testId="decisions-connector-send-row"
              icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}
              to="/company/settings"
              title={`${send.provider} ${send.operation} ${send.objectType}: outcome unknown`}
              detail={[send.reason, `sent ${timeAgo(send.executedAt)}`].filter(Boolean).join(" · ")}
            />
          ))}
        </Section>
      ) : null}

      {joins.length > 0 ? (
        <Section label="Join requests" testId="decisions-join-requests">
          <Row
            testId="decisions-join-request-row"
            icon={<UserPlus className="h-4 w-4 text-sky-600" />}
            to="/inbox/requests"
            title={`${joins.length} ${joins.length === 1 ? "request" : "requests"} to join the company`}
            detail="Review who gets access"
          />
        </Section>
      ) : null}

      {overrideCount > 0 ? (
        <Section label="Administrator override" testId="decisions-override">
          <Row
            testId="decisions-override-row"
            icon={<ShieldAlert className="h-4 w-4 text-destructive" />}
            to="/inbox/override"
            title={`${overrideCount} company ${overrideCount === 1 ? "approval" : "approvals"} open to the override view`}
            detail="Only for exceptional cases; each override needs a reason"
          />
        </Section>
      ) : null}
    </>
  );
}
