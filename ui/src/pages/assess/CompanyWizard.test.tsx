// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyWizard } from "./CompanyWizard";

const mockRunAssessment = vi.hoisted(() => vi.fn());
const mockGetAssessment = vi.hoisted(() => vi.fn());

vi.mock("../../api/assess", () => ({
  assessApi: {
    getAssessment: (...args: unknown[]) => mockGetAssessment(...args),
    runAssessment: (...args: unknown[]) => mockRunAssessment(...args),
  },
}));

vi.mock("../../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function streamText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function setNativeSelectValue(el: HTMLSelectElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value");
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button as HTMLButtonElement;
}

describe("CompanyWizard onboarding deep interview", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockGetAssessment.mockResolvedValue(null);
    mockRunAssessment.mockReset();
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    document.body.removeChild(container);
    document.body.innerHTML = "";
  });

  async function render() {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyWizard
            companyId="company-1"
            defaultCompanyName="Acme"
            onReadyToFinalize={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  async function completeRequiredSteps() {
    const website = Array.from(container.querySelectorAll("input")).find((input) =>
      input.placeholder.includes("example.com"),
    ) as HTMLInputElement | undefined;
    if (!website) throw new Error("Website input not found");

    await act(async () => {
      setNativeValue(website, "https://acme.example");
      setNativeSelectValue(container.querySelector("select")!, "Tech/SaaS");
    });
    await flushReact();

    await act(async () => {
      buttonByText(container, "Next").click();
    });
    await flushReact();

    await act(async () => {
      buttonByText(container, "Basic automation").click();
    });
    await flushReact();

    await act(async () => {
      buttonByText(container, "Next").click();
    });
    await flushReact();

    await act(async () => {
      buttonByText(container, "Next").click();
    });
    await flushReact();
  }

  it("lets onboarding users answer deep-interview follow-up questions", async () => {
    mockRunAssessment
      .mockResolvedValueOnce(streamText("What's your primary goal for this rollout?"))
      .mockResolvedValueOnce(streamText("What constraints matter most to you?"));

    await render();
    await completeRequiredSteps();

    await act(async () => {
      buttonByText(container, "Generate assessment").click();
    });
    await flushReact();

    expect(container.textContent).toContain("What's your primary goal");
    const followUpForm = container.querySelector('[data-testid="company-assess-followup"]');
    expect(followUpForm).not.toBeNull();

    const answer = followUpForm!.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(answer, "Launch onboarding automation for three pilot customers.");
    });
    await flushReact();

    await act(async () => {
      buttonByText(container, "Send answer").click();
    });
    await flushReact();

    expect(mockRunAssessment).toHaveBeenCalledTimes(2);
    expect(mockRunAssessment.mock.calls[1][1]).toMatchObject({
      userAnswer: "Launch onboarding automation for three pilot customers.",
    });
    expect(container.textContent).toContain("What constraints matter most");
  });
});
