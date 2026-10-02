// @vitest-environment jsdom
// AgentDash (GH #793, UX-12): Settings > Connections.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockListConnections = vi.hoisted(() => vi.fn());
const mockDisconnect = vi.hoisted(() => vi.fn());
const mockListGrants = vi.hoisted(() => vi.fn());
const mockRevoke = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() => vi.fn());

vi.mock("@/api/githubConnections", () => ({
  GITHUB_FINE_GRAINED_TOKEN_URL: "https://github.com/settings/personal-access-tokens/new",
  githubConnectionsApi: {
    list: mockListConnections,
    connect: mockConnect,
    disconnect: mockDisconnect,
  },
}));

vi.mock("@/api/assistant-grants", () => ({
  assistantGrantsApi: { listMine: mockListGrants, revoke: mockRevoke },
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

const mockCompany = vi.hoisted(() => ({
  current: { id: "company-1", name: "Paperclip" } as Record<string, unknown>,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: mockCompany.current,
  }),
}));

vi.mock("@/lib/router", async () => {
  const dom = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { Link: dom.Link, useLocation: dom.useLocation, useNavigate: dom.useNavigate };
});

import { CompanyConnections } from "./CompanyConnections";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const connection = {
  id: "conn-1",
  companyId: "company-1",
  projectId: "project-1",
  projectName: "Web app",
  projectWorkspaceId: "ws-1",
  repo: "acme/web",
  repoUrl: "https://github.com/acme/web",
  defaultBranch: "main",
  credentialSource: "fine_grained_pat",
  credentialPresent: true,
  validatedAt: "2026-09-20T00:00:00.000Z",
  connectedByUserId: "u1",
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
};

const grant = {
  id: "g1",
  clientId: "muse",
  clientName: "Muse",
  redirectHost: "muse.meta.example",
  scopes: ["agentdash:read", "agentdash:work"],
  createdAt: null,
  lastUsedAt: null,
};

describe("CompanyConnections", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCompany.current = { id: "company-1", name: "Paperclip" };
    mockListConnections.mockResolvedValue({ connections: [connection], canManage: true });
    mockListGrants.mockResolvedValue({ grants: [grant] });
    mockDisconnect.mockResolvedValue({ ok: true, id: "conn-1" });
    mockRevoke.mockResolvedValue({ revoked: true, grantId: "g1" });
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  async function render(initialEntry = "/company/settings/connections") {
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root!.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[initialEntry]}>
            <CompanyConnections />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("confirms a Slack connection when the OAuth callback returns here", async () => {
    await render("/company/settings/connections?slack=connected&team=Brightline");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Slack connected to Brightline.");
  });

  it("says when the Slack connection failed", async () => {
    await render("/company/settings/connections?slack=error");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Slack could not be connected");
  });

  it("shows no Slack message without the callback parameter", async () => {
    await render();
    expect(container.textContent).not.toContain("Slack connected");
    expect(container.textContent).not.toContain("Slack could not be connected");
  });

  it("shows the connected repo and lets an admin rotate or remove the token", async () => {
    await render();

    const page = container.querySelector('[data-testid="company-connections"]')!;
    expect(page.textContent).toContain("GitHub");
    expect(page.textContent).toContain("acme/web");
    expect(page.textContent).toContain("Project Web app");
    // Rotate flow comes from the shared connect step.
    expect(page.textContent).toContain("Replace token");
    // Remove is per-connection.
    expect(page.textContent).toContain("Remove connection");
    // The stored token is never rendered.
    expect(container.innerHTML).not.toContain("github_pat");
  });

  it("removes a connection through the API when Remove is clicked", async () => {
    await render();
    const remove = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Remove connection",
    )!;
    await act(async () => remove.click());
    expect(mockDisconnect).toHaveBeenCalledWith("company-1", "conn-1");
  });

  it("offers the connect form when no repository is connected", async () => {
    mockListConnections.mockResolvedValue({ connections: [], canManage: true });
    await render();
    expect(container.textContent).toContain("Check and connect");
  });

  it("keeps the read-only copy for members who cannot manage", async () => {
    mockListConnections.mockResolvedValue({ connections: [connection], canManage: false });
    await render();
    expect(container.textContent).toContain("Only a workspace owner or admin can connect");
    expect(container.textContent).not.toContain("Remove connection");
  });

  it("lists assistant grants and links to the connect page", async () => {
    await render();
    const page = container.querySelector('[data-testid="company-connections"]')!;
    expect(page.textContent).toContain("Assistant");
    expect(page.textContent).toContain("Muse");
    expect(page.textContent).toContain("Disconnect");
    const link = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === "Connect your assistant",
    );
    expect(link?.getAttribute("href")).toBe("/connect-assistant");
  });
});
