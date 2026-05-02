// AgentDash: chat substrate card — onboarding interview question
import type { InterviewQuestionPayload } from "@paperclipai/shared";

export function InterviewQuestion({ payload }: { payload: InterviewQuestionPayload }) {
  return (
    <div className="interview-question">
      {typeof payload.fixedIndex === "number" && (
        <div className="text-xs text-text-tertiary mb-1 font-medium tracking-wide uppercase">
          Step {payload.fixedIndex + 1}
        </div>
      )}
      <div className="text-text-primary">{payload.question}</div>
    </div>
  );
}
