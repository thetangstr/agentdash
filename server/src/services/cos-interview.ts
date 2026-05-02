import { FIXED_QUESTIONS, type InterviewState } from "@paperclipai/shared";

interface Deps {
  llm: (input: { system: string; messages: Array<{ role: "user" | "assistant"; content: string }> }) => Promise<{ text: string; readyToPropose: boolean }>;
}

interface NextTurnResult {
  assistantMessage: string | null; // null when status === "exceeded_max"
  state: InterviewState;
}

const MAX_FOLLOW_UPS = 4;

export function cosInterview(deps: Deps) {
  return {
    nextTurn: async (state: InterviewState): Promise<NextTurnResult> => {
      // Phase 1: fixed questions, no LLM call.
      if (state.fixedQuestionsAsked < FIXED_QUESTIONS.length) {
        const question = FIXED_QUESTIONS[state.fixedQuestionsAsked];
        return {
          assistantMessage: question,
          state: {
            ...state,
            fixedQuestionsAsked: state.fixedQuestionsAsked + 1,
            turns: [...state.turns, { role: "assistant", content: question, ts: new Date().toISOString() }],
          },
        };
      }
      // Phase 2: bounded adaptive follow-ups.
      if (state.followUpsAsked >= MAX_FOLLOW_UPS) {
        return {
          assistantMessage: null,
          state: { ...state, status: "exceeded_max" },
        };
      }
      const messages = state.turns.map((t) => ({ role: t.role, content: t.content }));
      const llmResult = await deps.llm({ system: systemPrompt(), messages });
      if (llmResult.readyToPropose) {
        return {
          assistantMessage: llmResult.text,
          state: {
            ...state,
            turns: [...state.turns, { role: "assistant", content: llmResult.text, ts: new Date().toISOString() }],
            status: "ready_to_propose",
          },
        };
      }
      return {
        assistantMessage: llmResult.text,
        state: {
          ...state,
          turns: [...state.turns, { role: "assistant", content: llmResult.text, ts: new Date().toISOString() }],
          followUpsAsked: state.followUpsAsked + 1,
          status: "in_progress",
        },
      };
    },
  };
}

let _systemPrompt: string | null = null;
function systemPrompt(): string {
  if (_systemPrompt) return _systemPrompt;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const promptPath = path.resolve(here, "../onboarding-assets/chief_of_staff/INTERVIEW.md");
    _systemPrompt = fs.readFileSync(promptPath, "utf8");
  } catch {
    _systemPrompt = "You are CoS. Ask one short follow-up question that helps you understand the user's bottleneck. Set readyToPropose=true when you can write a one-line agent role.";
  }
  return _systemPrompt;
}
