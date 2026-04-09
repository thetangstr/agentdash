import Anthropic from "@anthropic-ai/sdk";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber } from "../utils.js";

function estimateCost(usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null }, model: string): number {
  // Approximate pricing per million tokens (as of 2025)
  const pricing: Record<string, { input: number; output: number }> = {
    "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
    "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
    "claude-haiku-3-5-20241022": { input: 0.8, output: 4.0 },
  };
  const rates = pricing[model] ?? { input: 3.0, output: 15.0 };
  const inputTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0);
  return (inputTokens * rates.input + usage.output_tokens * rates.output) / 1_000_000;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, context, agent } = ctx;

  const apiKey = asString(config.apiKey, "") || process.env.ANTHROPIC_API_KEY || "";
  const model = asString(config.model, "claude-sonnet-4-20250514");
  const maxTokens = asNumber(config.maxTokens, 4096);
  const systemPromptOverride = asString(config.systemPrompt, "");

  // Build system message
  const defaultSystemPrompt = asString(context.paperclipCoordinationPrompt, "") || `You are ${agent.name}, an AI agent. Complete the requested task thoroughly and accurately.`;
  const systemMessage = systemPromptOverride || defaultSystemPrompt;

  // Build user message from available context
  const parts: string[] = [];
  if (context.issueTitle) parts.push(`Task: ${asString(context.issueTitle, "")}`);
  if (context.issueDescription) parts.push(`Description:\n${asString(context.issueDescription, "")}`);
  if (context.wakeReason) parts.push(`Wake reason: ${asString(context.wakeReason, "")}`);
  if (context.additionalContext) parts.push(`Additional context:\n${asString(context.additionalContext, "")}`);
  const userMessage = parts.length > 0 ? parts.join("\n\n") : "Please proceed with your assigned task.";

  const client = new Anthropic({ apiKey: apiKey || undefined });

  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemMessage,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    await ctx.onLog("stdout", text);

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: text.slice(0, 200) || "Completed",
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cachedInputTokens: (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
      },
      model: response.model,
      provider: "anthropic",
      billingType: "api",
      costUsd: estimateCost(
        {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_input_tokens: (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens,
        },
        response.model,
      ),
      resultJson: {
        content: response.content as unknown as Record<string, unknown>[],
        stopReason: response.stop_reason,
      },
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await ctx.onLog("stderr", `claude_api error: ${errorMessage}`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage,
    };
  }
}
