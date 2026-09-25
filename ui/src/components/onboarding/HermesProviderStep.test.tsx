// @vitest-environment jsdom
// AgentDash (#725): the Hermes provider step of hosted onboarding.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";

const mockSetup = vi.hoisted(() => vi.fn());
vi.mock("@/api/onboarding", () => ({
  onboardingApi: { setupHermesProvider: mockSetup },
}));

import { HermesProviderStep } from "./HermesProviderStep";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = [
  { provider: "zai" as const, label: "Z.AI (GLM)", defaultModel: "glm-5.3-flash", keyHint: "API key from z.ai" },
  { provider: "openrouter" as const, label: "OpenRouter", defaultModel: "z-ai/glm-5.2", keyHint: "sk-or-…" },
  { provider: "anthropic" as const, label: "Anthropic", defaultModel: "claude-sonnet-5", keyHint: "sk-ant-…" },
  { provider: "openai" as const, label: "OpenAI", defaultModel: "gpt-5.4-mini", keyHint: "sk-…" },
];

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("HermesProviderStep", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockSetup.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<Parameters<typeof HermesProviderStep>[0]> = {}) {
    const onConfigured = vi.fn();
    act(() => {
      root.render(
        <HermesProviderStep
          companyId="company-1"
          options={OPTIONS}
          canConfigure
          onConfigured={onConfigured}
          {...props}
        />,
      );
    });
    return { onConfigured };
  }

  const keyInput = () => container.querySelector<HTMLInputElement>('input[type="password"]')!;
  const modelInput = () => container.querySelector<HTMLInputElement>('input[type="text"]')!;
  const form = () => container.querySelector("form")!;

  it("shows the four providers and a masked key field", () => {
    render();
    const labels = [...container.querySelectorAll("label")].map((label) => label.textContent);
    for (const option of OPTIONS) expect(labels).toContain(option.label);
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(4);
    expect(keyInput().autocomplete).toBe("off");
    expect(modelInput().placeholder).toBe("glm-5.3-flash");
  });

  it("saves the chosen provider, key and model, then clears the key", async () => {
    mockSetup.mockResolvedValue({
      hermesProvider: { configured: true, provider: "anthropic", label: "Anthropic", model: "claude-sonnet-5" },
      profilesUpdated: 0,
    });
    const { onConfigured } = render();
    act(() => {
      container.querySelector<HTMLInputElement>('input[value="anthropic"]')!.click();
    });
    expect(modelInput().placeholder).toBe("claude-sonnet-5");
    act(() => setInput(keyInput(), "  sk-ant-secret  "));
    await act(async () => {
      form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mockSetup).toHaveBeenCalledWith({ companyId: "company-1", provider: "anthropic", apiKey: "sk-ant-secret" });
    expect(onConfigured).toHaveBeenCalledTimes(1);
    expect(keyInput().value).toBe("");
  });

  it("shows the server's sentence when the key is rejected, and keeps the form", async () => {
    mockSetup.mockRejectedValue(
      new ApiError("Z.AI (GLM) rejected this API key (HTTP 401). Check the key and try again.", 422, {
        details: { code: "provider_key_rejected" },
      }),
    );
    const { onConfigured } = render();
    act(() => setInput(keyInput(), "wrong-key"));
    act(() => setInput(modelInput(), "glm-5.3"));
    await act(async () => {
      form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mockSetup).toHaveBeenCalledWith({ companyId: "company-1", provider: "zai", apiKey: "wrong-key", model: "glm-5.3" });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Z.AI (GLM) rejected this API key (HTTP 401). Check the key and try again.",
    );
    expect(onConfigured).not.toHaveBeenCalled();
  });

  it("tells a teammate who is not the admin to wait, with no form", () => {
    render({ canConfigure: false });
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("Waiting for a model provider");
  });
});
