import Anthropic from "@anthropic-ai/sdk";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface LLMInput {
  system: string;
  messages: ChatMessage[];
}

const STUB_REPLY = "Got it. (stub reply — set ANTHROPIC_API_KEY to wire real Claude)";

// Singleton client + cached env state. The client itself is cheap to recreate, but
// caching it keeps SDK keepalive sockets warm across requests.
let cachedClient: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!cachedClient) cachedClient = new Anthropic({ apiKey: key });
  return cachedClient;
}

/**
 * CoS chat reply adapter. Returns a string for the assistant's next turn.
 *
 * Falls back to a stub when ANTHROPIC_API_KEY is unset so local dev works
 * without keys. The system prompt is sent with a cache_control breakpoint so
 * repeated turns within the same conversation hit the prompt cache (~90%
 * cheaper on input tokens after the first call).
 */
export async function anthropicLLM(input: LLMInput): Promise<string> {
  const client = getClient();
  if (!client) return STUB_REPLY;

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    thinking: { type: "disabled" },
    system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
    messages: input.messages,
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return text || STUB_REPLY;
}
