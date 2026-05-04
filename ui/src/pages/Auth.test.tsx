// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthPage } from "./Auth";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSignUp = vi.hoisted(() => vi.fn());
const mockSignIn = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() =>
  vi.fn().mockRejectedValue(new Error("no session")),
);

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams("?mode=sign_up"), vi.fn()],
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("@/api/auth", () => ({
  authApi: {
    getSession: () => mockGetSession(),
    signUpEmail: (...args: unknown[]) => mockSignUp(...args),
    signInEmail: (...args: unknown[]) => mockSignIn(...args),
  },
}));

vi.mock("@/marketing/sections/LiveBriefing", () => ({
  LiveBriefing: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("AuthPage post-signup redirect (Phase E)", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockNavigate.mockReset();
    mockSignUp.mockReset();
    mockSignIn.mockReset();
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  function render() {
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AuthPage />
        </QueryClientProvider>,
      );
    });
    return root;
  }

  it("navigates to /company-create after a successful sign-up", async () => {
    mockSignUp.mockResolvedValue(undefined);

    render();
    await flushReact();

    const inputs = container.querySelectorAll("input");
    const nameInput = inputs[0] as HTMLInputElement;
    const emailInput = inputs[1] as HTMLInputElement;
    const passwordInput = inputs[2] as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    await act(async () => {
      nameInput.value = "Alice";
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      emailInput.value = "alice@acme.com";
      emailInput.dispatchEvent(new Event("input", { bubbles: true }));
      passwordInput.value = "supersecret";
      passwordInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockSignUp).toHaveBeenCalledWith({
      name: "Alice",
      email: "alice@acme.com",
      password: "supersecret",
    });
    expect(mockNavigate).toHaveBeenCalledWith("/company-create", { replace: true });
  });
});
