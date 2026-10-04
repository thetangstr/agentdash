// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockHealthApi = vi.hoisted(() => ({ get: vi.fn() }));
const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn() }));

vi.mock("../api/health", () => ({ healthApi: mockHealthApi }));
vi.mock("../api/auth", () => ({ authApi: mockAuthApi }));
vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));

const { useBoardOrgAccess, useIsInstanceAdmin } = await import("./useBoardSessionReady");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  return <span data-testid="org-access">{String(useBoardOrgAccess())}</span>;
}

function AdminProbe() {
  return <span data-testid="instance-admin">{String(useIsInstanceAdmin())}</span>;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

async function renderProbe() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  // health → session → access settle as chained queries; flush each hop
  for (let i = 0; i < 6; i += 1) {
    await flush();
  }
  return container.querySelector('[data-testid="org-access"]')!.textContent;
}

async function renderAdminProbe() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <AdminProbe />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 6; i += 1) {
    await flush();
  }
  return container.querySelector('[data-testid="instance-admin"]')!.textContent;
}

describe("useBoardOrgAccess", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("is true in local trusted mode without asking /cli-auth/me", async () => {
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "local_trusted" });
    expect(await renderProbe()).toBe("true");
    expect(mockAuthApi.getSession).not.toHaveBeenCalled();
    expect(mockAccessApi.getCurrentBoardAccess).not.toHaveBeenCalled();
  });

  it("is false for a signed-in founder with no company membership yet", async () => {
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "authenticated" });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "u1" } });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      userId: "u1",
      isInstanceAdmin: false,
      companyIds: [],
    });
    expect(await renderProbe()).toBe("false");
  });

  it("is true for an instance admin or a member of at least one company", async () => {
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "authenticated" });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "u1" } });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      userId: "u1",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });
    expect(await renderProbe()).toBe("true");
  });

  it("is true for an instance admin even with no memberships", async () => {
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "authenticated" });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "u1" } });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      userId: "u1",
      isInstanceAdmin: true,
      companyIds: [],
    });
    expect(await renderProbe()).toBe("true");
  });

  it("fails open when the access check errors", async () => {
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "authenticated" });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "u1" } });
    mockAccessApi.getCurrentBoardAccess.mockRejectedValue(new Error("network"));
    expect(await renderProbe()).toBe("true");
  });
});

// AgentDash (c3 copy): operator-only copy (e.g. the adapter alpha notice) is
// gated on instance admin, not on having any org access.
describe("useIsInstanceAdmin", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("is true in local trusted mode without asking /cli-auth/me", async () => {
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "local_trusted" });
    expect(await renderAdminProbe()).toBe("true");
    expect(mockAccessApi.getCurrentBoardAccess).not.toHaveBeenCalled();
  });

  it("is true for an instance admin", async () => {
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "authenticated" });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "u1" } });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      userId: "u1",
      isInstanceAdmin: true,
      companyIds: [],
    });
    expect(await renderAdminProbe()).toBe("true");
  });

  it("is false for a company member who is not an instance admin", async () => {
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "authenticated" });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "u1" } });
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      userId: "u1",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });
    expect(await renderAdminProbe()).toBe("false");
  });

  it("fails open when the access check errors", async () => {
    mockHealthApi.get.mockResolvedValue({ deploymentMode: "authenticated" });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "u1" } });
    mockAccessApi.getCurrentBoardAccess.mockRejectedValue(new Error("network"));
    expect(await renderAdminProbe()).toBe("true");
  });
});
