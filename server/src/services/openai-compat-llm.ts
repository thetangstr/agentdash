interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface LLMInput {
  system: string;
  messages: ChatMessage[];
}

// OpenAI-compatible chat-completions adapter. Works with any provider that
// implements POST {baseURL}/chat/completions in OpenAI's schema — OpenRouter,
// Fireworks AI, Together, Groq, etc. Configured entirely by env so the same
// code serves every provider; only the base URL / key / model differ.
//
// Fetch-based (no SDK dependency), mirroring server/src/auth/email.ts's Resend
// wrapper. The provider's `usage` block (and OpenRouter's `usage.cost`) is
// surfaced via openaiCompatLLMDetailed() for metering (see cost_events / G3).
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-4o-mini"; // cheap, capable default; override per-tier
const DEFAULT_MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 45_000;

const STUB_REPLY =
  "Got it. (stub reply — set OPENAI_COMPAT_API_KEY to wire an OpenAI-compatible provider)";

/**
 * Token + cost usage as reported by an OpenAI-compatible provider.
 * `costUsd` is populated by providers that return it (e.g. OpenRouter's
 * `usage.cost`); left undefined otherwise so callers can price from tokens.
 */
export interface OpenAICompatUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
}

export interface OpenAICompatResult {
  text: string;
  /** Undefined in stub mode (no key) since no request was made. */
  usage?: OpenAICompatUsage;
}

/**
 * Detailed CoS chat reply via any OpenAI-compatible provider, returning both
 * the reply text and the provider's usage (for metering).
 *
 * Configured entirely by env (read at call time, no restart needed):
 *   - OPENAI_COMPAT_API_KEY    (required to leave stub mode)
 *   - OPENAI_COMPAT_BASE_URL   (default https://openrouter.ai/api/v1)
 *   - OPENAI_COMPAT_MODEL      (default openai/gpt-4o-mini)
 *   - OPENAI_COMPAT_MAX_TOKENS (default 1024)
 */
export async function openaiCompatLLMDetailed(
  input: LLMInput,
): Promise<OpenAICompatResult> {
  const key = process.env.OPENAI_COMPAT_API_KEY;
  if (!key) return { text: STUB_REPLY };

  const baseURL = (process.env.OPENAI_COMPAT_BASE_URL ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const model = (process.env.OPENAI_COMPAT_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const maxTokens = Number(process.env.OPENAI_COMPAT_MAX_TOKENS) || DEFAULT_MAX_TOKENS;

  // OpenAI chat format: the system prompt is the first message with role "system".
  const messages = [{ role: "system", content: input.system }, ...input.messages];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `[openai-compat-llm] ${res.status} ${res.statusText}: ${detail.slice(0, 500)}`,
    );
  }

  const body = (await res.json()) as {
    model?: string;
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
    };
  };

  const text = (body.choices?.[0]?.message?.content ?? "").trim();
  const usage: OpenAICompatUsage = {
    model: body.model ?? model,
    promptTokens: body.usage?.prompt_tokens ?? 0,
    completionTokens: body.usage?.completion_tokens ?? 0,
    costUsd: body.usage?.cost,
  };

  return { text: text || STUB_REPLY, usage };
}

/**
 * CoS chat reply adapter backed by any OpenAI-compatible provider.
 *
 * Returns a string for the assistant's next turn. Falls back to a stub when
 * OPENAI_COMPAT_API_KEY is unset so local dev works without a key.
 */
export async function openaiCompatLLM(input: LLMInput): Promise<string> {
  const { text } = await openaiCompatLLMDetailed(input);
  return text;
}
