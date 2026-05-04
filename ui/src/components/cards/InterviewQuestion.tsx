// AgentDash: chat substrate card — onboarding interview question
import type { InterviewQuestionPayload } from "@paperclipai/shared";

// Note: In the chat panel, MessageList renders interview_question_v1 messages
// directly as a normal agent text bubble (no "Step N" chip). This component is
// kept for non-chat contexts that render cards directly via CardRenderer.
export function InterviewQuestion({ payload }: { payload: InterviewQuestionPayload }) {
  return (
    <div className="interview-question">
      <div className="text-text-primary text-sm leading-relaxed">{payload.question}</div>
    </div>
  );
}
