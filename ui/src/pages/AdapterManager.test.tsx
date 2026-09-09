// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterManager } from "./AdapterManager";

const listMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/adapters", () => ({
  adaptersApi: {
    list: () => listMock(),
    install: vi.fn(),
    remove: vi.fn(),
    reload: vi.fn(),
    reinstall: vi.fn(),
    setDisabled: vi.fn(),
    setOverridePaused: vi.fn(),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  listMock.mockReset();
});

afterEach(() => {
  container.remove();
});

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    createRoot(container).render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AdapterManager />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flushReact();
}

describe("AdapterManager", () => {
  /**
   * The regression this exists for: every section derives from one adapters
   * query, and the only guard was `isLoading` — which goes false the moment the
   * request fails while `data` stays undefined. The page then claimed "No
   * external adapters installed" and "No built-in adapters found". The second
   * can never legitimately be true, because built-ins ship with the server, so
   * the page was telling an operator something impossible with confidence.
   */
  it("says the list failed rather than claiming nothing is installed", async () => {
    listMock.mockRejectedValue(new Error("adapters service unavailable"));

    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("adapters service unavailable");
    expect(text).toContain("not the same as none being installed");
    expect(text).not.toContain("No external adapters installed");
    expect(text).not.toContain("No built-in adapters found");
  });

  it("still reports a genuinely empty list as empty", async () => {
    listMock.mockResolvedValue([]);

    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("No external adapters installed");
    expect(text).not.toContain("not the same as none being installed");
  });
});
