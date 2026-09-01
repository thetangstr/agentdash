import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  type AgentGovernancePolicy,
  type AgentPolicyViolation,
} from "@paperclipai/shared";
import { agentGovernanceApi, type AgentGovernanceRecord } from "@/api/agent-governance";
import { ApiError } from "@/api/client";
import {
  AgentGovernancePanel,
  DIMENSION_LABELS,
  describeViolation,
} from "@/components/agent/AgentGovernancePanel";
import { queryKeys } from "@/lib/queryKeys";

interface Props {
  companyId: string;
  agentId: string;
  policy: AgentGovernanceRecord;
  /**
   * Whether this viewer may edit the request. The authority is resolved
   * server-side (`resolveConfigurationAuthority`); this prop only reflects it,
   * so a non-steward is never painted an edit control the server would refuse.
   */
  canEdit: boolean;
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Pull the violation list out of a 422 body. The route wraps it as
 * `{ error, details: { code, violations } }`; the client stores that under
 * `ApiError.body`.
 */
function extractViolations(error: unknown): AgentPolicyViolation[] {
  if (error instanceof ApiError) {
    const body = error.body as { details?: { violations?: AgentPolicyViolation[] } } | null;
    if (body?.details?.violations?.length) return body.details.violations;
  }
  return [];
}

/**
 * Lets the current steward edit all six request dimensions and submit them
 * against the current `revision`. Two refusals are made visible rather than
 * swallowed: an over-ceiling value renders the breached ceiling next to the
 * offending field, and a revision conflict reloads the record and says so, so a
 * concurrent change can never be silently overwritten.
 */
export function StewardRequestEditor({ companyId, agentId, policy, canEdit }: Props) {
  const queryClient = useQueryClient();
  const [record, setRecord] = useState<AgentGovernanceRecord>(policy);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AgentGovernancePolicy>(policy.stewardRequest);
  const [violations, setViolations] = useState<AgentPolicyViolation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadNotice, setReloadNotice] = useState<string | null>(null);

  // The record is owned by the parent's query; when it refetches (including
  // after a conflict-triggered reload) adopt the fresh copy so the next edit
  // carries the current revision. Keyed on the prop identity only — toggling
  // edit mode must not clobber a record just updated by a successful save.
  useEffect(() => {
    setRecord(policy);
    setDraft(policy.stewardRequest);
  }, [policy]);

