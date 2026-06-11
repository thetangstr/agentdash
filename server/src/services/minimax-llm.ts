import Anthropic from "@anthropic-ai/sdk";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface LLMInput {
  system: string;
  messages: ChatMessage[];
}

// MiniMax exposes an Anthropic-compatible Messages API, so we drive it with the
// same `@anthropic-ai/sdk` client — only the base URL, key, and model differ.
// Docs: https://platform.minimaxi.com/docs/api-reference/text-chat-anthropic
// The SDK posts to `${baseURL}/v1/messages`, which resolves to
// `https://api.minimaxi.com/anthropic/v1/messages` — the documented endpoint.
const DEFAULT_BASE_URL = "https://api.minimaxi.com/anthropic";
const DEFAULT_MODEL = "MiniMax-M3"; // newest/recommended; MiniMax-M2.x also valid
const DEFAULT_MAX_TOKENS = 1024;

const STUB_REPLY = "Got it. (stub reply — set MINIMAX_API_KEY to wire MiniMax)";

// Singleton client, re-created if the key or base URL changes (env is read at
// call time so deployments can configure without a code change).
let cachedClient: Anthropic | null = null;
let cachedKey: string | null = null;
let cachedBaseUrl: string | null = null;

function getClient(): Anthropic | null {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) return null;
  const baseURL = process.env.MINIMAX_BASE_URL ?? DEFAULT_BASE_URL;
  if (!cachedClient || cachedKey !== key || cachedBaseUrl !== baseURL) {
    cachedClient = new Anthropic({ apiKey: key, baseURL });
    cachedKey = key;
    cachedBaseUrl = baseURL;
  }
  return cachedClient;
}

/**
 * CoS chat reply adapter backed by MiniMax via its Anthropic-compatible API.
 *
 * Returns a string for the assistant's next turn. Falls back to a stub when
 * MINIMAX_API_KEY is unset so local dev works without a key.
 *
 * Configured entirely by env:
 *   - MINIMAX_API_KEY   (required to leave stub mode)
 *   - MINIMAX_BASE_URL  (default https://api.minimaxi.com/anthropic)
 *   - MINIMAX_MODEL     (default MiniMax-M3)
 *   - MINIMAX_MAX_TOKENS (default 1024)
 *
 * Note: unlike the native Anthropic path we send `system` as a plain string
 * (no `cache_control` breakpoint) — MiniMax's compat layer does not advertise
 * Anthropic prompt caching, and an unknown field risks a 4xx on some compat
 * servers. Text blocks are extracted from the response; any thinking/reasoning
 * blocks MiniMax-M3 emits are ignored.
 */
export async function minimaxLLM(input: LLMInput): Promise<string> {
  const client = getClient();
  if (!client) return STUB_REPLY;

  const model = (process.env.MINIMAX_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const maxTokens = Number(process.env.MINIMAX_MAX_TOKENS) || DEFAULT_MAX_TOKENS;

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: input.system,
    messages: input.messages,
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return text || STUB_REPLY;
}
