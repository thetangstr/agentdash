import type { Db } from "@paperclipai/db";
import { trackAgentTaskCompleted } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { agentService } from "./agents.js";
import { cosReviewerAutoHire } from "./cos-reviewer-auto-hire.js";
import { cosVerdictOrchestrator } from "./cos-verdict-orchestrator.js";
import { featureFlagsService } from "./feature-flags.js";
import type { issuePatchActions } from "./issue-patch-actions.js";
import { verdictsService } from "./verdicts.js";

export type IssuePatchHooks = NonNullable<Parameters<typeof issuePatchActions>[2]>;

type StatusOrchestrator = Pick<ReturnType<typeof cosVerdictOrchestrator>, "onIssueStatusChanged">;
type AgentReader = Pick<ReturnType<typeof agentService>, "getById">;

/** The review-queue orchestrator every issue update path reports status changes to. */
export function issueStatusOrchestrator(db: Db): StatusOrchestrator {
  return cosVerdictOrchestrator(db, {
    verdicts: verdictsService(db),
    featureFlags: featureFlagsService(db),
    autoHire: cosReviewerAutoHire(db),
  });
}

/**
 * The hooks every caller of `issuePatchActions` passes, so an update made
 * from the page and the same update made elsewhere (the bridge close-out in
 * steward-requests.ts) have the same effects: a status change keeps the
 * review queue right (`in_review` enqueues, `done`/`cancelled` dequeues, so a
 * finished issue is never escalated by the review cycle), and an agent
 * finishing an issue is counted in telemetry. A caller that already holds
 * the orchestrator or the agent service passes them in.
 */
export function issuePatchHooks(
  db: Db,
  deps: { orchestrator?: StatusOrchestrator; agents?: AgentReader } = {},
): Required<IssuePatchHooks> {
  const orchestrator = deps.orchestrator ?? issueStatusOrchestrator(db);
  const agents = deps.agents ?? agentService(db);
  return {
    statusChanged: (issueId, before, after) => orchestrator.onIssueStatusChanged(issueId, before, after),
    completed: async (agentId) => {
      const tc = getTelemetryClient();
      if (!tc) return;
      const agent = await agents.getById(agentId);
      if (!agent) return;
      trackAgentTaskCompleted(tc, {
        agentRole: agent.role,
        agentId: agent.id,
        adapterType: agent.adapterType,
        model: typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : undefined,
      });
    },
  };
}
