import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  type AgentGovernancePolicy,
  type AgentPolicyViolation,
} from "@paperclipai/shared";
import type { Agent } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { agentGovernanceApi } from "@/api/agent-governance";
import { AgentGovernancePanel } from "@/components/agent/AgentGovernancePanel";
import { DefaultDestructiveActionsNotice } from "@/components/settings/DefaultDestructiveActionsNotice";
import { queryKeys } from "@/lib/queryKeys";

interface Props {
  companyId: string;
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Pull the violation list out of a 422 body so the panel can explain the refusal. */
function extractViolations(error: unknown): AgentPolicyViolation[] | undefined {
  const details = (error as { details?: { violations?: AgentPolicyViolation[] } })?.details;
  if (details?.violations?.length) return details.violations;
  const body = (error as { body?: { details?: { violations?: AgentPolicyViolation[] } } })?.body;
  return body?.details?.violations;
}

/**
 * Owner-only editor for an agent's policy ceiling.
 *
 * The revision read with the policy is sent back on save, so two owners editing
 * the same agent cannot silently overwrite each other — the second save gets a
 * conflict and has to reload.
 */
export function AgentCeilingEditor({ companyId }: Props) {
  const queryClient = useQueryClient();
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [draft, setDraft] = useState<AgentGovernancePolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [violations, setViolations] = useState<AgentPolicyViolation[] | undefined>(undefined);

  // Presentation only — the server independently requires agents:create for
  // every ceiling mutation and 404s the route off-profile.
  const membersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(companyId),
    queryFn: () => accessApi.listMembers(companyId),
    enabled: !!companyId,
  });
  const canManage = membersQuery.data?.access.canManageAgents ?? false;

  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });
  const agents: Agent[] = agentsQuery.data ?? [];

  const governance = useQuery({
    queryKey: queryKeys.myAgent.governance(companyId, selectedAgentId),
    queryFn: () => agentGovernanceApi.get(companyId, selectedAgentId),
    enabled: !!companyId && !!selectedAgentId,
  });

  const policy = governance.data?.policy ?? null;

  useEffect(() => {
    if (policy) setDraft(policy.ownerCeiling);
  }, [policy]);

  const save = useMutation({
    mutationFn: () =>
      agentGovernanceApi.updateCeiling(companyId, selectedAgentId, {
        policy: draft!,
        revision: policy!.revision,
      }),
    onSuccess: () => {
      setError(null);
      setViolations(undefined);
      queryClient.invalidateQueries({
        queryKey: queryKeys.myAgent.governance(companyId, selectedAgentId),
      });
    },
    onError: (err) => {
      setViolations(extractViolations(err));
      setError(err instanceof Error ? err.message : "Failed to save ceiling");
    },
  });

  return (
    <section aria-labelledby="ceiling-heading" className="space-y-3 rounded-lg border p-4">
      <div>
        <h2 id="ceiling-heading" className="text-base font-semibold">
          Agent policy ceilings
        </h2>
        <p className="text-xs text-muted-foreground">
          The maximum authority a steward can request. Lowering a ceiling also brings existing
          configuration down to it.
        </p>
      </div>

      {/* T5a-3: read-only display of the default destructive-action classes the
          `destructiveActions` ceiling below applies to. */}
      <DefaultDestructiveActionsNotice />

      <label className="block text-xs">
        <span className="font-medium">Agent</span>
        <select
          aria-label="Ceiling agent"
          className="mt-1 rounded border px-2 py-1"
          value={selectedAgentId}
          onChange={(event) => {
            setSelectedAgentId(event.target.value);
            setError(null);
            setViolations(undefined);
          }}
        >
          <option value="">Select an agent…</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {policy ? <AgentGovernancePanel policy={policy} violations={violations} /> : null}

      {policy && draft ? (
        <div className="space-y-2 text-xs">
          <label className="block">
            <span className="font-medium">Allowed permissions (comma separated, * for any)</span>
            <input
              aria-label="Allowed permissions"
              className="mt-1 w-full rounded border px-2 py-1"
              value={draft.permissions.join(", ")}
              onChange={(event) =>
                setDraft({ ...draft, permissions: parseList(event.target.value) })
              }
            />
          </label>

          <label className="block">
            <span className="font-medium">Maximum monthly budget (cents)</span>
            <input
              aria-label="Maximum monthly budget"
              type="number"
              min={0}
              max={AGENT_POLICY_UNLIMITED_BUDGET_CENTS}
              className="mt-1 w-full rounded border px-2 py-1"
              value={draft.monthlyBudgetCents}
              onChange={(event) =>
                setDraft({ ...draft, monthlyBudgetCents: Number(event.target.value) })
              }
            />
          </label>

          <label className="block">
            <span className="font-medium">Destructive actions</span>
            <select
              aria-label="Destructive actions"
              className="mt-1 rounded border px-2 py-1"
              value={draft.destructiveActions}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  destructiveActions: event.target.value as AgentGovernancePolicy["destructiveActions"],
                })
              }
            >
              <option value="blocked">blocked</option>
              <option value="approval_required">approval required</option>
              <option value="allowed">allowed</option>
            </select>
          </label>

          <label className="block">
            <span className="font-medium">Allowed data scopes (comma separated, * for any)</span>
            <input
              aria-label="Allowed data scopes"
              className="mt-1 w-full rounded border px-2 py-1"
              value={draft.dataScopes.join(", ")}
              onChange={(event) =>
                setDraft({ ...draft, dataScopes: parseList(event.target.value) })
              }
            />
          </label>

          <label className="block">
            <span className="font-medium">Allowed providers (comma separated, * for any)</span>
            <input
              aria-label="Allowed providers"
              className="mt-1 w-full rounded border px-2 py-1"
              value={draft.providers.join(", ")}
              onChange={(event) =>
                setDraft({ ...draft, providers: parseList(event.target.value) })
              }
            />
          </label>

          <label className="block">
            <span className="font-medium">Minimum approval</span>
            <select
              aria-label="Minimum approval"
              className="mt-1 rounded border px-2 py-1"
              value={draft.minimumApproval}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  minimumApproval: event.target.value as AgentGovernancePolicy["minimumApproval"],
                })
              }
            >
              <option value="none">none</option>
              <option value="steward">steward</option>
            </select>
          </label>

          <button
            type="button"
            disabled={!canManage || save.isPending}
            onClick={() => save.mutate()}
            className="rounded border px-2 py-1 disabled:opacity-50"
          >
            Save ceiling
          </button>

          {!canManage ? (
            <p className="text-muted-foreground">
              Only a company owner or administrator can change ceilings.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
