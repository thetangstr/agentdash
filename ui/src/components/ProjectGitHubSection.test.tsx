// @vitest-environment jsdom
// AgentDash (GH #782): the project's GitHub section is default-profile only.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockList = vi.hoisted(() => vi.fn());
const mockCompany = vi.hoisted(() => ({ selectedCompany: null as null | { productProfile: string } }));
vi.mock("@/api/githubConnections", () => ({
  GITHUB_FINE_GRAINED_TOKEN_URL: "https://github.com/settings/personal-access-tokens/new",
  githubConnectionsApi: { list: mockList, connect: vi.fn() },
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => mockCompany }));

import { ProjectGitHubSection } from "./ProjectGitHubSection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProjectGitHubSection", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockList.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ProjectGitHubSection companyId="company-1" projectId="project-1" />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("renders the connect form on the default profile", async () => {
    mockCompany.selectedCompany = { productProfile: "default" };
    mockList.mockResolvedValue({ connections: [], canManage: true });
    await render();
    expect(mockList).toHaveBeenCalledWith("company-1");
    expect(container.querySelector('[data-testid="project-github-section"] form')).not.toBeNull();
  });

  it("renders nothing and fetches nothing for an agentdash_mk company", async () => {
    mockCompany.selectedCompany = { productProfile: "agentdash_mk" };
    await render();
    expect(mockList).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });
});
