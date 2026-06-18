# OpenAI-Compatible LLM Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `openai_compat` CoS-chat adapter so AgentDash can route LLM replies through any OpenAI-compatible provider (OpenRouter, Fireworks AI, Together, Groq) via env config — the inference backbone for the usage-based **Cloud SKU** (milestone G1 of [`doc/2026-06-08-deployment-and-inference-skus.md`](../../../doc/2026-06-08-deployment-and-inference-skus.md)).

**Architecture:** A new fetch-based service `openaiCompatLLM(input)` posts to `{baseURL}/chat/completions` in OpenAI's schema (no new SDK dependency — mirrors the existing fetch-based Resend wrapper). It is wired into `dispatchLLM` as the `openai_compat` adapter, mirroring the existing `minimax` branch: real reply when keyed, stub when unkeyed, fall back to `claude_api` on error/empty. One adapter serves every OpenAI-compatible provider by swapping `OPENAI_COMPAT_BASE_URL` / `OPENAI_COMPAT_MODEL`.

**Tech Stack:** TypeScript, Node 20 global `fetch`, Vitest, existing `dispatch-llm.ts` adapter router.

---

## File Structure

- **Create** `server/src/services/openai-compat-llm.ts` — the adapter (single exported `openaiCompatLLM`). Sibling to `minimax-llm.ts`; one responsibility: turn an `LLMInput` into a reply via an OpenAI-compatible endpoint.
- **Create** `server/src/__tests__/openai-compat-llm.test.ts` — unit tests, mirroring `minimax-llm.test.ts` but mocking global `fetch`.
- **Modify** `server/src/services/dispatch-llm.ts` — import the adapter, add the `openai_compat` routing branch, add `"openai_compat"` to `SUPPORTED_COS_CHAT_ADAPTERS`.
- **Modify** `server/src/__tests__/dispatch-llm.test.ts` — add a routing test for the new adapter.
- **Modify** `doc/LAUNCH.md` — document the new adapter + its env vars in §4.

> **Consistency note:** the `if (!reply)` empty-reply branch in `dispatchLLM` is dead for adapters that return `text || STUB` (the adapter is never falsy). We intentionally **mirror the existing `minimax` shape** here for consistency; the dead-branch cleanup is tracked separately in the code-review findings and is out of scope for this plan.

---

## Task 1: Create the `openai_compat` adapter

