import { randomUUID } from "node:crypto";
import {
  AGENT_POLICY_CEILING_EXCEEDED,
  classifyAction,
  type ActionClassification,
  type AgentDestructiveActionMode,
  type ClassifyConnectorAction,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import type { agentGovernanceService } from "./agent-governance.js";
import type { workflowEventsService } from "./workflow-events.js";

/**
 * AgentDash-MK T5a: the refusal a `blocked` destructive-action ceiling raises.
 *
 * Reuses the T2/T3 ceiling-error shape exactly — a 422 carrying
 * `AGENT_POLICY_CEILING_EXCEEDED` and a `destructiveActions` violation — so a
 * client that already renders a ceiling refusal renders this one unchanged. The
 * class the action was placed into is the `requested` value; `blocked` is the
 * bound it breached.
 *
 * One copy for every request-time chokepoint (the bridge, the HubSpot write
 * request, the Slack send), so the agent reads the same refusal wherever it
 * acts.
 */
export function destructiveActionBlocked(actionClass: ActionClassification) {
  return new HttpError(
    422,
    "This action is blocked by the owner ceiling for destructive actions",
    {
      code: AGENT_POLICY_CEILING_EXCEEDED,
      violations: [
        {
          field: "destructiveActions",
          code: "DESTRUCTIVE_ACTIONS_EXCEED_CEILING",
          requested: actionClass,
          allowed: "blocked",
          direction: "max",
        },
      ],
    },
    AGENT_POLICY_CEILING_EXCEEDED,
  );
}

export interface DestructiveGateDeps {
  governance: Pick<ReturnType<typeof agentGovernanceService>, "resolveAgentPolicy">;
  workflow: Pick<ReturnType<typeof workflowEventsService>, "emit">;
}

export interface DestructiveGateVerdict {
  actionClass: ActionClassification;
  destructive: boolean;
  mode: AgentDestructiveActionMode;
}

/**
 * The connector-action half of the T5a gate, for a chokepoint where an agent
 * asks to act and a caller is still waiting for the answer.
 *
 * Off-profile (`resolveAgentPolicy` returns null) it returns null and does
 * nothing, exactly like the bridge and the connector-send apply path. On
 * profile it classifies the action with the shared classifier; a destructive
 * action under `blocked` records its `refused` verdict and throws the
 * named-ceiling error before any work is filed or sent. Otherwise it returns
 * the verdict, and the caller records the decision it actually took
 * (`recordDestructiveVerdict`) once the work's run id exists.
 */
export async function refuseBlockedDestructiveAction(
  deps: DestructiveGateDeps,
  input: {
    companyId: string;
    agentId: string;
    action: ClassifyConnectorAction;
    surface: string;
    pipelineId: string;
  },
): Promise<DestructiveGateVerdict | null> {
  const policy = await deps.governance.resolveAgentPolicy(input.companyId, input.agentId);
  if (!policy) return null;
  const classification = classifyAction(input.action);
  const mode = policy.destructiveActions;
  if (classification.destructive && mode === "blocked") {
    // Emit the verdict first so a refused action is as visible in the
    // measurement substrate as one that ran, then raise the refusal.
    await recordDestructiveVerdict(deps, {
      companyId: input.companyId,
      pipelineId: input.pipelineId,
      runId: randomUUID(),
      surface: input.surface,
      actionClass: classification.class,
      mode,
      decision: "refused",
    });
    throw destructiveActionBlocked(classification.class);
  }
  return { actionClass: classification.class, destructive: classification.destructive, mode };
}

export async function recordDestructiveVerdict(
  deps: Pick<DestructiveGateDeps, "workflow">,
  input: {
    companyId: string;
    pipelineId: string;
    runId: string;
    surface: string;
    actionClass: ActionClassification;
    mode: AgentDestructiveActionMode;
    decision: "refused" | "approval_raised" | "allowed";
  },
): Promise<void> {
  // `emit` reports a rejection through its return value and never throws; a
  // measurement failure must not fail the work it was measuring.
  await deps.workflow.emit({
    companyId: input.companyId,
    pipelineId: input.pipelineId,
    runId: input.runId,
    stepKey: "authorization",
    eventType: "destructive_action_gated",
    actorKind: "agent",
    payload: {
      surface: input.surface,
      actionClass: input.actionClass,
      mode: input.mode,
      decision: input.decision,
    },
  });
}
