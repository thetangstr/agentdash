// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyWizard } from "./CompanyWizard";

const mockGetAssessment = vi.hoisted(() => vi.fn());
const mockRunAssessment = vi.hoisted(() => vi.fn());

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

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : el instanceof window.HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event(el instanceof window.HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CompanyWizard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockGetAssessment.mockResolvedValue(null);
    mockRunAssessment.mockReset();
    mockRunAssessment.mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("# Starting Point"));
          controller.close();
        },
      }),
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyWizard companyId="company-1" defaultCompanyName="Acme" />
        </QueryClientProvider>,
      );
    });
  }

  it("renders a five-question company-level intake instead of the old four-step scan", async () => {
    render();
    await flushReact();

    expect(container.querySelectorAll("[data-assessment-question]")).toHaveLength(5);
    expect(container.textContent).toContain("Question 1 of 5");
    expect(container.textContent).toContain("Question 5 of 5");
    expect(container.textContent).toContain("Generate starting point");
    expect(container.textContent).not.toContain("Next");
    expect(container.textContent).not.toContain("Assess a specific project");
  });

  it("maps the compact five-question answers onto the assessment payload", async () => {
    render();
    await flushReact();

    await act(async () => {
      setNativeValue(container.querySelector("#company-name") as HTMLInputElement, "Acme");
      setNativeValue(container.querySelector("#company-industry") as HTMLSelectElement, "Healthcare");
      setNativeValue(container.querySelector("#company-description") as HTMLTextAreaElement, "Regional clinic operator");
      setNativeValue(container.querySelector("#business-outcome") as HTMLTextAreaElement, "Sales teams wait too long for compliant proposal answers.");
      setNativeValue(container.querySelector("#current-systems") as HTMLInputElement, "Salesforce, SharePoint");
      setNativeValue(container.querySelector("#first-ai-target") as HTMLTextAreaElement, "Shorten proposal response time by 50%.");
    });

    await act(async () => {
      (Array.from(container.querySelectorAll("button")) as HTMLButtonElement[])
        .find((button) => button.textContent?.includes("Individual AI tools"))!
        .click();
    });
    await act(async () => {
      (Array.from(container.querySelectorAll("button")) as HTMLButtonElement[])
        .find((button) => button.textContent?.includes("Sales"))!
        .click();
    });
    await act(async () => {
      (Array.from(container.querySelectorAll("button")) as HTMLButtonElement[])
        .find((button) => button.textContent?.includes("Generate starting point"))!
        .click();
    });
    await flushReact();

    expect(mockRunAssessment).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        assessmentKind: "initial_company",
        companyName: "Acme",
        industry: "Healthcare",
        industrySlug: "healthcare",
        description: "Regional clinic operator",
        currentSystems: "Salesforce, SharePoint",
        challenges: "Sales teams wait too long for compliant proposal answers.",
        aiUsageLevel: "individual",
        aiGovernance: "informal",
        agentExperience: "none",
        aiOwnership: "nobody",
        selectedFunctions: expect.arrayContaining(["sales"]),
        primaryGoal: "Both",
        targets: "Shorten proposal response time by 50%.",
      }),
      expect.any(AbortSignal),
    );
  });

  it("shows the onboarding handoff action after the short assessment streams", async () => {
    const onContinue = vi.fn();
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyWizard
            companyId="company-1"
            defaultCompanyName="Acme"
            onInitialAssessmentComplete={onContinue}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    await act(async () => {
      setNativeValue(container.querySelector("#company-name") as HTMLInputElement, "Acme");
      setNativeValue(container.querySelector("#company-industry") as HTMLSelectElement, "Healthcare");
      setNativeValue(container.querySelector("#company-description") as HTMLTextAreaElement, "Regional clinic operator");
      setNativeValue(container.querySelector("#business-outcome") as HTMLTextAreaElement, "Sales teams wait too long for compliant proposal answers.");
      setNativeValue(container.querySelector("#first-ai-target") as HTMLTextAreaElement, "Shorten proposal response time by 50%.");
    });
    await act(async () => {
      (Array.from(container.querySelectorAll("button")) as HTMLButtonElement[])
        .find((button) => button.textContent?.includes("Individual AI tools"))!
        .click();
    });
    await act(async () => {
      (Array.from(container.querySelectorAll("button")) as HTMLButtonElement[])
        .find((button) => button.textContent?.includes("Generate starting point"))!
        .click();
    });
    await flushReact();

    const continueButton = (Array.from(container.querySelectorAll("button")) as HTMLButtonElement[])
      .find((button) => button.textContent?.includes("Continue to Chief of Staff"));
    expect(continueButton).toBeTruthy();

    await act(async () => {
      continueButton!.click();
    });
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledWith(
      expect.objectContaining({
        assessmentMarkdown: "# Starting Point",
        assessmentInput: expect.objectContaining({
          assessmentKind: "initial_company",
          companyName: "Acme",
          industry: "Healthcare",
          targets: "Shorten proposal response time by 50%.",
          aiUsageLevel: "individual",
        }),
      }),
    );
  });
});
