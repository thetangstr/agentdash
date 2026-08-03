import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { approvalsApi } from "../api/approvals";
import { stewardshipsApi, type InboxItem } from "../api/stewardships";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

/**
 * Owner/admin emergency override.
 *
 * Deliberately its own page rather than a mode on the Inbox: an override
 * bypasses the assigned steward, so it must never be reachable by the same
 * muscle memory as an ordinary approve. Every action here demands a written
 * reason before it can be submitted.
 */
export default function OverrideInbox() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const isProfileCompany = selectedCompany?.productProfile === "agentdash_mk";
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const inbox = useQuery({
    queryKey: queryKeys.myAgent.overrideInbox(selectedCompanyId ?? ""),
    queryFn: () => stewardshipsApi.getOverrideInbox(selectedCompanyId!),
    enabled: !!selectedCompanyId && isProfileCompany,
  });

  const override = useMutation({
    mutationFn: (input: { item: InboxItem; decision: "approved" | "rejected" }) =>
      approvalsApi.override(input.item.approvalId, {
        decision: input.decision,
        overrideReason: reasons[input.item.approvalId] ?? "",
        revision: input.item.revision,
      }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.myAgent.overrideInbox(selectedCompanyId!),
      });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Override failed"),
  });

  if (!isProfileCompany) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">Emergency override</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This workspace does not use the AgentDash-MK profile.
        </p>
      </div>
    );
  }

  if (inbox.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  if (inbox.error) {
    return (
      <div className="p-6" role="alert">
        <h1 className="text-lg font-semibold">Emergency override</h1>
        <p className="mt-2 text-sm text-destructive">
          {inbox.error instanceof Error ? inbox.error.message : "Failed to load"}
        </p>
      </div>
    );
  }

  const items = inbox.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4 p-6">
      <header>
        <h1 className="text-lg font-semibold">Emergency override</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          These decisions belong to each agent&apos;s steward. Overriding is exceptional, requires a
          reason, and is recorded against your name.
        </p>
      </header>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is awaiting a decision.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => {
            const reason = reasons[item.approvalId] ?? "";
            const canSubmit = reason.trim().length > 0 && !override.isPending;
            return (
              <li key={item.approvalId} className="rounded-lg border p-4">
                <div className="flex flex-wrap items-baseline gap-2 text-sm">
                  <Link to={`/approvals/${item.approvalId}`} className="font-medium underline">
                    {item.type.replace(/_/g, " ")}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {item.requestingAgent
                      ? `requested by ${item.requestingAgent.name}`
                      : "no requesting agent"}
                    {" · "}revision {item.revision}
                    {" · "}risk {item.risk?.level ?? "unknown"}
                  </span>
                </div>
                {item.effectiveAuthority?.steward ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Normally decided by the assigned steward.
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    No active steward — administrators decide this one.
                  </p>
                )}

                <label className="mt-3 block text-xs font-medium" htmlFor={`reason-${item.approvalId}`}>
                  Reason for overriding
                </label>
                <input
                  id={`reason-${item.approvalId}`}
                  className="mt-1 w-full rounded border px-2 py-1 text-xs"
                  value={reason}
                  onChange={(event) =>
                    setReasons((prev) => ({ ...prev, [item.approvalId]: event.target.value }))
                  }
                  placeholder="Why is the steward being bypassed?"
                />

                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={!canSubmit}
                    onClick={() => override.mutate({ item, decision: "approved" })}
                    className="rounded border px-2 py-1 text-xs disabled:opacity-50"
                  >
                    Override &amp; approve
                  </button>
                  <button
                    type="button"
                    disabled={!canSubmit}
                    onClick={() => override.mutate({ item, decision: "rejected" })}
                    className="rounded border px-2 py-1 text-xs disabled:opacity-50"
                  >
                    Override &amp; reject
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