  const save = useMutation({
    mutationFn: () =>
      agentGovernanceApi.updateRequest(companyId, agentId, {
        policy: draft,
        revision: record.revision,
      }),
    onSuccess: (result) => {
      setRecord(result.policy);
      setDraft(result.policy.stewardRequest);
      setViolations([]);
      setError(null);
      setReloadNotice(null);
      setEditing(false);
      queryClient.invalidateQueries({
        queryKey: queryKeys.myAgent.governance(companyId, agentId),
      });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        // A concurrent edit landed first. Reload the record so this steward
        // reapplies against the current revision rather than clobbering it.
        setViolations([]);
        setReloadNotice(
          "This agent's authority changed since you opened the editor. Reloaded to the latest — reapply your change and save again.",
        );
        setError(null);
        queryClient.invalidateQueries({
          queryKey: queryKeys.myAgent.governance(companyId, agentId),
        });
        return;
      }
      const found = extractViolations(err);
      setViolations(found);
      setReloadNotice(null);
      setError(found.length > 0 ? null : err instanceof Error ? err.message : "Failed to save request");
    },
  });

  const violationByField = new Map(violations.map((violation) => [violation.field, violation]));

  function fieldViolation(field: keyof AgentGovernancePolicy) {
    const violation = violationByField.get(field);
    if (!violation) return null;
    return (
      <p role="alert" className="mt-1 text-destructive">
        {DIMENSION_LABELS[field]}: {describeViolation(violation)}
      </p>
    );
  }

  return (
    <section aria-labelledby="steward-request-heading" className="space-y-3">
      <AgentGovernancePanel policy={record} />

      {canEdit ? (
        !editing ? (
          <button
            type="button"
            onClick={() => {
              setDraft(record.stewardRequest);
              setViolations([]);
              setError(null);
              setReloadNotice(null);
              setEditing(true);
            }}
            className="rounded border px-2 py-1 text-xs"
          >
            Edit request
          </button>
        ) : (
          <div className="space-y-2 rounded-lg border p-4 text-xs">
            <h3 id="steward-request-heading" className="text-sm font-semibold">
              Edit requested configuration
            </h3>
            <p className="text-muted-foreground">
              Ask for up to what the owner ceiling permits. Anything above it is refused and shown
              beside the field.
            </p>

            {reloadNotice ? (
              <p role="alert" className="text-destructive">
                {reloadNotice}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}

            <div data-field="permissions">
              <label className="block">
                <span className="font-medium">Permissions (comma separated, * for any)</span>
                <input
                  aria-label="Requested permissions"
                  className="mt-1 w-full rounded border px-2 py-1"
                  value={draft.permissions.join(", ")}
                  onChange={(event) =>
                    setDraft({ ...draft, permissions: parseList(event.target.value) })
                  }
                />
              </label>
              {fieldViolation("permissions")}
            </div>

            <div data-field="monthlyBudgetCents">
              <label className="block">
                <span className="font-medium">Monthly budget (cents)</span>
                <input
                  aria-label="Requested monthly budget"
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
              {fieldViolation("monthlyBudgetCents")}
            </div>

            <div data-field="destructiveActions">
              <label className="block">
                <span className="font-medium">Destructive actions</span>
                <select
                  aria-label="Requested destructive actions"
                  className="mt-1 rounded border px-2 py-1"
                  value={draft.destructiveActions}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      destructiveActions:
                        event.target.value as AgentGovernancePolicy["destructiveActions"],
                    })
                  }
                >
                  <option value="blocked">blocked</option>
                  <option value="approval_required">approval required</option>
                  <option value="allowed">allowed</option>
                </select>
              </label>
              {fieldViolation("destructiveActions")}
            </div>

            <div data-field="dataScopes">
              <label className="block">
                <span className="font-medium">Data scopes (comma separated, * for any)</span>
                <input
                  aria-label="Requested data scopes"
                  className="mt-1 w-full rounded border px-2 py-1"
                  value={draft.dataScopes.join(", ")}
                  onChange={(event) =>
                    setDraft({ ...draft, dataScopes: parseList(event.target.value) })
                  }
                />
              </label>
              {fieldViolation("dataScopes")}
            </div>

            <div data-field="providers">
              <label className="block">
                <span className="font-medium">Providers (comma separated, * for any)</span>
                <input
                  aria-label="Requested providers"
                  className="mt-1 w-full rounded border px-2 py-1"
                  value={draft.providers.join(", ")}
                  onChange={(event) =>
                    setDraft({ ...draft, providers: parseList(event.target.value) })
                  }
                />
              </label>
              {fieldViolation("providers")}
            </div>

            <div data-field="minimumApproval">
              <label className="block">
                <span className="font-medium">Minimum approval</span>
                <select
                  aria-label="Requested minimum approval"
                  className="mt-1 rounded border px-2 py-1"
                  value={draft.minimumApproval}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      minimumApproval:
                        event.target.value as AgentGovernancePolicy["minimumApproval"],
                    })
                  }
                >
                  <option value="none">none</option>
                  <option value="steward">steward</option>
                </select>
              </label>
              {fieldViolation("minimumApproval")}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                disabled={save.isPending}
                onClick={() => save.mutate()}
                className="rounded border px-2 py-1 disabled:opacity-50"
              >
                Save request
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setViolations([]);
                  setError(null);
                  setReloadNotice(null);
                }}
                className="rounded border px-2 py-1"
              >
                Cancel
              </button>
            </div>
          </div>
        )
      ) : null}
    </section>
  );
}
