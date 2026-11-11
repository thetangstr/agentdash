import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "../../api/access";

/**
 * AgentDash admin powers: "Their agents" in the remove-member dialog. For each
 * agent the leaving member looks after, choose who takes over (handed over
 * before the member's access ends), or leave it unstewarded, as removing a
 * member did before. A person looks after one agent at a time, so the same
 * person cannot be chosen for two agents.
 */

export interface StewardTransfer {
  agentId: string;
  toUserId: string;
}

export function TheirAgentsBlock({
  companyId,
  memberId,
  candidates,
  onChange,
}: {
  companyId: string;
  memberId: string;
  /** Active members who could take over (not the leaving member). */
  candidates: Array<{ userId: string; name: string }>;
  onChange: (transfers: StewardTransfer[], problem: string | null) => void;
}) {
  const agents = useQuery({
    queryKey: ["access", "stewarded-agents", companyId, memberId],
    queryFn: () => accessApi.stewardedAgents(companyId, memberId),
    retry: false,
  });
  const [choices, setChoices] = useState<Record<string, string>>({});
  const list = agents.data?.agents ?? [];

  const problem = useMemo(() => {
    const chosen = Object.values(choices).filter(Boolean);
    return new Set(chosen).size !== chosen.length
      ? "A person can look after only one agent, so choose a different person for each agent."
      : null;
  }, [choices]);

  useEffect(() => {
    onChange(
      Object.entries(choices).filter(([, userId]) => userId).map(([agentId, toUserId]) => ({ agentId, toUserId })),
      problem,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choices, problem]);

  if (agents.isLoading) return <p className="text-sm text-muted-foreground">Checking their agents...</p>;
  // Not an admin, or nothing to hand over: the block stays out of the way.
  if (agents.isError || list.length === 0) return null;

  const select = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm max-sm:min-h-11";
  return (
    <div className="space-y-2" data-testid="their-agents-block">
      <div className="text-sm font-medium">Their agents</div>
      <p className="text-xs text-muted-foreground">
        Choose who looks after each agent from now on. An agent left without a new steward has none once they are removed.
        A person can look after one agent at a time, and someone who already looks after an agent cannot take another.
      </p>
      {list.length > 1 ? (
        <select
          className={select}
          aria-label="New steward for all their agents"
          value=""
          onChange={(event) => {
            const userId = event.target.value;
            setChoices(Object.fromEntries(list.map((agent) => [agent.id, userId === "__none" ? "" : userId])));
          }}
        >
          <option value="" disabled>One choice for all…</option>
          <option value="__none">Leave all without a steward</option>
          {candidates.map((person) => <option key={person.userId} value={person.userId}>{person.name}</option>)}
        </select>
      ) : null}
      <ul className="space-y-2">
        {list.map((agent) => (
          <li key={agent.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-sm">{agent.name}</span>
            <select
              className={`${select} sm:w-56`}
              aria-label={`New steward for ${agent.name}`}
              value={choices[agent.id] ?? ""}
              onChange={(event) => setChoices((current) => ({ ...current, [agent.id]: event.target.value }))}
            >
              <option value="">Leave without a steward</option>
              {candidates.map((person) => <option key={person.userId} value={person.userId}>{person.name}</option>)}
            </select>
          </li>
        ))}
      </ul>
      {problem ? <p className="text-xs text-destructive" role="alert" data-testid="their-agents-problem">{problem}</p> : null}
    </div>
  );
}
