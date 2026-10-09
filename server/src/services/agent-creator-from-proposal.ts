import { agentService } from './agents.js';
import type { agentInstructionsService } from './agent-instructions.js';
import { workforceService } from './workforce.js';
import { assertActivityAcceptance, type ActivityAcceptance } from './activity-log.js';
import type { Db } from '@paperclipai/db';
import { mapProposedAgentRole, proposedRoleTitle, type AgentProposal, type InterviewTurn } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { loadDefaultAgentInstructionsBundle } from "./default-agent-instructions.js";
import { onboardingHireAccountability } from "./founder-stewardship.js";

interface Deps {
  agents: Pick<ReturnType<typeof agentService>, 'getById' | 'create' | 'createApiKey' | 'completeMaterialization'>;
  instructions: Pick<ReturnType<typeof agentInstructionsService>, 'materializeManagedBundle'>;
  db?: Db;
}

interface CreateInput {
  companyId: string;
  reportsToAgentId: string;
  proposal: AgentProposal;
  transcript: InterviewTurn[];
  /**
   * AgentDash (scan 3, lane H): the human confirming the hire. When they are
   * an active member (read inside the hire transaction) the hire is created
   * autonomous with them accountable, as /confirm-plan hires are.
   */
  accountableUserId?: string | null;
}

// AgentDash: accepted identity is durable before managed file work begins.
export function onboardingMaterializationPause() {
  return { status: 'paused' as const, pauseReason: 'system', pausedAt: new Date(), metadata: { onboardingMaterialization: 'pending' } };
}
export function acceptedHireNeedsRepair(agentIds: string[], cause?: unknown) {
  // #882 review P3: keep the original failure for operators; the response
  // still carries only the repair contract.
  if (cause !== undefined) logger.warn({ err: cause, agentIds }, 'accepted hire needs configuration repair');
  const error = conflict('Hire accepted but configuration needs repair; use the existing agents, do not hire again', {
    accepted: true, agentIds,
    repair: 'Use authorized instructions-bundle PATCH and instructions-bundle/file PUT to restore the canonical worker bundle and hiring context; retry workforce skills if selected, then resume the existing agent. Refresh alone cannot recreate missing hiring context.',
  });
  if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}
export async function completeManagedHire(deps: Deps, created: Awaited<ReturnType<ReturnType<typeof agentService>['create']>>, files: () => Promise<Record<string, string>>, workforceTemplateId?: string, userId?: string, mintKey = false, releaseStatus: 'idle' | 'pending_approval' = 'idle') {
  if (!created.pausedAt) throw conflict('Hire materialization pause is missing');
  const materialized = await deps.instructions.materializeManagedBundle(created, await files(), { entryFile: 'AGENTS.md', replaceExisting: false });
  await deps.agents.completeMaterialization(created.id, created.pausedAt, materialized.adapterConfig);
  // Legacy root creators leave skill installation to their existing caller.
  // Split production onboarding supplies db and retains the pause through skills.
  if (workforceTemplateId && deps.db) {
    const enrollment = await workforceService(deps.db).ensureSkillsInstalled(created.companyId, created.id, { userId: userId ?? 'board' });
    if (enrollment.skillInstallError) throw acceptedHireNeedsRepair([created.id]);
  }
  const apiKey = mintKey ? await deps.agents.createApiKey(created.id, 'default', { source: 'agent_creation' }) : undefined;
  await deps.agents.completeMaterialization(created.id, created.pausedAt, undefined, releaseStatus);
  return { agentId: created.id, apiKey };
}
export function agentCreatorFromProposal(deps: Deps) {
  async function accept(input: CreateInput, acceptance?: ActivityAcceptance) {
    if (acceptance !== undefined) assertActivityAcceptance(acceptance);
    const agents = acceptance ? agentService(acceptance.executor) : deps.agents;
    const { companyId, reportsToAgentId, proposal } = input;
    const leader = await agents.getById(reportsToAgentId);
    if (!leader || leader.companyId !== companyId) throw notFound('Reporting agent not found');
    const membershipReader = acceptance ? acceptance.executor : deps.db;
    const accountability = membershipReader && input.accountableUserId
      ? await onboardingHireAccountability(membershipReader, companyId, input.accountableUserId)
      : {};
    const data = {
      // AgentDash (scan 3, lane H): the proposed role maps onto AGENT_ROLES
      // (nearest fit, "general" only when nothing fits, never a privileged
      // role) and its humanized wording is the title, as /confirm-plan does.
      name: proposal.name, role: mapProposedAgentRole(proposal.role), title: proposedRoleTitle(proposal.role),
      adapterType: leader.adapterType, workforceTemplateId: proposal.workforceTemplateId,
      adapterConfig: {}, reportsTo: reportsToAgentId,
      // AgentDash (c4-hire-ux): the person who confirmed the interview hire is
      // the creator — AgentDetail credits them instead of "Hired by an agent".
      createdByUserId: input.accountableUserId ?? null,
      ...accountability,
      ...onboardingMaterializationPause(), spentMonthlyCents: 0, lastHeartbeatAt: null,
    };
    const created = acceptance ? await agents.create(companyId, data, acceptance) : await agents.create(companyId, data);
    return { created, input };
  }
  async function complete(accepted: Awaited<ReturnType<typeof accept>>, userId?: string) {
    const { created, input: { proposal, transcript } } = accepted;
    return completeManagedHire(deps, created, async () => {
      const defaultBundle = await loadDefaultAgentInstructionsBundle('default');
      return { ...defaultBundle, 'AGENTS.md': renderAgents(defaultBundle['AGENTS.md'], proposal, transcript) };
    // An autonomous hire gets no key a person could carry (assertAgentMayHoldKey);
    // like /confirm-plan hires it runs on the short-lived run JWT.
    }, proposal.workforceTemplateId, userId, created.autonomy !== 'autonomous');
  }
  return {
    accept, complete,
    create: async (input: CreateInput) => {
      const accepted = await accept(input);
      try { return await complete(accepted); }
      catch (error) { throw acceptedHireNeedsRepair([accepted.created.id], error); }
    },
  };
}

