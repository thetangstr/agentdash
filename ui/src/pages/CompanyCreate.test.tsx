// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyCreatePage } from "./CompanyCreate";
import { ApiError } from "../api/client";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("@/api/companies", () => ({
  companiesApi: {
    create: (...args: unknown[]) => mockCreate(...args),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CompanyCreatePage", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockNavigate.mockReset();
    mockCreate.mockReset();
    mockSetSelectedCompanyId.mockReset();
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  function render() {
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyCreatePage />
        </QueryClientProvider>,
      );
    });
    return root;
  }

  it("renders the workspace name form", () => {
    render();
    const heading = container.querySelector("h1");
    expect(heading?.textContent).toContain("Name your workspace");
    const input = container.querySelector("input#company-name") as HTMLInputElement | null;
    expect(input).not.toBeNull();
  });

  function setNativeValue(el: HTMLInputElement, value: string) {
    const desc = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    );
    desc?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("submits to companiesApi.create with fromSignup and navigates to /assess?onboarding=1", async () => {
    mockCreate.mockResolvedValue({ id: "company-1", name: "Acme" });

    render();
    const input = container.querySelector("input#company-name") as HTMLInputElement;
    const button = container.querySelector("button[type='submit']") as HTMLButtonElement;

    await act(async () => {
      setNativeValue(input, "Acme");
    });
    await flushReact();

    await act(async () => {
      button.click();
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(mockCreate).toHaveBeenCalledWith({ name: "Acme" }, { fromSignup: true });
    expect(mockSetSelectedCompanyId).toHaveBeenCalledWith("company-1");
    expect(mockNavigate).toHaveBeenCalledWith("/assess?onboarding=1", { replace: true });
  });

  it("redirects to /cos when the server returns 409 already_member (invite-flow safety)", async () => {
    mockCreate.mockRejectedValue(
      new ApiError("already_member", 409, { code: "already_member" }),
    );

    render();
    const input = container.querySelector("input#company-name") as HTMLInputElement;
    const button = container.querySelector("button[type='submit']") as HTMLButtonElement;

    await act(async () => {
      setNativeValue(input, "Acme");
    });
    await flushReact();
    await act(async () => {
      button.click();
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(mockNavigate).toHaveBeenCalledWith("/cos", { replace: true });
  });

  it("disables submit when the workspace name is empty", () => {
    render();
    const button = container.querySelector("button[type='submit']") as HTMLButtonElement;
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });
});