**Files:**
- Create: `server/src/services/openai-compat-llm.ts`
- Test: `server/src/__tests__/openai-compat-llm.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/openai-compat-llm.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openaiCompatLLM } from "../services/openai-compat-llm.js";

const ORIG = {
  key: process.env.OPENAI_COMPAT_API_KEY,
  base: process.env.OPENAI_COMPAT_BASE_URL,
  model: process.env.OPENAI_COMPAT_MODEL,
};

const INPUT = {
  system: "You are a Chief of Staff.",
  messages: [{ role: "user" as const, content: "Help me hire agents." }],
};

function mockFetchOnce(json: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => json,
    text: async () => JSON.stringify(json),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("openaiCompatLLM", () => {
  beforeEach(() => {
    delete process.env.OPENAI_COMPAT_API_KEY;
    delete process.env.OPENAI_COMPAT_BASE_URL;
    delete process.env.OPENAI_COMPAT_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of Object.entries({
      OPENAI_COMPAT_API_KEY: ORIG.key,
      OPENAI_COMPAT_BASE_URL: ORIG.base,
      OPENAI_COMPAT_MODEL: ORIG.model,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns a stub and never calls fetch when OPENAI_COMPAT_API_KEY is unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const reply = await openaiCompatLLM(INPUT);
    expect(reply).toContain("stub reply");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to {baseURL}/chat/completions with bearer auth and default model when keyed", async () => {
    process.env.OPENAI_COMPAT_API_KEY = "or-test-key";
    const fetchMock = mockFetchOnce({
      choices: [{ message: { content: "What's your top goal?" } }],
    });

    const reply = await openaiCompatLLM(INPUT);

    expect(reply).toBe("What's your top goal?");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.authorization).toBe("Bearer or-test-key");
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("openai/gpt-4o-mini");
    expect(sent.messages[0]).toEqual({ role: "system", content: INPUT.system });
    expect(sent.messages[1]).toEqual({ role: "user", content: "Help me hire agents." });
  });

  it("honors OPENAI_COMPAT_MODEL and OPENAI_COMPAT_BASE_URL overrides (trailing slash trimmed)", async () => {
    process.env.OPENAI_COMPAT_API_KEY = "fw-test-key";
    process.env.OPENAI_COMPAT_MODEL = "accounts/fireworks/models/llama-v3p1-70b-instruct";
    process.env.OPENAI_COMPAT_BASE_URL = "https://api.fireworks.ai/inference/v1/";
    const fetchMock = mockFetchOnce({ choices: [{ message: { content: "ok" } }] });

    await openaiCompatLLM(INPUT);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
    expect(JSON.parse(init.body).model).toBe(
      "accounts/fireworks/models/llama-v3p1-70b-instruct",
    );
  });

  it("throws on a non-2xx response", async () => {
    process.env.OPENAI_COMPAT_API_KEY = "or-test-key";
    mockFetchOnce({ error: "bad" }, false, 401);
    await expect(openaiCompatLLM(INPUT)).rejects.toThrow(/401/);
  });

  it("falls back to stub on empty content", async () => {
    process.env.OPENAI_COMPAT_API_KEY = "or-test-key";
    mockFetchOnce({ choices: [{ message: { content: "" } }] });
    const reply = await openaiCompatLLM(INPUT);
    expect(reply).toContain("stub reply");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run src/__tests__/openai-compat-llm.test.ts`
Expected: FAIL — `Cannot find module '../services/openai-compat-llm.js'` (file not created yet).

- [ ] **Step 3: Write the adapter**

Create `server/src/services/openai-compat-llm.ts`:

```typescript
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
// available in the response for metering in a later milestone (G3).
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-4o-mini"; // cheap, capable default; override per-tier
const DEFAULT_MAX_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 45_000;

const STUB_REPLY =
  "Got it. (stub reply — set OPENAI_COMPAT_API_KEY to wire an OpenAI-compatible provider)";

/**
 * CoS chat reply adapter backed by any OpenAI-compatible provider.
 *
 * Returns a string for the assistant's next turn. Falls back to a stub when
 * OPENAI_COMPAT_API_KEY is unset so local dev works without a key.
 *
 * Configured entirely by env (read at call time, no restart needed):
 *   - OPENAI_COMPAT_API_KEY    (required to leave stub mode)
 *   - OPENAI_COMPAT_BASE_URL   (default https://openrouter.ai/api/v1)
 *   - OPENAI_COMPAT_MODEL      (default openai/gpt-4o-mini)
 *   - OPENAI_COMPAT_MAX_TOKENS (default 1024)
 */
export async function openaiCompatLLM(input: LLMInput): Promise<string> {
  const key = process.env.OPENAI_COMPAT_API_KEY;
  if (!key) return STUB_REPLY;

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
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const text = (body.choices?.[0]?.message?.content ?? "").trim();
  return text || STUB_REPLY;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && pnpm vitest run src/__tests__/openai-compat-llm.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/openai-compat-llm.ts server/src/__tests__/openai-compat-llm.test.ts
git commit -m "feat(llm): add OpenAI-compatible CoS chat adapter (OpenRouter/Fireworks)"
```

---

## Task 2: Wire `openai_compat` into the dispatch router