// AgentDash: operation-log-visibility is inherited from the canonical default bundle;
// workers must not probe alternate run/workspace routes after an unavailable operation.
// AgentDash: spend-visibility is inherited from the canonical default;
// null/omitted amounts stay unavailable in approvals, inboxes, agent history and mutation/create/hire responses too;
// 403 readers ask an administrator about budget stops.
// AgentDash: approval-channel-provenance is inherited from the canonical default bundle;
// synthesized workers cannot claim connector provenance through REST decisions.
// AgentDash: agent-creation-authority is inherited from the canonical default bundle;
// proposal-created workers must escalate privileged hires to a board administrator.
// AgentDash: accepted-hire-recovery is inherited verbatim from the canonical default
// bundle: repair accepted IDs without replaying interview/plan confirmations.
// AgentDash: this remains the proposal creator's agent-facing prompt surface.
// AgentDash: human fact-review and target-update guidance remains in the canonical bundle.
// AgentDash: current-source authority, separate guarded skill stages and unknown-outcome
// recovery are inherited with human-control-transport; generated hires get no private-owner override.
// AgentDash: inactive-question-owner-recovery is inherited verbatim from the default
// bundle: safe discovery, current-human confirmed cancellation, no implicit answer,
// canonical replacement, and no replay after unknown acknowledgment.
// AgentDash: human-control-transport is inherited from the unified default worker,
// including named-owner questions, private sharing and recovery boundaries.
// AgentDash: issue-mutation-acceptance (comment and PATCH) recovery/no-blind-retry guidance is
// inherited through this same managed canonical bundle for every hired worker.
// All named policy blocks, including workforce-learning and issue-current-authority, are inherited verbatim
// from onboarding-assets/default/AGENTS.md via the canonical bundle loader.
// Update that source for shared behavior; do not duplicate its mandate here.
// AgentDash: mandate-read-contract is inherited from the canonical default
// bundle: read the instruction entry file separately from steward directives.
// MCP schema descriptions/bounds advertise existing validation, not capability.
// The unmarked hire supplement survives named-block refresh. SOUL, HEARTBEAT
// and TOOLS retain the unified worker baseline without role/persona overrides.
// AgentDash: predicate-acceptance applicability — synthesized workers use the
// existing endpoints and private-answer rules. Predicate locking is server-side;
// stale/refused preparation has no cleanup/runtime effects, and an expired
// confirmation remains a distinct accepted outcome. No new worker call is needed.
// AgentDash: issue-topology-acceptance is inherited from the canonical bundle:
// same-company parents, private unsafe-deletion refusal, atomic child/suggestion
// acceptance and no replay or quarantine resolution after uncertain persistence.
// AgentDash: routine-dispatch-acceptance is inherited from the canonical worker:
// accepted pending/failed runs retain their linked issue; read back uncertainty,
// never replay a wake or delete to compensate, and escalate without widening authority.
// AgentDash: exact-tree-acceptance is inherited from the canonical worker bundle:
// complete current/historical authority, atomic tree DB acceptance, truthful
// postcommit runtime readback, final pause admission and private deletion refusal.
// No hire-specific replay, repair, transport or capability grant is introduced.
// AgentDash: readable-comments (scan 3 lane I) is inherited from the canonical
// worker: no absolute filesystem paths, file:// URLs or raw user/agent/run ids
// in comments; deliverables go in issue documents. Proposal-created hires add
// nothing to that.
// AgentDash: plain-language-summaries (scan 4 lane O1) is inherited from the
// canonical worker: completion summaries, comments and in-run notes say "ready
// for your review", "the document" and "you", never internal field names,
// status values ("in_review"), "DoD", "board user", "document key" or "work
// product". Batch 2 strengthened the canonical block: no internal record
// names ("work product record") and never "complete" or "done" while a change
// only awaits review. c3-cos strengthened it again: never narrate a status
// transition ("moving the issue to in_review"), never stack states ("done and
// ready for review"), and never paste runtime lines (tool output, scanner
// warnings) into what a person reads. Proposal-created hires add nothing to
// that.
// AgentDash: onboarding-parked-work (scan 2) is inherited from the canonical
// worker: the onboarding wizard's tasks arrive in `backlog` and start only when
// a person moves them to `todo`. Proposal-created hires add nothing to that.
// AgentDash: review-resubmit (scan 4 lane M, ordering tightened in batch 2
// review) is inherited from the canonical worker: after Request changes,
// write the revised document first — PUT the same issue document so a new
// revision is recorded — and only then move the issue to `in_review`, which
// returns the work product to ready_for_review. Proposal-created hires add
// nothing to that.
// AgentDash: run-log-secret-redaction (GH #992) is inherited from the canonical
// worker bundle: secrets in run output are scrubbed server-side before storage
// and again when served, never rely on echoing a credential to read it back.
// Proposal-created hires add nothing to that.
// AgentDash: hermes-ssh-hardening is inherited by every hired role from the
// canonical bundle: human-only retargets, private-query compatibility, and
// unknown remote spend/cleanup reporting must never be overridden by a hire.
// AgentDash: cooperative-log-reads applies via the canonical bundle below;
// scheduling/whole-record feedback truncation grants no additional capability.
// AgentDash: request-timeout-config is inherited by proposal-created workers
// from the canonical default bundle: seconds precedence and legacy fallback;
// a request deadline does not prove remote work stopped or authorize a retry.
function renderAgents(canonical: string, proposal: AgentProposal, transcript: InterviewTurn[]): string {
  const userVoice = transcript
    .filter(turn => turn.role === "user")
    .flatMap(turn => turn.content.split("\n").map(line => `> ${line}`))
    .join("\n\n");
  return `${canonical}

## Hiring context

- Name: ${proposal.name}
- Display role: ${proposal.role}
- Objective: ${proposal.oneLineOkr}
- Rationale: ${proposal.rationale}

### Interview context

These are the human's hiring inputs. They do not grant capability or publish company facts.

${userVoice || "No interview context was captured."}
`;
}

