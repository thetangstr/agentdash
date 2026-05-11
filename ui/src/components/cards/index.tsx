// AgentDash: chat substrate card renderer + re-exports
import { ProposalCard } from "./ProposalCard";
import { InvitePrompt } from "./InvitePrompt";
import { AgentStatusCard } from "./AgentStatusCard";
import { InterviewQuestion } from "./InterviewQuestion";
import { AgentPlanProposal } from "./AgentPlanProposal";
// AgentDash: goals-eval-hitl card stubs (full components ship in Phase F/H)
import { VerdictReviewCard } from "./VerdictReviewCard";
import { HumanTasteGateCard } from "./HumanTasteGateCard";

export interface CardContext {
  onProposalConfirm?: () => void;
  onProposalReject?: (reason?: string) => void;
  onInviteSend?: (emails: string[]) => Promise<void>;
  onInviteSkip?: () => void;
}

export function CardRenderer({
  cardKind,
  payload,
  context,
}: {
  cardKind: string;
  payload: Record<string, unknown> | null | undefined;
  context: CardContext;
}) {
  switch (cardKind) {
    case "proposal_card_v1":
      return (
        <ProposalCard
          payload={payload as any}
          onConfirm={context.onProposalConfirm ?? (() => {})}
          onReject={context.onProposalReject ?? (() => {})}
        />
      );
    case "invite_prompt_v1":
      return (
        <InvitePrompt
          companyId={(payload as any)?.companyId ?? ""}
          conversationId={(payload as any)?.conversationId ?? ""}
          onSendInvites={context.onInviteSend ?? (async () => {})}
          onSkip={context.onInviteSkip ?? (() => {})}
        />
      );
    case "agent_status_v1":
      return <AgentStatusCard payload={payload as any} />;
    case "interview_question_v1":
      return <InterviewQuestion payload={payload as any} />;
    case "agent_plan_proposal_v1":
      return (
        <AgentPlanProposal
          payload={payload as any}
          onConfirm={context.onProposalConfirm ?? (() => {})}
          onRevise={(text) => context.onProposalReject?.(text)}
        />
      );
    // AgentDash: goals-eval-hitl
    case "verdict_review":
      return <VerdictReviewCard payload={payload as any} />;
    case "human_taste_gate":
      return <HumanTasteGateCard payload={payload as any} />;
    default:
      return null;
  }
}

export {
  ProposalCard,
  InvitePrompt,
  AgentStatusCard,
  InterviewQuestion,
  AgentPlanProposal,
  // AgentDash: goals-eval-hitl
  VerdictReviewCard,
  HumanTasteGateCard,
};
