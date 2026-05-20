// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Landing } from "./Landing";

const mockHealthGet = vi.hoisted(() => vi.fn());
const mockGetSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate" data-to={to} />,
}));

vi.mock("../../api/health", () => ({
  healthApi: {
    get: () => mockHealthGet(),
  },
}));

vi.mock("../../api/auth", () => ({
  authApi: {
    getSession: () => mockGetSession(),
  },
}));

vi.mock("../MarketingShell", () => ({
  MarketingShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock("../sections/Hero", () => ({
  Hero: () => <h1>Run an AI workforce the way you'd run a company.</h1>,
}));

vi.mock("../sections/LayeredDescent", () => ({ LayeredDescent: () => null }));
vi.mock("../sections/CapabilitiesGrid", () => ({ CapabilitiesGrid: () => null }));
vi.mock("../sections/HowItWorks", () => ({ HowItWorks: () => null }));
vi.mock("../sections/ConsultingBand", () => ({ ConsultingBand: () => null }));
vi.mock("../sections/FinalCTA", () => ({ FinalCTA: () => null }));
vi.mock("../components/SectionContainer", () => ({
  SectionContainer: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));
vi.mock("../components/LogoStrip", () => ({ LogoStrip: () => null }));
vi.mock("../components/QuoteBlock", () => ({ QuoteBlock: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Marketing landing", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockHealthGet.mockReset();
    mockGetSession.mockReset();
  });

  afterEach(() => {
    if (root) {
      act(() => root.unmount());
    }
    document.body.removeChild(container);
  });

  function render() {
    root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Landing />
        </QueryClientProvider>,
      );
    });
  }

  it("shows the public marketing page when no backend health endpoint is available", async () => {
    mockHealthGet.mockRejectedValue(new Error("health unavailable"));

    render();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Run an AI workforce the way you'd run a company.");
    expect(container.querySelector("[data-testid='navigate']")).toBeNull();
  });
});
