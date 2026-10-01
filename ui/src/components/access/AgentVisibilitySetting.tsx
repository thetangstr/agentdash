import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AgentVisibility } from "@paperclipai/shared";
import { companiesApi } from "@/api/companies";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Agent visibility (2026-09-30): the one company-level knob.
 *
 * Two sentences, one radio. The server refuses the write for anyone who is
 * not a company administrator, so `canManage` only decides whether to show
 * controls or the current value — it is not the gate.
 */
const OPTIONS: Array<{ value: AgentVisibility; label: string; detail: string }> = [
  {
    value: "company",
    label: "Everyone sees every agent",
    detail: "Every member sees all agents and their work. This is the default.",
  },
  {
    value: "owner",
    label: "People see the agents they answer for",
    detail:
      "A member sees the agents they steward or are accountable for, those agents' reporting lines, agents they created, and agents marked shared. They see those agents' work, their own work, and every issue in a project they are listed on. Administrators see everything.",
  },
];

interface Props {
  companyId: string;
  value: AgentVisibility;
  canManage: boolean;
}

export function AgentVisibilitySetting({ companyId, value, canManage }: Props) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (agentVisibilityDefault: AgentVisibility) =>
      companiesApi.update(companyId, { agentVisibilityDefault }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not change agent visibility."),
  });

  const current = OPTIONS.find((option) => option.value === value) ?? OPTIONS[0]!;

  return (
    <section aria-labelledby="agent-visibility-heading" className="space-y-3 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 id="agent-visibility-heading" className="text-base font-semibold">
          Agent visibility
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Who can see which agents. Administrators always see everything; this decides what a member sees.
          Individual agents can override it from their own page.
        </p>
      </div>
      {canManage ? (
        <fieldset className="space-y-2" disabled={update.isPending}>
          <legend className="sr-only">Agent visibility</legend>
          {OPTIONS.map((option) => (
            <label key={option.value} className="flex items-start gap-3 text-sm">
              <input
                type="radio"
                name="agent-visibility-default"
                className="mt-1"
                value={option.value}
                checked={value === option.value}
                onChange={() => update.mutate(option.value)}
              />
              <span>
                <span className="font-medium">{option.label}</span>
                <span className="block text-muted-foreground">{option.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="text-sm">
          <span className="font-medium">{current.label}.</span>{" "}
          <span className="text-muted-foreground">Only a company administrator can change this.</span>
        </p>
      )}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
