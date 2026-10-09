// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudAccessGate } from "./components/CloudAccessGate";

const mockHealthApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

const mockLocation = vi.hoisted(() => ({ pathname: "/instance/settings/general", search: "" }));

const mockOnboardingApi = vi.hoisted(() => ({
  listMemberSessions: vi.fn(),
}));

vi.mock("./api/health", () => ({
  healthApi: mockHealthApi,
}));

vi.mock("./api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("./api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("./api/onboarding", () => ({
  onboardingApi: mockOnboardingApi,
}));

vi.mock("@/lib/router", () => ({
  Navigate: ({ to }: { to: string }) => <div>Navigate:{to}</div>,
  Outlet: () => <div>Outlet content</div>,
  Route: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Routes: ({ children }: { children?: ReactNode }) => <>{children}</>,
  useLocation: () => ({ pathname: mockLocation.pathname, search: mockLocation.search, hash: "" }),
  useParams: () => ({}),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

// An explicit clock for the stale-cache tests: react-query stamps
// dataUpdatedAt with Date.now(), and the gate compares those stamps, so the
// tests set them a full second apart instead of relying on millisecond luck.
let restoreClock: (() => void) | null = null;
function installExplicitClock(start = 1_700_000_000_000) {
  let now = start;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
  restoreClock = () => spy.mockRestore();
  return {
    advance: (ms: number) => {
      now += ms;
    },
    restore: () => {
      restoreClock?.();
      restoreClock = null;
    },
  };
}

describe("CloudAccessGate", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
    });
    mockOnboardingApi.listMemberSessions.mockResolvedValue([]);
  });

  afterEach(() => {
    restoreClock?.();
    restoreClock = null;
    mockLocation.pathname = "/instance/settings/general";
    mockLocation.search = "";
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows a no-access message for signed-in users without org access", async () => {
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: [],
      source: "session",
      keyId: null,
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CloudAccessGate />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No company access");
    expect(container.textContent).not.toContain("Outlet content");

    await act(async () => {
      root.unmount();
    });
  });

  // AgentDash: self-serve-bootstrap — when the env flag is on, a fresh
  // instance routes the first signed-in user to name the workspace instead of
  // the CLI bootstrap page or a dead-end "No company access". One onboarding
  // path: a self-hosted instance goes to /company-create like a hosted box,
  // not to the six-step wizard at /onboarding.
  it("routes the self-hosted first user to /company-create, not /onboarding, when no company exists", async () => {
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
      selfServeBootstrap: true,
      instanceHasCompany: false,
    });
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: [],
      source: "session",
      keyId: null,
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CloudAccessGate />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Navigate:/company-create");
    expect(container.textContent).not.toContain("Navigate:/onboarding");
    expect(container.textContent).not.toContain("No company access");

    await act(async () => {
      root.unmount();
    });
  });

  // AgentDash (document access): a provider's callback carries a one-time
  // authorization code. Sending a signed-out person to sign in must not copy
  // that code into /auth?next= (address bar, history, the auth page's logs).
  it("sends a signed-out document-connect callback to sign in without its one-time code", async () => {
    mockLocation.pathname = "/connect/microsoft/callback";
    mockLocation.search = "?code=one-time-code-X&state=conn-1.state-Y";
    mockAuthApi.getSession.mockResolvedValue(null);

    const root = await renderGate();

    expect(container.textContent).toContain("Navigate:/auth?next=%2Fconnect%2Fmicrosoft%2Fcallback");
    expect(container.textContent).not.toContain("code=");
    expect(container.textContent).not.toContain("one-time-code-X");
    expect(container.textContent).not.toContain("state-Y");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the query of any other page in the sign-in redirect", async () => {
    mockLocation.pathname = "/ACME/issues";
    mockLocation.search = "?q=open";
    mockAuthApi.getSession.mockResolvedValue(null);

    const root = await renderGate();

    expect(container.textContent).toContain(`Navigate:/auth?next=${encodeURIComponent("/ACME/issues?q=open")}`);

    await act(async () => {
      root.unmount();
    });
  });

  async function renderGate() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CloudAccessGate />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();
    return root;
  }

  function signedInWithoutCompany() {
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: [],
      source: "session",
      keyId: null,
    });
  }

  it("sends the self-hosted founder of a fresh instance (bootstrap pending) to /company-create", async () => {
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "bootstrap_pending",
      selfServeBootstrap: true,
      instanceHasCompany: false,
      hostedBox: false,
    });
    signedInWithoutCompany();
    const root = await renderGate();
    expect(container.textContent).toContain("Navigate:/company-create");
    expect(container.textContent).not.toContain("Navigate:/onboarding");
    await act(async () => root.unmount());
  });

  it("still lets a self-hosted deep link to /onboarding through (the wizard is kept, not routed to)", async () => {
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "bootstrap_pending",
      selfServeBootstrap: true,
      instanceHasCompany: false,
      hostedBox: false,
    });
    signedInWithoutCompany();
    mockLocation.pathname = "/onboarding";
    const root = await renderGate();
    expect(container.textContent).toContain("Outlet content");
    await act(async () => root.unmount());
  });

  it("keeps the hosted box behaviour: /onboarding is sent to /company-create", async () => {
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "bootstrap_pending",
      selfServeBootstrap: true,
      instanceHasCompany: false,
      hostedBox: true,
    });
    signedInWithoutCompany();
    mockLocation.pathname = "/onboarding";
    const root = await renderGate();
    expect(container.textContent).toContain("Navigate:/company-create");
    expect(container.textContent).not.toContain("Outlet content");
    await act(async () => root.unmount());
  });

  it("lets the self-hosted first user stay on /company-create", async () => {
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
      selfServeBootstrap: true,
      instanceHasCompany: false,
      hostedBox: false,
    });
    signedInWithoutCompany();
    mockLocation.pathname = "/company-create";
    const root = await renderGate();
    expect(container.textContent).toContain("Outlet content");
    await act(async () => root.unmount());
  });

  it("shows No company access when selfServeBootstrap is on but a company already exists", async () => {
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
      selfServeBootstrap: true,
      instanceHasCompany: true,
    });
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: [],
      source: "session",
      keyId: null,
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CloudAccessGate />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("No company access");
    expect(container.textContent).not.toContain("Navigate:/onboarding");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the CLI bootstrap page when selfServeBootstrap is off and bootstrap is pending", async () => {
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "bootstrap_pending",
      bootstrapInviteActive: false,
      selfServeBootstrap: false,
      instanceHasCompany: false,
    });
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: [],
      source: "session",
      keyId: null,
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CloudAccessGate />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Instance setup required");
    expect(container.textContent).not.toContain("Navigate:/onboarding");

    await act(async () => {
      root.unmount();
    });
  });

  it("allows authenticated users with company access through to the board", async () => {
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      source: "session",
      keyId: null,
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CloudAccessGate />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Outlet content");
      });
    });
    expect(container.textContent).not.toContain("No company access");

    await act(async () => {
      root.unmount();
    });
  });

  it("routes an invited member with incomplete onboarding to the resumable flow", async () => {
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      source: "session",
      keyId: null,
    });
    mockOnboardingApi.listMemberSessions.mockResolvedValue([
      {
        id: "onboarding-1",
        companyId: "company-1",
        companyName: "MKThink",
        issuePrefix: "MKT",
        status: "in_progress",
        currentStep: "workspace",
        completedAt: null,
        updatedAt: "2026-08-26T17:00:00.000Z",
      },
    ]);

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CloudAccessGate />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Navigate:/member-onboarding");
      });
    });
    expect(container.textContent).not.toContain("Outlet content");

    await act(async () => root.unmount());
  });

  // AgentDash: the first live canary claim of a hosted box. The founder signs
  // up, names the workspace at /company-create, and the server makes them a
  // member and instance admin. The gate stays mounted across those routes, so
  // its board-access query still holds the pre-company "no companies" answer
  // while health (which polls during bootstrap) already says a company
  // exists. That used to dead-end on "No company access" until a reload.
  it("refetches stale board access after the first company is created instead of showing No company access", async () => {
    const clock = installExplicitClock();
    const session = {
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "founder@example.com", name: "Founder", image: null },
    };
    mockAuthApi.getSession.mockResolvedValue(session);
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "bootstrap_pending",
      selfServeBootstrap: true,
      instanceHasCompany: false,
      hostedBox: true,
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: session.user,
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: [],
      source: "session",
      keyId: null,
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CloudAccessGate />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();
    // Before the company exists, the founder is sent to name the workspace.
    expect(container.textContent).toContain("Navigate:/company-create");

    // POST /api/companies?fromSignup=1 succeeded: membership + instance admin.
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
      selfServeBootstrap: true,
      instanceHasCompany: true,
      hostedBox: true,
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: session.user,
      userId: "user-1",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
      source: "session",
      keyId: null,
    });
    const boardAccessCallsBefore = mockAccessApi.getCurrentBoardAccess.mock.calls.length;

    // Only health refreshes (the bootstrap poll), a second later; board access
    // is still the cached pre-company answer, stamped strictly earlier.
    clock.advance(1_000);
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["health"] });
    });
    await flushReact();
    await flushReact();
    await flushReact();

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Outlet content");
      });
    });
    expect(container.textContent).not.toContain("No company access");
    expect(mockAccessApi.getCurrentBoardAccess.mock.calls.length).toBe(boardAccessCallsBefore + 1);

    await act(async () => root.unmount());
    clock.restore();
  });

  it("still shows No company access when fresh board access confirms there is none", async () => {
    const clock = installExplicitClock();
    mockHealthApi.get.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      bootstrapStatus: "ready",
      selfServeBootstrap: true,
      instanceHasCompany: true,
    });
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
    });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", name: "User", image: null },
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: [],
      source: "session",
      keyId: null,
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CloudAccessGate />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("No company access");
      });
    });
    // Same clock tick for everything so far: board access is not older than
    // health or the session, so the gate did not refetch it.
    expect(mockAccessApi.getCurrentBoardAccess).toHaveBeenCalledTimes(1);

    // Health refreshes a second later (window focus); board access is
    // refetched exactly once, still says no access, and the gate settles on
    // the page without looping.
    clock.advance(1_000);
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["health"] });
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(mockAccessApi.getCurrentBoardAccess).toHaveBeenCalledTimes(2);
        expect(container.textContent).toContain("No company access");
      });
    });
    const calls = mockAccessApi.getCurrentBoardAccess.mock.calls.length;
    await flushReact();
    await flushReact();
    expect(mockAccessApi.getCurrentBoardAccess.mock.calls.length).toBe(calls);
    expect(calls).toBe(2);

    await act(async () => root.unmount());
    clock.restore();
  });
});
