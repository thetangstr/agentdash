// @vitest-environment jsdom
// AgentDash: www-only front-door pages (/start*, /find) call /api/cloud, which
// exists only on www. A hosted box sends them, and its signed-out root, to its
// own sign-in; www renders them as before.

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHealthGet = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());

vi.mock("../api/health", () => ({ healthApi: { get: () => mockHealthGet() } }));
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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockGetSession.mockResolvedValue(null);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
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
    mockHealthGet.mockResolvedValue({ status: "ok", deploymentMode: "authenticated", hostedBox: true });
    await render(findPage);
    expect(container.textContent).toBe(`Navigate:${BOX_SIGN_IN_PATH}`);
    expect(BOX_SIGN_IN_PATH).toBe("/auth?next=%2F");
  });

  it("renders the page on www (health without hostedBox)", async () => {
    mockHealthGet.mockResolvedValue({ status: "ok", deploymentMode: "authenticated" });
    await render(findPage);
    expect(container.textContent).toBe("Find your workspace");
  });

  it("renders the page when health cannot be read", async () => {
    mockHealthGet.mockRejectedValue(new Error("Failed to load health (404)"));
    await render(findPage);
    expect(container.textContent).toBe("Find your workspace");
  });
});

describe("Landing on a hosted box", () => {
  it("sends a signed-out visitor to the box's sign-in, not the marketing page", async () => {
    mockHealthGet.mockResolvedValue({ status: "ok", deploymentMode: "authenticated", hostedBox: true });
    await render(<Landing />);
    expect(container.textContent).toBe(`Navigate:${BOX_SIGN_IN_PATH}`);
  });

  it("still sends a signed-in user on a box to the app", async () => {
    mockHealthGet.mockResolvedValue({ status: "ok", deploymentMode: "authenticated", hostedBox: true });
    mockGetSession.mockResolvedValue({ session: { id: "s" }, user: { id: "u" } });
    await render(<Landing />);
    expect(container.textContent).toBe("Navigate:/companies");
  });
});