**Files:**
- Modify: `server/src/services/dispatch-llm.ts`
- Test: `server/src/__tests__/dispatch-llm.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to `server/src/__tests__/dispatch-llm.test.ts` (inside the existing top-level `describe`, alongside the other adapter routing tests). It stubs global `fetch` so the real provider is never hit:

```typescript
  it("routes through openai_compat when AGENTDASH_DEFAULT_ADAPTER=openai_compat", async () => {
    const prevAdapter = process.env.AGENTDASH_DEFAULT_ADAPTER;
    const prevKey = process.env.OPENAI_COMPAT_API_KEY;
    process.env.AGENTDASH_DEFAULT_ADAPTER = "openai_compat";
    process.env.OPENAI_COMPAT_API_KEY = "or-test-key";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ choices: [{ message: { content: "Routed reply." } }] }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const reply = await dispatchLLM({
      system: "You are a Chief of Staff.",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(reply).toBe("Routed reply.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );

    vi.unstubAllGlobals();
    if (prevAdapter === undefined) delete process.env.AGENTDASH_DEFAULT_ADAPTER;
    else process.env.AGENTDASH_DEFAULT_ADAPTER = prevAdapter;
    if (prevKey === undefined) delete process.env.OPENAI_COMPAT_API_KEY;
    else process.env.OPENAI_COMPAT_API_KEY = prevKey;
  });
```

> If `dispatch-llm.test.ts` does not already import `vi` and `dispatchLLM`, add them to the existing imports: `import { describe, it, expect, vi } from "vitest";` and `import { dispatchLLM } from "../services/dispatch-llm.js";`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pnpm vitest run src/__tests__/dispatch-llm.test.ts`
Expected: FAIL — `dispatchLLM` throws `HttpError 501` ("Adapter \"openai_compat\" is not supported…") because the branch does not exist yet.

- [ ] **Step 3: Add the import**

In `server/src/services/dispatch-llm.ts`, add the import next to the existing `minimaxLLM` import (currently line 4):

```typescript
import { minimaxLLM } from "./minimax-llm.js";
import { openaiCompatLLM } from "./openai-compat-llm.js";
```

- [ ] **Step 4: Add `openai_compat` to the supported list**

In `server/src/services/dispatch-llm.ts`, update `SUPPORTED_COS_CHAT_ADAPTERS` (currently line 27):

```typescript
const SUPPORTED_COS_CHAT_ADAPTERS = ["claude_api", "minimax", "openai_compat", "hermes_local", "claude_local"] as const;
```

- [ ] **Step 5: Add the routing branch**

In `server/src/services/dispatch-llm.ts`, add this block immediately after the closing `}` of the `if (adapter === "minimax") { … }` block (after current line 259, before the `hermes_local` branch):

```typescript
  if (adapter === "openai_compat") {
    // Any OpenAI-compatible provider (OpenRouter, Fireworks, Together, Groq…).
    logger.info({ adapter }, "[dispatch-llm] routing CoS reply through openai_compat");
    try {
      const reply = await openaiCompatLLM(input);
      if (!reply) {
        logger.warn(
          { adapter },
          "[dispatch-llm] openai_compat returned empty reply, using fallback",
        );
        return anthropicLLM(input);
      }
      return reply;
    } catch (err) {
      logger.error(
        { err, adapter },
        "[dispatch-llm] openai_compat failed, falling back to claude_api",
      );
      return anthropicLLM(input);
    }
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd server && pnpm vitest run src/__tests__/dispatch-llm.test.ts`
Expected: PASS — including the new routing test.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/dispatch-llm.ts server/src/__tests__/dispatch-llm.test.ts
git commit -m "feat(llm): route openai_compat adapter in CoS dispatch"
```

---

## Task 3: Document the adapter in LAUNCH.md

**Files:**
- Modify: `doc/LAUNCH.md`

- [ ] **Step 1: Add the adapter row to the dispatch table**

In `doc/LAUNCH.md` §4 ("Pick how the CoS replies"), add a row to the adapter table (after the `minimax` row):

```markdown
| `openai_compat` | Any OpenAI-compatible provider (OpenRouter, Fireworks, Together, Groq) via fetch to `{base}/chat/completions` | `OPENAI_COMPAT_API_KEY=…` (optional: `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_MODEL`, `OPENAI_COMPAT_MAX_TOKENS`) |
```

- [ ] **Step 2: Add the env detail block**

After the MiniMax detail block in §4, add:

```markdown
**OpenAI-compatible (`openai_compat`) details.** Set `AGENTDASH_DEFAULT_ADAPTER=openai_compat` and:

| Var | Value | Default |
|---|---|---|
| `OPENAI_COMPAT_API_KEY` | provider key (OpenRouter `sk-or-…`, Fireworks `fw_…`) | unset → stub reply |
| `OPENAI_COMPAT_BASE_URL` | OpenAI-compatible base URL | `https://openrouter.ai/api/v1` |
| `OPENAI_COMPAT_MODEL` | model id (`openai/gpt-4o-mini`, `accounts/fireworks/models/llama-v3p1-70b-instruct`, …) | `openai/gpt-4o-mini` |
| `OPENAI_COMPAT_MAX_TOKENS` | max output tokens | `1024` |

This is the inference path for the usage-based **Cloud SKU** — OpenRouter/Fireworks return per-request `usage` (OpenRouter returns actual `usage.cost`) for metered billing (see `doc/2026-06-08-deployment-and-inference-skus.md`, G3/G4). On error or empty reply, dispatch falls back to the `claude_api` path.
```

- [ ] **Step 2b: Add the env vars to the TL;DR matrix**

In the `## TL;DR env-var matrix` block at the bottom of `doc/LAUNCH.md`, under the `# LLM (CoS chat dispatch)` section, add:

```sh
# OpenAI-compatible provider (Cloud SKU — usage-based via OpenRouter / Fireworks)
# AGENTDASH_DEFAULT_ADAPTER=openai_compat
# OPENAI_COMPAT_API_KEY=sk-or-…
# OPENAI_COMPAT_BASE_URL=https://openrouter.ai/api/v1
# OPENAI_COMPAT_MODEL=openai/gpt-4o-mini
```

- [ ] **Step 3: Commit**

```bash
git add doc/LAUNCH.md
git commit -m "docs(launch): document openai_compat adapter env vars"
```

---

## Task 4: Full regression verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck all packages**

Run: `pnpm -r typecheck`
Expected: all packages pass.

- [ ] **Step 2: Run the full unit suite**

Run: `pnpm test:run`
Expected: pass; explicitly confirm `openai-compat-llm.test.ts` and `dispatch-llm.test.ts` are green and flag any pre-existing failures by name.

- [ ] **Step 3: Build all packages**

Run: `pnpm build`
Expected: all packages build.

- [ ] **Step 4: Live verification on the Mac mini (NOT localhost)**

> Per project directive, live LLM testing runs on the Mac mini, never via the `claude` CLI on localhost.

On the mini, set `AGENTDASH_DEFAULT_ADAPTER=openai_compat` + `OPENAI_COMPAT_API_KEY` in `/Users/maxiaoer/.config/agentdash/agentdash.env`, `launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent`, then open `/cos` and send "I run a B2B SaaS and want help with content + support." Expected: a real, contextual reply (not the stub string), and an `openai_compat` routing line in `~/.agentdash/logs/launchd.out.log`.

- [ ] **Step 5: Final commit (if any doc tweaks from verification)**

```bash
git add -A
git commit -m "chore(llm): verify openai_compat adapter end-to-end"
```

---

## Self-Review

- **Spec coverage (G1 acceptance):** keyed → real reply (Task 1 test 2 + Task 4 step 4); unkeyed → stub (Task 1 test 1); bad response → fall back to `claude_api` (Task 2 branch + Task 1 test 4); unit/typecheck/build green (Task 4). ✓
- **Placeholder scan:** every code step contains complete code; commands have expected output. ✓
- **Type consistency:** `openaiCompatLLM(input: LLMInput): Promise<string>` matches the `minimaxLLM` signature `dispatchLLM` already consumes; `LLMInput` shape (`system`, `messages[]`) matches `dispatch-llm.ts`. ✓
- **Known smell:** the `if (!reply)` branch mirrors the existing `minimax`/`hermes` shape intentionally (dead-branch cleanup tracked separately). Documented in File Structure note. ✓
