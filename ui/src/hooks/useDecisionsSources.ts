import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HeartbeatRun, InboxDismissal } from "@paperclipai/shared";
import { stewardshipsApi } from "../api/stewardships";
import { connectorSendExecutionsApi } from "../api/connector-send-executions";
import { accessApi } from "../api/access";
import { heartbeatsApi } from "../api/heartbeats";
import { inboxDismissalsApi } from "../api/inboxDismissals";
import { isCapabilityNotFound, isCapabilityOff } from "../components/AvailableOnRequest";
import { buildInboxDismissedAtByKey, getLatestFailedRunsByAgent, isInboxEntityDismissed } from "../lib/inbox";
import { useStewardshipFeature } from "./useStewardshipCapability";

/**
 * AgentDash: one UX (doc/plans/2026-09-30-one-ux.md) — the item sources the
 * MK Inbox showed, folded into Decisions for every company, plus the failed
 * runs the old Inbox listed.
 *
 * Each source reads its own server route. Several of those routes are
 * capability-gated on the server (they 404 for a company without the
 * capability) or authority-gated (403 for a member who may not see them).
 * Either way the section is simply absent, so a company without the
 * capability sees the plain Decisions page. There is no client-side profile
 * check — the server's answer is the capability check. Only those two answers
 * mean "absent": any other failure (a 500, a dropped connection) is
 * transient, keeps polling with backoff, and meanwhile renders whatever the
 * source last loaded — never an error, never a permanently hidden section.
 *
 * Steward and override approvals overlap the main list (waiting-on-you
 * already scopes approvals to the agents a person stewards), so rows already
 * shown above are dropped here rather than listed twice.
 *
 * The Decisions page, its header count, Home's Waiting on you, the sidebar
 * and the mobile badge all read these same queries (one cache entry each),
 * so they count exactly what the page shows.
 */

/** How often a healthy source is polled. */
export const SOURCE_POLL_MS = 30_000;
/** The longest a failing source waits between attempts. */
export const SOURCE_MAX_BACKOFF_MS = 5 * 60_000;
/** How many recent runs are scanned for each agent's latest failure (the old Inbox's window). */
export const FAILED_RUN_SCAN_LIMIT = 200;

/**
 * Consecutive transient failures per source query, keyed by the query key.
 * Module-level so every surface sharing a source (the page, the badges) backs
 * off together — they share one cache entry and so one fetch.
 */
const failureStreaks = new Map<string, number>();

/**
 * Sources whose capability gate answered 404 (off for this workspace), keyed
 * like `failureStreaks`. AgentDash (scan 3 lane L): remembered for the
 * session, not just the mount, so navigating back to a page that shows the
 * Decisions count does not ask again; a workspace without a capability used
 * to log about 77 404s per gated route per session. A reload asks afresh.
 *
 * Only 404s. A 403 is about this person's authority, which can change in the
 * session (a member promoted to admin), so a 403 source is still re-asked on
 * a later mount and the promotion shows without a reload.
 */
const absentForSession = new Set<string>();

/**
 * Load one source. The capability gate's 404 and the authority gate's 403
 * resolve to `null` — the source is absent for this person. Anything else is
 * rethrown: it is transient, not an answer.
 */
export async function loadSource<T>(streakKey: string, load: () => Promise<T>): Promise<T | null> {
  try {
    const result = await load();
    failureStreaks.delete(streakKey);
    return result;
  } catch (error) {
    if (isCapabilityOff(error)) {
      failureStreaks.delete(streakKey);
      if (isCapabilityNotFound(error)) absentForSession.add(streakKey);
      return null;
    }
    failureStreaks.set(streakKey, (failureStreaks.get(streakKey) ?? 0) + 1);
    throw error;
  }
}

/**
 * The poll interval for a source: stop once the server said it is absent
 * (`null`), back off exponentially while it is failing, poll normally
 * otherwise.
 */
export function sourceRefetchInterval(
  state: { data: unknown; status: "pending" | "error" | "success" },
  failures: number,
): number | false {
  if (state.status === "error") {
    return Math.min(SOURCE_POLL_MS * 2 ** Math.max(0, failures - 1), SOURCE_MAX_BACKOFF_MS);
  }
  if (state.data === null) return false;
  return SOURCE_POLL_MS;
}

/** Test seam: forget every failure streak and every remembered absence. */
export function resetSourceFailureStreaks() {
  failureStreaks.clear();
  absentForSession.clear();
}

/** Query keys owned by Decisions. The sources resolve to null when absent,
 *  which the pages sharing these routes do not expect in their caches. */
export const decisionsSourceKeys = {
  stewardInbox: (companyId: string) => ["decisions", "sources", companyId, "steward-inbox"] as const,
  overrideInbox: (companyId: string) => ["decisions", "sources", companyId, "override-inbox"] as const,
  factRequests: (companyId: string) => ["decisions", "sources", companyId, "fact-requests"] as const,
  connectorSends: (companyId: string) => ["decisions", "sources", companyId, "connector-sends"] as const,
  joinRequests: (companyId: string) => ["decisions", "sources", companyId, "join-requests"] as const,
  recentRuns: (companyId: string) => ["decisions", "sources", companyId, "recent-runs"] as const,
  dismissals: (companyId: string) => ["decisions", "sources", companyId, "dismissals"] as const,
};

/** The dismissal key the old Inbox used for a failed run — kept, so earlier dismissals still hold. */
export function failedRunItemKey(run: Pick<HeartbeatRun, "id">): string {
  return `run:${run.id}`;
}

