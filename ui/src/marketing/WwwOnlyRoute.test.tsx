// @vitest-environment jsdom
// AgentDash: www-only front-door pages (/start*, /find) call /api/cloud, which
// exists only on www. A hosted box sends them, and its signed-out root, to its
// own sign-in. www renders them immediately and never waits on /api/health,
// which on www is proxied elsewhere and may be slow, gone (410) or not JSON.
// The real healthApi runs here against a stubbed fetch.

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.hoisted(() => vi.fn());

vi.mock("../api/auth", () => ({ authApi: { getSession: () => mockGetSession() } }));
vi.mock("@/lib/router", () => ({
  Navigate: ({ to }: { to: string }) => <div>Navigate:{to}</div>,
  useSearchParams: () => [new URLSearchParams(""), vi.fn()],
}));
vi.mock("@/marketing/video/HeroStoryPlayer", () => ({ default: () => <div>player</div> }));
vi.mock("@/marketing/hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => false }));

import { BOX_SIGN_IN_PATH, WwwOnlyRoute } from "./WwwOnlyRoute";
import { Landing } from "./pages/Landing";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => window.setTimeout(r, 0));
  });
}

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockGetSession.mockResolvedValue(null);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  vi.clearAllMocks();
});

async function render(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
  });
  await flush();
  await flush();
}

const findPage = <WwwOnlyRoute><div>Find your workspace</div></WwwOnlyRoute>;

describe("WwwOnlyRoute", () => {
  it("sends a hosted box to its own sign-in instead of rendering a www-only page", async () => {
    fetchMock.mockResolvedValue(json({ status: "ok", deploymentMode: "authenticated", hostedBox: true }));
    await render(findPage);
    expect(container.textContent).toBe(`Navigate:${BOX_SIGN_IN_PATH}`);
    expect(BOX_SIGN_IN_PATH).toBe("/auth?next=%2F");
  });

  it("renders the www page at once while health is still loading (never blank)", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await render(findPage);
    expect(container.textContent).toBe("Find your workspace");
  });

  it("renders the page on www (health without hostedBox)", async () => {
    fetchMock.mockResolvedValue(json({ status: "ok", deploymentMode: "authenticated" }));
    await render(findPage);
    expect(container.textContent).toBe("Find your workspace");
  });

  it("renders the page when health answers 410", async () => {
    fetchMock.mockResolvedValue(json({ error: "gone" }, 410));
    await render(findPage);
    expect(container.textContent).toBe("Find your workspace");
  });

  it("renders the page when the health request rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await render(findPage);
    expect(container.textContent).toBe("Find your workspace");
  });

  it("renders the page when health is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<!doctype html><html></html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    await render(findPage);
    expect(container.textContent).toBe("Find your workspace");
  });
});

describe("Landing", () => {
  it("on a hosted box, sends a signed-out visitor to the box's sign-in, not the marketing page", async () => {
    fetchMock.mockResolvedValue(json({ status: "ok", deploymentMode: "authenticated", hostedBox: true }));
    await render(<Landing />);
    expect(container.textContent).toBe(`Navigate:${BOX_SIGN_IN_PATH}`);
  });

  it("on a hosted box, still sends a signed-in user to the app", async () => {
    fetchMock.mockResolvedValue(json({ status: "ok", deploymentMode: "authenticated", hostedBox: true }));
    mockGetSession.mockResolvedValue({ session: { id: "s" }, user: { id: "u" } });
    await render(<Landing />);
    expect(container.textContent).toBe("Navigate:/companies");
  });

  it("renders the www landing when health answers 410, instead of redirecting to /companies", async () => {
    fetchMock.mockResolvedValue(json({ error: "gone" }, 410));
    await render(<Landing />);
    expect(container.textContent).not.toContain("Navigate:");
    expect(container.querySelector(".mkt-root")).not.toBeNull();
  });

  it("renders the www landing when the health request rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await render(<Landing />);
    expect(container.textContent).not.toContain("Navigate:");
    expect(container.querySelector(".mkt-root")).not.toBeNull();
  });
});
