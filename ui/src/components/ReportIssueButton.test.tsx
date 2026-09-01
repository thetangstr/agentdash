// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportIssueButton } from "./ReportIssueButton";

const mockIssueReportsApi = vi.hoisted(() => ({
  getConfig: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../api/issueReports", () => ({
  issueReportsApi: mockIssueReportsApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/MKT/issues/MKT-13" }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function findByText<T extends Element>(selector: string, text: string): T | undefined {
  return Array.from(document.querySelectorAll<T>(selector)).find((el) =>
    el.textContent?.includes(text),
  );
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  // React tracks the last value it wrote; go through the native setter or the
  // change event is swallowed as a no-op.
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ReportIssueButton", () => {
  let container: HTMLDivElement;

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ReportIssueButton />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockIssueReportsApi.getConfig.mockResolvedValue({
      enabled: true,
      repo: "thetangstr/agentdash",
    });
    mockIssueReportsApi.create.mockResolvedValue({
      number: 512,
      url: "https://github.com/thetangstr/agentdash/issues/512",
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders nothing when the instance has no GitHub credential", async () => {
    // A button that can only fail is worse than no button.
    mockIssueReportsApi.getConfig.mockResolvedValue({ enabled: false, repo: null });
    await render();
    expect(container.textContent).toBe("");
  });

  it("renders nothing when the config call fails outright", async () => {
    mockIssueReportsApi.getConfig.mockRejectedValue(new Error("nope"));
    await render();
    expect(container.textContent).toBe("");
  });

  it("files a report and shows where it landed", async () => {
    await render();

    const trigger = findByText<HTMLButtonElement>("button", "Report an issue");
    expect(trigger).toBeDefined();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // The dialog names the destination, so nobody files blind.
    expect(document.body.textContent).toContain("thetangstr/agentdash");

    const titleInput = document.querySelector<HTMLInputElement>("#issue-report-title");
    const descriptionInput = document.querySelector<HTMLTextAreaElement>("#issue-report-description");
    expect(titleInput).not.toBeNull();
    expect(descriptionInput).not.toBeNull();

    const submit = findByText<HTMLButtonElement>("button", "File it");
    expect(submit?.disabled).toBe(true);

    await act(async () => {
      setValue(titleInput!, "Cards drop on the wrong column");
      setValue(descriptionInput!, "Dragging a card from Todo lands it in Done.");
    });
    await flushReact();

    const readySubmit = findByText<HTMLButtonElement>("button", "File it");
    expect(readySubmit?.disabled).toBe(false);

    await act(async () => {
      readySubmit?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockIssueReportsApi.create).toHaveBeenCalledWith({
      kind: "bug",
      title: "Cards drop on the wrong column",
      description: "Dragging a card from Todo lands it in Done.",
      companyId: "company-1",
      pageUrl: "/MKT/issues/MKT-13",
    });

    expect(document.body.textContent).toContain("#512");
    const link = Array.from(document.querySelectorAll("a")).find((a) =>
      a.getAttribute("href")?.includes("/issues/512"),
    );
    expect(link).toBeDefined();
  });

  it("files a feature request under the feature kind", async () => {
    await render();

    await act(async () => {
      findByText<HTMLButtonElement>("button", "Report an issue")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flushReact();

    await act(async () => {
      findByText<HTMLButtonElement>("button", "Feature request")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flushReact();

    await act(async () => {
      setValue(document.querySelector<HTMLInputElement>("#issue-report-title")!, "Filter by agent");
      setValue(
        document.querySelector<HTMLTextAreaElement>("#issue-report-description")!,
        "I want to filter the board down to one assignee.",
      );
    });
    await flushReact();

    await act(async () => {
      findByText<HTMLButtonElement>("button", "File it")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flushReact();
    await flushReact();

    expect(mockIssueReportsApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "feature" }),
    );
  });

  it("surfaces a failure instead of pretending it filed", async () => {
    mockIssueReportsApi.create.mockRejectedValue(new Error("GitHub said no"));
    await render();

    await act(async () => {
      findByText<HTMLButtonElement>("button", "Report an issue")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flushReact();

    await act(async () => {
      setValue(document.querySelector<HTMLInputElement>("#issue-report-title")!, "Broken thing");
      setValue(
        document.querySelector<HTMLTextAreaElement>("#issue-report-description")!,
        "It broke and stayed broken.",
      );
    });
    await flushReact();

    await act(async () => {
      findByText<HTMLButtonElement>("button", "File it")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await flushReact();
    await flushReact();

    expect(document.body.textContent).toContain("GitHub said no");
    expect(document.body.textContent).not.toContain("that's filed");
  });
});
