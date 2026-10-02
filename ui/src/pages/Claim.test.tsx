// @vitest-environment jsdom
// AgentDash (#767): the /claim page — fragment parsing, errors, redirect to /cos.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthApiError } from "../api/auth";
import { CLAIM_SIGN_IN_PATH, ClaimPage, claimErrorMessage, readClaimCodeFromHash, readClaimEmailFromHash } from "./Claim";

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

describe("readClaimEmailFromHash (#836)", () => {
  it("reads email= from the fragment beside the code", () => {
    expect(readClaimEmailFromHash(`#code=${CODE}&email=founder%40example.com`)).toBe("founder@example.com");
    expect(readClaimCodeFromHash(`#code=${CODE}&email=founder%40example.com`)).toBe(CODE);
    expect(readClaimEmailFromHash(`#code=${CODE}`)).toBeNull();
    expect(readClaimEmailFromHash(`#${CODE}`)).toBeNull();
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

  function render(qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) {
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

  it("takes the email from the fragment when the link carries it there (#836), and clears it from the URL", async () => {
    search.value = "";
    window.history.replaceState(null, "", `/claim#code=${CODE}&email=fragment%40example.com`);
    mockSignUp.mockResolvedValue(undefined);
    mockGetSession.mockResolvedValue({ session: { id: "s" }, user: { id: "u" } });
    render();
    await flush();
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");
    expect(q<HTMLInputElement>("#claim-email").value).toBe("fragment@example.com");
    fill();
    await submit();
    expect(mockSignUp).toHaveBeenCalledWith({ name: "Founder", email: "fragment@example.com", password: "correct-horse-battery", inviteCode: CODE });
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

  // AgentDash: first live canary claim. The founder's board access and health
  // were cached from before the claim; the gate must not judge on them.
  it("refetches the cached board access and health before landing on /cos", async () => {
    mockSignUp.mockResolvedValue(undefined);
    mockGetSession.mockResolvedValue({ session: { id: "s" }, user: { id: "u" } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const boardAccess = vi.fn()
      .mockResolvedValueOnce({ companyIds: [], isInstanceAdmin: false })
      .mockResolvedValue({ companyIds: ["c1"], isInstanceAdmin: true });
    const health = vi.fn()
      .mockResolvedValueOnce({ status: "ok", instanceHasCompany: false })
      .mockResolvedValue({ status: "ok", instanceHasCompany: true });
    await qc.prefetchQuery({ queryKey: ["access", "current-board-access"], queryFn: boardAccess });
    await qc.prefetchQuery({ queryKey: ["health"], queryFn: health });
    let fetchesAtNavigate = -1;
    mockNavigate.mockImplementation(() => {
      fetchesAtNavigate = boardAccess.mock.calls.length + health.mock.calls.length;
    });
    render(qc);
    fill();
    await submit();
    expect(mockNavigate).toHaveBeenCalledWith("/cos", { replace: true });
    // Both were refetched (inactive queries too) before navigating.
    expect(fetchesAtNavigate).toBe(4);
    expect(qc.getQueryData(["access", "current-board-access"])).toEqual({ companyIds: ["c1"], isInstanceAdmin: true });
  });

  it("sends Already claimed it? to the box's own sign-in, not www's /find", async () => {
    render();
    const link = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "Sign in");
    expect(link?.getAttribute("href")).toBe(CLAIM_SIGN_IN_PATH);
    expect(CLAIM_SIGN_IN_PATH).toBe("/auth?next=%2F");
    expect(link?.getAttribute("href")).not.toContain("/find");
  });
});
