// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "@agentdash/shared";

const createCompanyMock = vi.fn<(data: { name: string }) => Promise<Company>>();
const navigateMock = vi.fn();

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ createCompany: createCompanyMock }),
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigateMock };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: "company-1",
    name: "Yarda AI",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "YA",
    issueCounter: 0,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date("2026-04-17T00:00:00.000Z"),
    updatedAt: new Date("2026-04-17T00:00:00.000Z"),
    ...overrides,
  } as Company;
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function renderPage(container: HTMLDivElement, Component: () => ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Component />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("WelcomePage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    createCompanyMock.mockReset();
    navigateMock.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("only calls createCompany once when the user fires rapid submit events", async () => {
    // Pending promise simulates an in-flight POST /api/companies — the server
    // hasn't responded yet, so React state updates haven't flushed.
    let resolveCreate: (value: Company) => void = () => {};
    createCompanyMock.mockImplementation(
      () =>
        new Promise<Company>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const { WelcomePage } = await import("../WelcomePage");
    renderPage(container, WelcomePage);
    await act(async () => {
      await flush();
    });

    const input = container.querySelector<HTMLInputElement>('input#company-name');
    expect(input).not.toBeNull();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input!, "Yarda AI");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });

    // Simulate an impatient user: Enter key + two clicks, all before the
    // mutation resolves. Pre-fix: all three reached createCompany. Post-fix:
    // only the first one should.
    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      const button = container.querySelector<HTMLButtonElement>(
        'button:not([disabled])',
      );
      button?.click();
      button?.click();
      await flush();
    });

    expect(createCompanyMock).toHaveBeenCalledTimes(1);

    // Resolve the in-flight request and make sure we still only have one call.
    await act(async () => {
      resolveCreate(makeCompany());
      await flush();
    });

    expect(createCompanyMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith("/YA/setup-wizard");
  });

  it("allows retry after an error", async () => {
    createCompanyMock.mockRejectedValueOnce(new Error("boom"));

    const { WelcomePage } = await import("../WelcomePage");
    renderPage(container, WelcomePage);
    await act(async () => {
      await flush();
    });

    const input = container.querySelector<HTMLInputElement>('input#company-name')!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;

    await act(async () => {
      setter.call(input, "Yarda AI");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await flush();
    });

    await act(async () => {
      const button = container.querySelector<HTMLButtonElement>(
        'button:not([disabled])',
      );
      button?.click();
      await flush();
    });

    expect(createCompanyMock).toHaveBeenCalledTimes(1);

    // Second click after error should be allowed.
    createCompanyMock.mockResolvedValueOnce(makeCompany());

    await act(async () => {
      const button = container.querySelector<HTMLButtonElement>(
        'button:not([disabled])',
      );
      button?.click();
      await flush();
    });

    expect(createCompanyMock).toHaveBeenCalledTimes(2);
  });
});