/** Each agent's latest run when it failed, minus the ones this person dismissed since. */
export function visibleFailedRuns(runs: HeartbeatRun[], dismissals: InboxDismissal[]): HeartbeatRun[] {
  const dismissedAtByKey = buildInboxDismissedAtByKey(dismissals);
  return getLatestFailedRunsByAgent(runs).filter(
    (run) => !isInboxEntityDismissed(dismissedAtByKey, failedRunItemKey(run), run.createdAt),
  );
}

export function useDecisionsOtherSources(
  companyId: string | null | undefined,
  shownApprovalIds: ReadonlySet<string>,
  enabled = true,
) {
  const id = companyId ?? "";
  const queryClient = useQueryClient();
  // AgentDash (scan 3 lane L): the stewardship-gated sources are asked only
  // once the server has said stewardship is on (or could not say). A
  // workspace without it no longer probes four routes to read their 404s.
  const stewardship = useStewardshipFeature(companyId);
  const stewardshipMaybeOn = stewardship === "on" || stewardship === "unknown";
  // A source that answered null (gated off, or not this person's to see) is
  // not asked again this session — a company without the capability should
  // not pay a 404 per source every 30 seconds or on every mount. A source
  // that failed for any other reason keeps polling, backing off while it
  // keeps failing.
  const source = <T>(queryKey: readonly unknown[], load: () => Promise<T>, gated = false) => {
    const streakKey = JSON.stringify(queryKey);
    return {
      queryKey,
      queryFn: () => loadSource(streakKey, load),
      enabled: !!companyId && enabled && !absentForSession.has(streakKey) && (!gated || stewardshipMaybeOn),
      retry: false,
      // A capability that is off (404) never goes stale, so a remount does
      // not refetch it. A 403 goes stale normally, so authority granted
      // mid-session is picked up on the next mount.
      staleTime: () => (absentForSession.has(streakKey) ? Infinity : SOURCE_POLL_MS),
      refetchInterval: (query: { state: { data: unknown; status: "pending" | "error" | "success" } }) =>
        sourceRefetchInterval(query.state, failureStreaks.get(streakKey) ?? 0),
    };
  };
  // The approvals this person's own agent is stopped on (steward inbox, open only).
  const { data: stewardInbox } = useQuery(
    source(decisionsSourceKeys.stewardInbox(id), () => stewardshipsApi.getMyInbox(id), true),
  );
  // The owner/admin override view. The server answers only for people with
  // that authority, so a successful answer is the entry point's permission.
  const { data: overrideInbox } = useQuery(
    source(decisionsSourceKeys.overrideInbox(id), () => stewardshipsApi.getOverrideInbox(id), true),
  );
  // Questions the person's agent could not answer without them.
  const { data: factRequests } = useQuery(
    source(decisionsSourceKeys.factRequests(id), () => stewardshipsApi.myFactRequests(id), true),
  );
  // Outside writes whose outcome is unknown and need a human verdict.
  const { data: connectorSends } = useQuery(
    source(decisionsSourceKeys.connectorSends(id), () => connectorSendExecutionsApi.listUnresolved(id), true),
  );
  // People waiting to join the company.
  const { data: joinRequests } = useQuery(
    source(decisionsSourceKeys.joinRequests(id), () => accessApi.listJoinRequests(id, "pending_approval")),
  );
  // Each agent's latest run, when it failed and this person has not dismissed it.
  const { data: recentRuns } = useQuery(
    source(decisionsSourceKeys.recentRuns(id), () => heartbeatsApi.list(id, undefined, FAILED_RUN_SCAN_LIMIT)),
  );
  const dismissalsKey = decisionsSourceKeys.dismissals(id);
  const { data: dismissals } = useQuery(source(dismissalsKey, () => inboxDismissalsApi.list(id)));

  const dismissMutation = useMutation({
    mutationFn: (itemKey: string) => inboxDismissalsApi.dismiss(id, itemKey),
    onMutate: async (itemKey: string) => {
      await queryClient.cancelQueries({ queryKey: dismissalsKey });
      const previous = queryClient.getQueryData<InboxDismissal[] | null>(dismissalsKey);
      const now = new Date();
      queryClient.setQueryData<InboxDismissal[]>(dismissalsKey, [
        { id: `optimistic:${itemKey}`, companyId: id, userId: "me", itemKey, dismissedAt: now, createdAt: now, updatedAt: now },
        ...(previous ?? []).filter((dismissal) => dismissal.itemKey !== itemKey),
      ]);
      return { previous };
    },
    onError: (_error, _itemKey, context) => {
      if (context) queryClient.setQueryData(dismissalsKey, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: dismissalsKey });
    },
  });

  const failedRuns = useMemo(
    () => visibleFailedRuns(Array.isArray(recentRuns) ? recentRuns : [], Array.isArray(dismissals) ? dismissals : []),
    [recentRuns, dismissals],
  );

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
    companyId: companyId ?? null,
    agentName: stewardInbox?.stewardedAgent?.name ?? null,
    stewardItems,
    overrideCount,
    questions,
    sends,
    joins,
    failedRuns,
    dismissFailedRun: (run: Pick<HeartbeatRun, "id">) => dismissMutation.mutate(failedRunItemKey(run)),
    total:
      stewardItems.length + overrideCount + questions.length + sends.length + joins.length + failedRuns.length,
  };
}

export type DecisionsOtherSourcesData = ReturnType<typeof useDecisionsOtherSources>;
