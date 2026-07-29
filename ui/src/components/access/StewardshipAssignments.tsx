import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { stewardshipsApi } from "@/api/stewardships";
import type { CompanyMember } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";

interface Props {
  companyId: string;
  members: CompanyMember[];
  /** Server is authoritative; this only decides whether controls are offered. */
  canManage: boolean;
}

function memberLabel(member: CompanyMember) {
  return member.user?.name || member.user?.email || member.principalId;
}

/**
 * Owner/admin surface for the one-to-one human↔agent relation.
 *
 * Transfer always demands a reason: the stewardship record is the audit trail
 * for who held decision authority over an agent and why it moved, and a
 * transfer with no reason makes that history unreadable after the fact.
 */
export function StewardshipAssignments({ companyId, members, canManage }: Props) {
  const queryClient = useQueryClient();
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [transferReason, setTransferReason] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const agents: Agent[] = agentsQuery.data ?? [];

  const stewardshipQuery = useQuery({
    queryKey: queryKeys.stewardships.byAgent(companyId, selectedAgentId),
    queryFn: () => stewardshipsApi.getAgentStewardship(companyId, selectedAgentId),
    enabled: !!companyId && !!selectedAgentId,
  });

  const historyQuery = useQuery({
    queryKey: queryKeys.stewardships.history(companyId, selectedAgentId),
    queryFn: () => stewardshipsApi.getAgentStewardshipHistory(companyId, selectedAgentId),
    enabled: !!companyId && !!selectedAgentId,
  });

  const current = stewardshipQuery.data?.stewardship ?? null;

  function invalidate() {
    queryClient.invalidateQueries({
      queryKey: queryKeys.stewardships.byAgent(companyId, selectedAgentId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.stewardships.history(companyId, selectedAgentId),
    });
  }

  const assign = useMutation({
    mutationFn: () =>
      stewardshipsApi.assign(companyId, { agentId: selectedAgentId, userId: selectedUserId }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Assignment failed"),
  });

  const transfer = useMutation({
    mutationFn: () =>
      stewardshipsApi.transfer(companyId, selectedAgentId, {
        userId: selectedUserId,
        transferReason,
      }),
    onSuccess: () => {
      setError(null);
      setTransferReason("");
      invalidate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Transfer failed"),
  });

  const activeMembers = members.filter((member) => member.status === "active");
  const canSubmitAssign = canManage && !!selectedAgentId && !!selectedUserId && !assign.isPending;
  const canSubmitTransfer =
    canManage &&
    !!selectedAgentId &&
    !!selectedUserId &&
    transferReason.trim().length > 0 &&
    !transfer.isPending;

  return (
    <section aria-labelledby="stewardship-heading" className="space-y-3 rounded-lg border p-4">
      <div>
        <h2 id="stewardship-heading" className="text-base font-semibold">
          Agent stewardship
        </h2>
        <p className="text-xs text-muted-foreground">
          One active agent per person, one active steward per agent. History is preserved when
          stewardship moves.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <label className="text-xs">
          <span className="block font-medium">Agent</span>
          <select
            aria-label="Agent"
            className="mt-1 rounded border px-2 py-1"
            value={selectedAgentId}
            onChange={(event) => setSelectedAgentId(event.target.value)}
          >
            <option value="">Select an agent…</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs">
          <span className="block font-medium">{current ? "New steward" : "Steward"}</span>
          <select
            aria-label={current ? "New steward" : "Steward"}
            className="mt-1 rounded border px-2 py-1"
            value={selectedUserId}
            onChange={(event) => setSelectedUserId(event.target.value)}
          >
            <option value="">Select a person…</option>
            {activeMembers.map((member) => (
              <option key={member.id} value={member.principalId}>
                {memberLabel(member)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selectedAgentId ? (
        <p className="text-xs text-muted-foreground">
          {current ? `Currently stewarded by ${current.userId}.` : "No active steward."}
        </p>
      ) : null}

      {current ? (
        <div className="space-y-2">
          <label className="block text-xs">
            <span className="font-medium">Reason</span>
            <input
              aria-label="Reason"
              className="mt-1 w-full rounded border px-2 py-1"
              value={transferReason}
              onChange={(event) => setTransferReason(event.target.value)}
              placeholder="Why is stewardship moving?"
            />
          </label>
          <button
            type="button"
            disabled={!canSubmitTransfer}
            onClick={() => transfer.mutate()}
            className="rounded border px-2 py-1 text-xs disabled:opacity-50"
          >
            Confirm transfer
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={!canSubmitAssign}
          onClick={() => assign.mutate()}
          className="rounded border px-2 py-1 text-xs disabled:opacity-50"
        >
          Assign agent
        </button>
      )}

      {!canManage ? (
        <p className="text-xs text-muted-foreground">
          Only a company owner or administrator can change stewardship.
        </p>
      ) : null}

      {historyQuery.data?.stewardships?.length ? (
        <div>
          <h3 className="text-xs font-medium">History</h3>
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
            {historyQuery.data.stewardships.map((row) => (
              <li key={row.id}>
                {row.userId} · {row.endedAt ? "ended" : "active"}
                {row.transferReason ? ` · ${row.transferReason}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
