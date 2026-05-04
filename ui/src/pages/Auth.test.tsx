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

  function setNativeValue(el: HTMLInputElement, value: string) {
    const desc = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    );
    desc?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("navigates to /company-create after a successful sign-up", async () => {
    mockSignUp.mockResolvedValue(undefined);

    render();
    // Wait for the session-loading branch to finish so the form mounts.
    await flushReact();
    await flushReact();
    await flushReact();

    const nameInput = container.querySelector("input#name") as HTMLInputElement | null;
    const emailInput = container.querySelector("input#email") as HTMLInputElement;
    const passwordInput = container.querySelector("input#password") as HTMLInputElement;
    const button = container.querySelector("button[type='submit']") as HTMLButtonElement;

    expect(nameInput, "name input must be rendered in sign_up mode").not.toBeNull();

    await act(async () => {
      setNativeValue(nameInput!, "Alice");
      setNativeValue(emailInput, "alice@acme.com");
      setNativeValue(passwordInput, "supersecret");
    });
    await flushReact();

    await act(async () => {
      button.click();
    });
    await flushReact();
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
