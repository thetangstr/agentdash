// @vitest-environment jsdom
// AgentDash (#767): the /claim page — fragment parsing, errors, redirect to /cos.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiError } from "../api/auth";
import { ClaimPage, claimErrorMessage, readClaimCodeFromHash } from "./Claim";

const mockNavigate = vi.hoisted(() => vi.fn());
const mockSignUp = vi.hoisted(() => vi.fn());
const mockSignIn = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());
const search = vi.hoisted(() => ({ value: "?email=founder%40example.com" }));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams(search.value), vi.fn()],
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("../api/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/auth")>();
  return {
    ...actual,
    authApi: {
      getSession: () => mockGetSession(),
      signUpEmail: (...args: unknown[]) => mockSignUp(...args),
      signInEmail: (...args: unknown[]) => mockSignIn(...args),
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CODE = "AGD-0123456789ABCDEF0123456789";

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => window.setTimeout(r, 0));
  });
}

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("readClaimCodeFromHash", () => {
  it("reads code= from the fragment and tolerates a bare code", () => {
    expect(readClaimCodeFromHash(`#code=${CODE}`)).toBe(CODE);
    expect(readClaimCodeFromHash(`#${CODE}`)).toBe(CODE);
    expect(readClaimCodeFromHash("#code=")).toBeNull();
    expect(readClaimCodeFromHash("")).toBeNull();
    expect(readClaimCodeFromHash("#other=1")).toBeNull();
  });
});

describe("claimErrorMessage", () => {
  it("names a used code, a wrong email and an invalid code clearly", () => {
    expect(claimErrorMessage(new AuthApiError("x", 409, null, "claim_code_used"))).toMatch(/already been used/);
    expect(claimErrorMessage(new AuthApiError("x", 403, null, "claim_email_mismatch"))).toMatch(/different email/);
    expect(claimErrorMessage(new AuthApiError("x", 403, null, "invite_code_required"))).toMatch(/not valid/);
  });
});

describe("ClaimPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockNavigate.mockReset();
    mockSignUp.mockReset();
    mockSignIn.mockReset();
    mockGetSession.mockReset();
    search.value = "?email=founder%40example.com";
    window.history.replaceState(null, "", `/claim${search.value}#code=${CODE}`);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    act(() => root.render(<QueryClientProvider client={qc}><ClaimPage /></QueryClientProvider>));
  }

  const q = <T extends Element>(sel: string) => container.querySelector(sel) as T;

  function fill(password = "correct-horse-battery", repeat = password) {
    setInput(q<HTMLInputElement>("#claim-name"), "Founder");
    setInput(q<HTMLInputElement>("#claim-password"), password);
    setInput(q<HTMLInputElement>("#claim-repeat"), repeat);
  }

  async function submit() {
    await act(async () => {
      q<HTMLFormElement>("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
  }

  it("reads the code from the fragment, removes it from the URL, and shows the email read-only", async () => {
    render();
    await flush();
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?email=founder%40example.com");
    const email = q<HTMLInputElement>("#claim-email");
    expect(email.value).toBe("founder@example.com");
    expect(email.readOnly).toBe(true);
  });

  it("claims with the code and email, then lands on /cos", async () => {
    mockSignUp.mockResolvedValue(undefined);
    mockGetSession.mockResolvedValue({ session: { id: "s" }, user: { id: "u" } });
    render();
    fill();
    await submit();
    expect(mockSignUp).toHaveBeenCalledWith({ name: "Founder", email: "founder@example.com", password: "correct-horse-battery", inviteCode: CODE });
    expect(mockSignIn).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/cos", { replace: true });
  });

  it("signs in explicitly when sign-up did not start a session", async () => {
    mockSignUp.mockResolvedValue(undefined);
    mockGetSession.mockResolvedValue(null);
    mockSignIn.mockResolvedValue(undefined);
    render();
    fill();
    await submit();
    expect(mockSignIn).toHaveBeenCalledWith({ email: "founder@example.com", password: "correct-horse-battery" });
    expect(mockNavigate).toHaveBeenCalledWith("/cos", { replace: true });
  });

  it("refuses a weak or mismatched password before calling the server", async () => {
    render();
    fill("short-pass", "short-pass");
    expect(container.textContent).toMatch(/at least 12 characters/);
    await submit();
    expect(mockSignUp).not.toHaveBeenCalled();
    fill("correct-horse-battery", "correct-horse-batterx");
    expect(container.textContent).toMatch(/do not match/);
    expect(q<HTMLButtonElement>("button[type=submit]").disabled).toBe(true);
  });

  it("shows a clear error for a used code and does not navigate", async () => {
    mockSignUp.mockRejectedValue(new AuthApiError("used", 409, null, "claim_code_used"));
    render();
    fill();
    await submit();
    expect(container.textContent).toMatch(/already been used/);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("explains an incomplete link (no code in the fragment)", async () => {
    window.history.replaceState(null, "", `/claim${search.value}`);
    render();
    expect(container.textContent).toMatch(/incomplete/);
    expect(container.querySelector("form")).toBeNull();
  });
});
