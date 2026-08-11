import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * The Chief of Staff's interview prompt, read from INTERVIEW.md.
 *
 * This used to call bare `require("node:fs")`. The server runs as ESM, where
 * `require` is not defined, so the call threw ReferenceError on the very first
 * invocation, the bare `catch` swallowed it, and every interview since has run
 * on the one-sentence fallback below instead of the 1.1KB of actual guidance in
 * INTERVIEW.md. Nothing surfaced it: the stub is a plausible instruction, so the
 * model still asked plausible-looking questions — it simply never had the rules
 * about what "enough to propose an agent" means, which is the part that decides
 * whether the interview ever crystallizes into a usable plan.
 *
 * Identical in shape to the `hasBinary` bug in adapter-presets.ts: correct-looking
 * code, a swallowed runtime error, and a degraded path that reads as success. The
 * imports are static now, so a missing file is a startup failure rather than a
 * silent downgrade discovered months later.
 */
let _systemPrompt: string | null = null;
function systemPrompt(): string {
  if (_systemPrompt) return _systemPrompt;
  const here = dirname(fileURLToPath(import.meta.url));
  const promptPath = resolve(here, "../onboarding-assets/chief_of_staff/INTERVIEW.md");
  _systemPrompt = readFileSync(promptPath, "utf8");
  return _systemPrompt;
}

/** Exported for tests: proves the real asset loads rather than a stub. */
export function __systemPromptForTest(): string {
  return systemPrompt();
}