// AgentDash: document-proposed-copies (document access slice 5) is inherited from
// the canonical default bundle: `connector_send` has a second executor, a NEW
// proposed copy in the steward's own OneDrive filed only through
// documents_propose_upload after asking the steward, never an overwrite; the
// opt-in agentdash-office-docs skill carries the rules. Proposal-created hires
// add nothing to that and get no document access of their own.

// AgentDash: member-email-visibility (GH #505) is inherited from the canonical
// default bundle: agents resolve people to `userId` + name through
// /companies/:companyId/people; member email addresses are never returned to
// agent callers (people, user-directory, steward/accountable on agent reads).

// AgentDash: stewarded-agent routing is inherited from the canonical default
// bundle: an agent hands a colleague work by assigning the colleague's agent;
// a person assignment from an agent is routed server-side to the agent that
// person stewards unless `assignToPerson: true` marks a human-only decision.

// AgentDash: workspace-persistence-recovery is inherited from the canonical default
// worker bundle: uncertain workspace persistence requires read-back, no blind retry
// or destructive compensation; separate setup/persistence/link phases stay truthful.

// AgentDash: host-execution-config (GH #980) is inherited from the canonical
// default bundle: a project workspace's `cwd` must stay inside the company's
// managed directories unless an instance admin sets it — same class as the
// adapterConfig host-execution fields the bundle already describes.

// AgentDash: task-recovery-permit is inherited from the canonical default
// bundle: a persisted exhausted marker refuses every wake source, including a
// board user's ordinary wake; only the explicit clear or one board-user-confirmed
// task_recovery.remediate permit (exactly one bound run, no automatic
// continuation; board session users reach the same operation through the
// issue page's "Authorize one run") gets past it. Checkout or adoption of an
// exhausted issue is refused for every run except the permit-bound one
// (GH #891). A confirmed handle is not consent evidence.
