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
