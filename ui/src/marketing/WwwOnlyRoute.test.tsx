// @vitest-environment jsdom
// AgentDash: www-only front-door pages (/start*, /find) call /api/cloud, which
// exists only on www. A hosted box sends them, and its signed-out root, to its
// own sign-in. Whether a page is www is decided by hostname (marketing-host.ts),
// never by health: www's /api/health is rewritten to the legacy Railway install
// and answers 200 with an install's health (PR #955 review).
// The real healthApi runs here against a stubbed fetch.

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.hoisted(() => vi.fn());
const host = vi.hoisted(() => ({ value: "localhost" }));

vi.mock("../api/auth", () => ({ authApi: { getSession: () => mockGetSession() } }));
vi.mock("@/lib/router", () => ({
  Navigate: ({ to }: { to: string }) => <div>Navigate:{to}</div>,
  useSearchParams: () => [new URLSearchParams(""), vi.fn()],
}));
vi.mock("@/marketing/video/HeroStoryPlayer", () => ({ default: () => <div>player</div> }));
vi.mock("@/marketing/hooks/usePrefersReducedMotion", () => ({ usePrefersReducedMotion: () => false }));
// jsdom cannot change window.location.hostname, so the page's host is set
// here; the hostname rule itself is the real one.
vi.mock("./marketing-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./marketing-host")>();
  return { ...actual, isMarketingHost: () => actual.isMarketingHostname(host.value) };
});

import { BOX_SIGN_IN_PATH, WwwOnlyRoute } from "./WwwOnlyRoute";
import { Landing } from "./pages/Landing";
import { isMarketingHostname } from "./marketing-host";

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
  host.value = "localhost";
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

// What www.agentdash.cloud's /api/health really answers: Vercel rewrites it to
// the legacy Railway install, so it is a 200 with an install's health.
const WWW_HEALTH = { status: "ok", deploymentMode: "authenticated", hostedBox: false };
const BOX_HEALTH = { status: "ok", deploymentMode: "authenticated", hostedBox: true };
const SELF_HOSTED_HEALTH = { status: "ok", deploymentMode: "authenticated", hostedBox: false };

describe("isMarketingHostname", () => {
  it("is www, the apex and this project's Vercel previews, and nothing else", () => {
    expect(isMarketingHostname("www.agentdash.cloud")).toBe(true);
    expect(isMarketingHostname("agentdash.cloud")).toBe(true);
    expect(isMarketingHostname("WWW.AgentDash.cloud.")).toBe(true);
    expect(isMarketingHostname("agentdash-git-main-thetangstr.vercel.app")).toBe(true);
    expect(isMarketingHostname("acme.agentdash.cloud")).toBe(false);
    expect(isMarketingHostname("localhost")).toBe(false);
    expect(isMarketingHostname("agentdash.example.com")).toBe(false);
  });
});

describe("WwwOnlyRoute", () => {
  it("on a box host, sends a hosted box to its own sign-in instead of rendering a www-only page", async () => {
    host.value = "acme.agentdash.cloud";
    fetchMock.mockResolvedValue(json(BOX_HEALTH));
    await render(findPage);
    expect(container.textContent).toBe(`Navigate:${BOX_SIGN_IN_PATH}`);
    expect(BOX_SIGN_IN_PATH).toBe("/auth?next=%2F");
  });

  it("on www, renders the page although health is a 200 from an install, and never asks health", async () => {
    host.value = "www.agentdash.cloud";
    fetchMock.mockResolvedValue(json(WWW_HEALTH));
    await render(findPage);
    expect(container.textContent).toBe("Find your workspace");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on www, renders the page even if health were to say hostedBox", async () => {
    host.value = "www.agentdash.cloud";
    fetchMock.mockResolvedValue(json(BOX_HEALTH));
    await render(findPage);
    expect(container.textContent).toBe("Find your workspace");
  });

  it("on another host, renders the page at once while health is still loading (never blank)", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await render(findPage);
    expect(container.textContent).toBe("Find your workspace");
  });

  it("on another host, renders the page when health has no hostedBox", async () => {
    fetchMock.mockResolvedValue(json(SELF_HOSTED_HEALTH));
    await render(findPage);
    expect(container.textContent).toBe("Find your workspace");
  });

  it("on another host, renders the page when health answers 410", async () => {
    fetchMock.mockResolvedValue(json({ error: "gone" }, 410));
    await render(findPage);
    expect(container.textContent).toBe("Find your workspace");
  });

  it("on another host, renders the page when the health request rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await render(findPage);
    expect(container.textContent).toBe("Find your workspace");
  });

  it("on another host, renders the page when health is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<!doctype html><html></html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    await render(findPage);
    expect(container.textContent).toBe("Find your workspace");
  });
});

