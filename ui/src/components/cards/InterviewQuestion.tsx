// AgentDash: chat substrate card — onboarding interview question
import type { InterviewQuestionPayload } from "@paperclipai/shared";

// Note: The step chip and bubble wrapper are rendered by MessageList when
// cardKind === "interview_question_v1". This component is kept for non-chat
// contexts that may render cards directly via CardRenderer.
export function InterviewQuestion({ payload }: { payload: InterviewQuestionPayload }) {
  return (
    <div className="interview-question">
      {typeof payload.fixedIndex === "number" && (
        <span className="text-[10px] font-semibold tracking-widest uppercase text-accent-500 block mb-1">
          Step {payload.fixedIndex + 1}
        </span>
      )}
      <div className="text-text-primary text-sm leading-relaxed">{payload.question}</div>
    </div>
  );
}
