// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectWizard } from "./ProjectWizard";

const mockGenerateProjectClarify = vi.hoisted(() => vi.fn());
const mockGenerateProjectFollowUp = vi.hoisted(() => vi.fn());
const mockRunProjectAssessment = vi.hoisted(() => vi.fn());
const mockDownloadProjectDocx = vi.hoisted(() => vi.fn());

vi.mock("../../api/assess", () => ({
  assessApi: {
    generateProjectClarify: (...args: unknown[]) => mockGenerateProjectClarify(...args),
    generateProjectFollowUp: (...args: unknown[]) => mockGenerateProjectFollowUp(...args),
    runProjectAssessment: (...args: unknown[]) => mockRunProjectAssessment(...args),
    downloadProjectDocx: (...args: unknown[]) => mockDownloadProjectDocx(...args),
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

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button as HTMLButtonElement;
}

describe("ProjectWizard adaptive assessment", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockGenerateProjectClarify.mockReset();
    mockGenerateProjectFollowUp.mockReset();
    mockRunProjectAssessment.mockReset();
    mockDownloadProjectDocx.mockReset();
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
          <ProjectWizard companyId="company-1" companyName="Acme" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("allows generation after all returned project questions are answered", async () => {
    mockGenerateProjectClarify.mockResolvedValue({
      rephrased: "Clean up SharePoint and establish a source of truth.",
      questions: [
        {
          id: "q1",
          question: "What's your primary goal for this rollout?",
          hint: "",
          options: [],
        },
      ],
    });
    mockRunProjectAssessment.mockResolvedValue(streamText("# Project assessment\n\nRecommended next step."));

    await render();

    await act(async () => {
      buttonByText(container, "Continue to refine").click();
    });
    await flushReact();

    const answer = container.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(answer).not.toBeNull();
    await act(async () => {
      setNativeValue(answer!, "Reduce founder time and identify stale SharePoint documents.");
    });
    await flushReact();

    await act(async () => {
      buttonByText(container, "Review answers").click();
    });
    await flushReact();

    const generateButton = buttonByText(container, "Generate project assessment");
    expect(generateButton.disabled).toBe(false);

    await act(async () => {
      generateButton.click();
    });
    await flushReact();

    expect(mockRunProjectAssessment).toHaveBeenCalledWith(
      "company-1",
      {
        intake: expect.objectContaining({
          projectName: "SharePoint cleanup project",
        }),
        answers: [
          {
            questionId: "q1",
            text: "Reduce founder time and identify stale SharePoint documents.",
          },
        ],
        rephrased: "Clean up SharePoint and establish a source of truth.",
      },
      expect.any(AbortSignal),
    );
  });
});