describe("Landing", () => {
  // The PR #955 review blocker: www must keep its landing although its health
  // looks exactly like a signed-out install's.
  it("on www, renders the landing although health is a 200 install-shaped answer", async () => {
    host.value = "www.agentdash.cloud";
    fetchMock.mockResolvedValue(json(WWW_HEALTH));
    await render(<Landing />);
    expect(container.textContent).not.toContain("Navigate:");
    expect(container.querySelector(".mkt-root")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on the apex, renders the landing", async () => {
    host.value = "agentdash.cloud";
    fetchMock.mockResolvedValue(json(WWW_HEALTH));
    await render(<Landing />);
    expect(container.textContent).not.toContain("Navigate:");
    expect(container.querySelector(".mkt-root")).not.toBeNull();
  });

  it("on a Vercel preview, renders the landing", async () => {
    host.value = "agentdash-pr-955.vercel.app";
    fetchMock.mockResolvedValue(json(WWW_HEALTH));
    await render(<Landing />);
    expect(container.textContent).not.toContain("Navigate:");
    expect(container.querySelector(".mkt-root")).not.toBeNull();
  });

  it("on a box host (#949), sends a signed-out visitor to the box's sign-in, not the marketing page", async () => {
    host.value = "acme.agentdash.cloud";
    fetchMock.mockResolvedValue(json(BOX_HEALTH));
    await render(<Landing />);
    expect(container.textContent).toBe(`Navigate:${BOX_SIGN_IN_PATH}`);
  });

  it("on a box host (#949), still sends a signed-in user to the app", async () => {
    host.value = "acme.agentdash.cloud";
    fetchMock.mockResolvedValue(json(BOX_HEALTH));
    mockGetSession.mockResolvedValue({ session: { id: "s" }, user: { id: "u" } });
    await render(<Landing />);
    expect(container.textContent).toBe("Navigate:/companies");
  });

  // AgentDash (scan 2, E4): any install, not only a hosted box.
  it("on a self-hosted install, sends a signed-out visitor to sign-in, not the marketing page", async () => {
    host.value = "agentdash.example.com";
    fetchMock.mockResolvedValue(json(SELF_HOSTED_HEALTH));
    await render(<Landing />);
    expect(container.textContent).toBe(`Navigate:${BOX_SIGN_IN_PATH}`);
  });

  it("on a self-hosted install, still sends a signed-in user to the app", async () => {
    host.value = "agentdash.example.com";
    fetchMock.mockResolvedValue(json(SELF_HOSTED_HEALTH));
    mockGetSession.mockResolvedValue({ session: { id: "s" }, user: { id: "u" } });
    await render(<Landing />);
    expect(container.textContent).toBe("Navigate:/companies");
  });

  it("on an install whose health fails, sends the visitor to sign-in rather than the marketing page", async () => {
    host.value = "agentdash.example.com";
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await render(<Landing />);
    expect(container.textContent).toBe(`Navigate:${BOX_SIGN_IN_PATH}`);
  });
});
