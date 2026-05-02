// AgentDash: chat substrate card — onboarding interview question
import type { InterviewQuestionPayload } from "@paperclipai/shared";

export function InterviewQuestion({ payload }: { payload: InterviewQuestionPayload }) {
  return (
    <div className="interview-question">
      {typeof payload.fixedIndex === "number" && (
        <div className="text-xs text-gray-500 mb-1">Step {payload.fixedIndex + 1}</div>
      )}
      <div>{payload.question}</div>
    </div>
  );
}
