// AgentDash: chat substrate card renderer + re-exports
import { ProposalCard } from "./ProposalCard";
import { InvitePrompt, type InviteSendResult } from "./InvitePrompt";
import { AgentStatusCard } from "./AgentStatusCard";
import { InterviewQuestion } from "./InterviewQuestion";
import { AgentPlanProposal } from "./AgentPlanProposal";
// AgentDash: goals-eval-hitl card stubs (full components ship in Phase F/H)
import { VerdictReviewCard } from "./VerdictReviewCard";
import { HumanTasteGateCard } from "./HumanTasteGateCard";
import { DispatchErrorCard } from "./DispatchErrorCard";
// AgentDash (scan 3, lane G): a task the CoS created from chat
import { IssueCreatedCard } from "./IssueCreatedCard";
import { IssueProposalCard } from "./IssueProposalCard";

export interface CardContext {
  onProposalConfirm?: () => void;
  onProposalReject?: (reason?: string) => void;
  onInviteSend?: (emails: string[]) => Promise<InviteSendResult | void>;
  onInviteSkip?: () => void;
  /** AgentDash: re-dispatch a message whose reply failed (dispatch error card). */
  onDispatchRetry?: (messageId: string) => Promise<void> | void;
  /** AgentDash: whether this viewer may retry that message (only its author can). */
  canDispatchRetry?: (messageId: string) => boolean;
}

export function CardRenderer({
  cardKind,
  payload,
  context,
  messageId,
  conversationId,
}: {
  cardKind: string;
  payload: Record<string, unknown> | null | undefined;
  context: CardContext;
  /** AgentDash (scan 3, lane G): the card's own message, for cards that act on it. */
  messageId?: string;
  conversationId?: string;
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
    case "cos_dispatch_error_v1":
      return <DispatchErrorCard payload={payload as any} onRetry={
          context.canDispatchRetry && payload && typeof (payload as any).retryMessageId === "string" && !context.canDispatchRetry((payload as any).retryMessageId)
            ? undefined
            : context.onDispatchRetry
        } />;
    case "issue_created_v1":
      return <IssueCreatedCard payload={payload as any} />;
    case "issue_proposal_v1":
      return <IssueProposalCard payload={payload as any} messageId={messageId} conversationId={conversationId} />;
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
  DispatchErrorCard,
  IssueCreatedCard,
  IssueProposalCard,
};
