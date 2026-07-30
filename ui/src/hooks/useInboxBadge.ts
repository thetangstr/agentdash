import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { ApiError } from "../api/client";
import { inboxDismissalsApi } from "../api/inboxDismissals";
import { approvalsApi } from "../api/approvals";
import { authApi } from "../api/auth";
import { dashboardApi } from "../api/dashboard";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { stewardshipsApi } from "../api/stewardships";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import {
  buildInboxDismissedAtByKey,
  computeInboxBadgeData,
  getRecentTouchedIssues,
  loadDismissedInboxAlerts,
  saveDismissedInboxAlerts,
  loadReadInboxItems,
  saveReadInboxItems,
  READ_ITEMS_KEY,
} from "../lib/inbox";

const INBOX_ISSUE_STATUSES = "backlog,todo,in_progress,in_review,blocked,done";
const INBOX_BADGE_ISSUE_LIMIT = 500;
const INBOX_BADGE_HEARTBEAT_RUN_LIMIT = 200;

export function useDismissedInboxAlerts() {
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissedInboxAlerts);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "paperclip:inbox:dismissed") return;
      setDismissed(loadDismissedInboxAlerts());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveDismissedInboxAlerts(next);
      return next;
    });
  };

  return { dismissed, dismiss };
}

export function useInboxDismissals(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = companyId
    ? queryKeys.inboxDismissals(companyId)
    : ["inbox-dismissals", "__disabled__"] as const;

  const { data: dismissals = [] } = useQuery({
    queryKey,
    queryFn: () => inboxDismissalsApi.list(companyId!),
    enabled: !!companyId,
  });

  const dismissMutation = useMutation({
    mutationFn: ({ itemKey }: { itemKey: string }) => inboxDismissalsApi.dismiss(companyId!, itemKey),
    onMutate: async ({ itemKey }) => {
      if (!companyId) return { previous: [] as typeof dismissals };
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<typeof dismissals>(queryKey) ?? [];
      const now = new Date();
      queryClient.setQueryData(queryKey, [
        {
          id: `optimistic:${itemKey}`,
          companyId,
          userId: "me",
          itemKey,
          dismissedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        ...previous.filter((dismissal) => dismissal.itemKey !== itemKey),
      ]);
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (!context) return;
      queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => {
      if (!companyId) return;
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
    },
  });

  const dismissedAtByKey = useMemo(
    () => buildInboxDismissedAtByKey(dismissals),
    [dismissals],
  );

  return {
    dismissals,
    dismissedAtByKey,
    dismiss: (itemKey: string) => dismissMutation.mutate({ itemKey }),
    isPending: dismissMutation.isPending,
  };
}

export function useReadInboxItems() {
  const [readItems, setReadItems] = useState<Set<string>>(loadReadInboxItems);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== READ_ITEMS_KEY) return;
      setReadItems(loadReadInboxItems());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const markRead = (id: string) => {
    setReadItems((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveReadInboxItems(next);
      return next;
    });
  };

  const markUnread = (id: string) => {
    setReadItems((prev) => {
      const next = new Set(prev);
      next.delete(id);
      saveReadInboxItems(next);
      return next;
    });
  };

  return { readItems, markRead, markUnread };
}

export function useInboxBadge(companyId: string | null | undefined) {
  const { dismissed: dismissedAlerts } = useDismissedInboxAlerts();
  const { dismissedAtByKey } = useInboxDismissals(companyId);
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  const { data: approvals = [] } = useQuery({
    queryKey: queryKeys.approvals.list(companyId!),
    queryFn: () => approvalsApi.list(companyId!),
    enabled: !!companyId,
  });

  const { data: joinRequests = [] } = useQuery({
    queryKey: queryKeys.access.joinRequests(companyId!),
    queryFn: async () => {
      try {
        return await accessApi.listJoinRequests(companyId!, "pending_approval");
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return [];
        }
        throw err;
      }
    },
    enabled: !!companyId,
    retry: false,
  });

  const { data: dashboard } = useQuery({
    queryKey: queryKeys.dashboard(companyId!),
    queryFn: () => dashboardApi.summary(companyId!),
    enabled: !!companyId,
  });

  const { data: mineIssuesRaw = [] } = useQuery({
    queryKey: queryKeys.issues.listMineByMe(companyId!),
    queryFn: () =>
      issuesApi.list(companyId!, {
        touchedByUserId: "me",
        inboxArchivedByUserId: "me",
        status: INBOX_ISSUE_STATUSES,
        limit: INBOX_BADGE_ISSUE_LIMIT,
      }),
    enabled: !!companyId,
  });

  const mineIssues = useMemo(() => getRecentTouchedIssues(mineIssuesRaw), [mineIssuesRaw]);
  const currentUserId = session?.user.id ?? session?.session.userId ?? null;

  const { data: heartbeatRuns = [] } = useQuery({
    queryKey: [...queryKeys.heartbeats(companyId!), "limit", INBOX_BADGE_HEARTBEAT_RUN_LIMIT],
    queryFn: () => heartbeatsApi.list(companyId!, undefined, INBOX_BADGE_HEARTBEAT_RUN_LIMIT),
    enabled: !!companyId,
  });

  // AgentDash-MK: the badge counted the unscoped company approval list while
  // the Inbox tab it opens is scoped to this user, so the two disagreed — the
  // badge promised work the tab would not show. It reads the same server-owned
  // scope the page does, from the same query key, so there is one answer.
  const { selectedCompany } = useCompany();
  const isProfileCompany = selectedCompany?.productProfile === "agentdash_mk";
  const { data: personalInbox } = useQuery({
    queryKey: queryKeys.myAgent.inboxScope(companyId ?? ""),
    queryFn: () => stewardshipsApi.getMyInbox(companyId!, "all"),
    enabled: !!companyId && isProfileCompany,
  });
  // `undefined` off-profile leaves the count exactly as it was; `null` while
  // the profile scope loads counts nothing rather than flashing an unscoped
  // number the tab will immediately contradict.
  const serverScopedApprovalIds = useMemo(() => {
    if (!isProfileCompany) return undefined;
    return personalInbox ? new Set(personalInbox.items.map((item) => item.approvalId)) : null;
  }, [isProfileCompany, personalInbox]);

  return useMemo(
    () =>
      computeInboxBadgeData({
        approvals,
        joinRequests,
        dashboard,
        heartbeatRuns,
        mineIssues,
        dismissedAlerts,
        dismissedAtByKey,
        currentUserId,
        serverScopedApprovalIds,
      }),
    [approvals, joinRequests, dashboard, heartbeatRuns, mineIssues, dismissedAlerts, dismissedAtByKey, currentUserId, serverScopedApprovalIds],
  );
}
