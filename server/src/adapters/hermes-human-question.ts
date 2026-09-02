// AgentDash (AGE-13): the human-question channel must fail closed.
//
// Hermes ships a `clarify` tool: a terminal prompt for the operator sitting at
// the keyboard. AgentDash runs `hermes chat -q` headless, so nobody is at that
// terminal. The prompt can only expire, and Hermes's expiry fallback tells the
// agent to "use your best judgement and proceed" — a question for a person that
// turns into an unsupervised decision by default. Both Hermes callbacks end the
// same way: the TUI one after a 120 s timeout, the one-shot one immediately.
// Neither touches AgentDash's interactions, inbox, or bridge APIs, so the
// question never reaches anyone and the run then reports success.
//
// This module is the seam AgentDash owns. It does two things:
//   1. Tells the agent, in the prompt, that `clarify` reaches nobody here and
//      that the supported path is an `ask_user_questions` interaction, which
//      parks the run until a person answers.
//   2. Watches the run's output for Hermes's fallback markers and, if one
//      fires, refuses to accept the run as successful work. The decision the
//      agent made after that point was not a person's; the run fails with an
//      explicit code so a steward can see exactly why.
//
// What it does not do: reach into the Hermes process. The adapter package does
// not expose the child pid to this wrapper, so the fallback cannot be
// interrupted mid-run — only refused afterwards. Delivering the question to the
// steward (inbox + bridge) is the transport work tracked on GH #540/#546.
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

export const HERMES_HUMAN_QUESTION_ERROR_CODE = "human_question_unanswered";

/**
 * Prompt section injected into every authenticated Hermes run, after the
 * mandate and directives and before the task template.
 */
export const HERMES_HUMAN_QUESTION_PROMPT = [
  "Human questions:",
  "Hermes's built-in `clarify` tool is a terminal prompt. Nobody is at this terminal in an AgentDash run, so it can only time out, and its fallback would hand the decision back to you. Never call `clarify` here.",
  "When a decision needs a person, create an `ask_user_questions` interaction on the current issue (`POST {{paperclipApiUrl}}/issues/{issueId}/interactions` with `kind: \"ask_user_questions\"`) and end your turn; the run resumes when it is answered. With no issue context, state the question in your final summary and stop.",
  "Do not make the decision yourself. A run in which the clarify fallback fires is failed and its work is not accepted.",
].join("\n");

/**
 * The strings Hermes emits when its clarify fallback fires. Matched after ANSI
 * stripping because the TUI path wraps its line in dim escape codes.
 *
 *   - `(clarify timed out after 120s — agent will decide)` — TUI callback,
 *     `hermes_cli/callbacks.py` and `cli.py`, after the configured timeout.
 *   - `[oneshot mode: no user available. …]` — one-shot callback,
 *     `hermes_cli/oneshot.py`, returned to the model immediately.
 *   - `The user did not provide a response within the time limit` — the tool
 *     result the TUI callback hands the model, in case a transcript echoes it.
 */
//
// Each marker is anchored to Hermes's own phrasing, never to a bare English
// phrase: the guard scans streamed model output too, and a model in an
// agent product will write "the agent will decide …" in ordinary prose. The
// TUI line is matched on its timeout preamble and, separately, on its
// dash-and-paren tail, so either half alone identifies the callback and
// neither is something a model says by accident.
const FALLBACK_MARKERS: RegExp[] = [
  /clarify timed out after \d+\s*s/i,
  /[—–-]\s*agent will decide\)/i,
  /\[oneshot mode: no user available/i,
  /did not provide a response within the time limit/i,
];

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPES, "");
}

/**
 * The first fallback marker present in a chunk of run output, or null. Returns
 * the matched text so the failure can quote exactly what Hermes said.
 */
export function detectHermesHumanQuestionFallback(chunk: string): string | null {
  if (typeof chunk !== "string" || chunk.length === 0) return null;
  const clean = stripAnsi(chunk);
  for (const marker of FALLBACK_MARKERS) {
    const match = marker.exec(clean);
    if (match) return match[0];
  }
  return null;
}

export function renderHermesHumanQuestionFallbackLog(marker: string): string {
  return (
    `[agentdash] Hermes clarify fallback fired ("${marker}"): the agent asked a person a question ` +
    `at a terminal nobody is watching, and Hermes handed the decision back to the agent. ` +
    `This run will be failed closed (${HERMES_HUMAN_QUESTION_ERROR_CODE}); the agent should have used an ` +
    `ask_user_questions interaction.\n`
  );
}

export function renderHermesHumanQuestionFallbackError(marker: string): string {
  return (
    `The agent asked a person a question through Hermes's terminal clarify tool. Nobody is at that ` +
    `terminal in an AgentDash run, so Hermes's fallback handed the decision back to the agent ` +
    `("${marker}"). The run is failed closed rather than accepted as work: whatever the agent did after ` +
    `that point was not decided by a person. Ask the agent to raise the question as an ` +
    `ask_user_questions interaction on the issue, which waits for an answer.`
  );
}

/**
 * Refuse a run in which the fallback fired. Preserves everything else on the
 * result (session, usage, exit code) so the failed run is still fully
 * attributable; only the outcome changes.
 */
export function failClosedOnHermesHumanQuestionFallback(
  result: AdapterExecutionResult,
  evidence: readonly string[],
): AdapterExecutionResult {
  const marker = evidence[0];
  if (!marker) return result;
  // An adapter that already failed keeps its own diagnosis; a second cause is
  // recorded in errorMeta rather than overwriting the first.
  if (result.errorMessage || result.timedOut || (result.exitCode ?? 0) !== 0) {
    return {
      ...result,
      errorMeta: { ...(result.errorMeta ?? {}), humanQuestionFallback: marker },
    };
  }
  return {
    ...result,
    errorCode: HERMES_HUMAN_QUESTION_ERROR_CODE,
    errorMessage: renderHermesHumanQuestionFallbackError(marker),
    errorMeta: { ...(result.errorMeta ?? {}), humanQuestionFallback: marker },
  };
}

/**
 * Wraps a run's `onLog` so every chunk is scanned, and hands back the
 * fail-closed transform to apply to the result. One guard per run.
 */
export function createHermesHumanQuestionGuard(
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
) {
  const evidence: string[] = [];
  const guardedOnLog = async (stream: "stdout" | "stderr", chunk: string): Promise<void> => {
    await onLog(stream, chunk);
    const marker = detectHermesHumanQuestionFallback(chunk);
    if (!marker) return;
    evidence.push(marker);
    if (evidence.length === 1) {
      await onLog("stderr", renderHermesHumanQuestionFallbackLog(marker));
    }
  };
  return {
    onLog: guardedOnLog,
    evidence: evidence as readonly string[],
    failClosed: (result: AdapterExecutionResult) => failClosedOnHermesHumanQuestionFallback(result, evidence),
  };
}
