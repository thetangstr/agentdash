/**
 * Live smoke test for the agentdash_native in-process loop against a REAL
 * OpenAI-compatible inference gateway (OpenRouter / Fireworks / OpenAI).
 *
 * This is the one thing unit/integration tests (mocked fetch) cannot prove:
 * that a real model returns tool_calls in the wire format the loop parses.
 * It uses a stub local tool (get_time) so no running AgentDash server is needed.
 *
 * Run:
 *   AGENTDASH_GATEWAY_BASE_URL=https://openrouter.ai/api/v1 \
 *   AGENTDASH_GATEWAY_API_KEY=$OPENROUTER_API_KEY \
 *   GATEWAY_MODEL=openai/gpt-4o-mini \
 *   pnpm exec tsx scripts/smoke/native-adapter-loop-smoke.ts
 *
 * A free model (e.g. openai/gpt-oss-120b:free on OpenRouter) makes this zero-cost.
 * Exit 0 = the loop called the tool and produced a final answer.
 */

import { runAgentLoop } from "../../server/src/adapters/native/loop.js";
import type { Tool } from "../../server/src/adapters/native/tools.js";

const baseUrl = process.env.AGENTDASH_GATEWAY_BASE_URL;
const apiKey = process.env.AGENTDASH_GATEWAY_API_KEY;
const model = process.env.GATEWAY_MODEL ?? "openai/gpt-4o-mini";

if (!baseUrl || !apiKey) {
  console.error("Set AGENTDASH_GATEWAY_BASE_URL and AGENTDASH_GATEWAY_API_KEY to run the live smoke.");
  process.exit(2);
}

let toolCalled = false;
const getTimeTool: Tool = {
  schema: {
    type: "function",
    function: {
      name: "get_time",
      description: "Return the current server time as an ISO string.",
      parameters: { type: "object", properties: {} },
    },
  },
  execute: async () => {
    toolCalled = true;
    return { content: JSON.stringify({ now: "2026-06-24T00:00:00.000Z" }), isError: false };
  },
};

const result = await runAgentLoop({
  baseUrl,
  apiKey,
  model,
  systemPrompt: "You are a test agent. You have a get_time tool. Use it, then reply with the time you got.",
  userPrompt: "What is the current server time? Call get_time, then tell me.",
  tools: [getTimeTool],
  maxTurns: 5,
  timeoutMs: 60_000,
  onLog: async (_s, chunk) => process.stdout.write(chunk),
});

console.log("\n--- result ---");
console.log(JSON.stringify({ stopReason: result.stopReason, turns: result.turns, toolCalls: result.toolCalls, usage: result.usage, toolCalled }, null, 2));

const passed = result.stopReason === "completed" && toolCalled && result.finalText.length > 0;
console.log(passed ? "\nSMOKE: PASS" : "\nSMOKE: FAIL");
process.exit(passed ? 0 : 1);
