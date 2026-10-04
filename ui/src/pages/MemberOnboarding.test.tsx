// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberOnboardingPage } from "./MemberOnboarding";

const listMemberSessionsMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/onboarding", () => ({
  onboardingApi: {
    listMemberSessions: () => listMemberSessionsMock(),
    advanceMemberSession: vi.fn(),
    completeMemberSession: vi.fn(),
  },
}));

vi.mock("@/lib/router", () => ({
  Navigate: ({ to }: { to: string }) => <div>Navigate:{to}</div>,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: () => navigateMock,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("MemberOnboardingPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("sends a completed member to the company dashboard instead of a prefixed fallback", async () => {
    listMemberSessionsMock.mockResolvedValue([
      {
        id: "session-1",
        companyId: "company-1",
        companyName: "MKThink",
        issuePrefix: "MKT",
        status: "completed",
        currentStep: "workspace",
        completedAt: "2026-08-26T17:00:00.000Z",
        updatedAt: "2026-08-26T17:00:00.000Z",
        isSteward: false,
      },
    ]);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemberOnboardingPage />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Navigate:/MKT/dashboard");
      });
    });

    await act(async () => root.unmount());
  });

  // AgentDash (scan 5, lane access): an ordinary invitee gets a plain
  // "You joined <workspace>" welcome — no steward wording, no steward guide.
  it("shows a non-steward the joined welcome without steward wording", async () => {
    listMemberSessionsMock.mockResolvedValue([
      {
        id: "session-1",
        companyId: "company-1",
        companyName: "MKThink",
        issuePrefix: "MKT",
        status: "in_progress",
        currentStep: "welcome",
        completedAt: null,
        updatedAt: "2026-08-26T17:00:00.000Z",
        isSteward: false,
      },
    ]);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemberOnboardingPage />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("You joined MKThink");
      });
    });
    expect(container.textContent).not.toContain("steward");
    expect(container.textContent).not.toContain("Steward");

    await act(async () => root.unmount());
  });

  it("keeps the steward guide for a member who stewards an agent", async () => {
    listMemberSessionsMock.mockResolvedValue([
      {
        id: "session-1",
        companyId: "company-1",
        companyName: "MKThink",
        issuePrefix: "MKT",
        status: "in_progress",
        currentStep: "welcome",
        completedAt: null,
        updatedAt: "2026-08-26T17:00:00.000Z",
        isSteward: true,
      },
    ]);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemberOnboardingPage />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Welcome to your workspace");
        expect(container.textContent).toContain("Getting started as a steward");
      });
    });

    await act(async () => root.unmount());
  });
});
