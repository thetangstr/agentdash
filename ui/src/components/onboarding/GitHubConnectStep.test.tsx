// @vitest-environment jsdom
// AgentDash (GH #782): the "Connect GitHub" step.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubRepoConnection } from "@paperclipai/shared";
import { ApiError } from "@/api/client";

const mockConnect = vi.hoisted(() => vi.fn());
vi.mock("@/api/githubConnections", () => ({
  GITHUB_FINE_GRAINED_TOKEN_URL: "https://github.com/settings/personal-access-tokens/new",
  githubConnectionsApi: { connect: mockConnect },
}));

import { GitHubConnectStep } from "./GitHubConnectStep";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = "github_pat_11UITEST0000000000000000_uiTestTokenValue";

const CONNECTION: GitHubRepoConnection = {
  id: "conn-1",
  companyId: "company-1",
  projectId: "project-1",
  projectName: "app",
  projectWorkspaceId: "ws-1",
  repo: "acme/app",
  repoUrl: "https://github.com/acme/app",
  defaultBranch: "main",
  credentialSource: "pat",
  credentialPresent: true,
  validatedAt: "2026-09-26T12:00:00.000Z",
  connectedByUserId: "owner-1",
  createdAt: "2026-09-26T12:00:00.000Z",
  updatedAt: "2026-09-26T12:00:00.000Z",
};

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("GitHubConnectStep", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockConnect.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: Partial<Parameters<typeof GitHubConnectStep>[0]> = {}) {
    const onConnected = vi.fn();
    act(() => {
      root.render(
        <GitHubConnectStep companyId="company-1" connection={null} canManage onConnected={onConnected} {...props} />,
      );
    });
    return { onConnected };
  }

  const repoInput = () => container.querySelector<HTMLInputElement>('input[name="repoUrl"]')!;
  const tokenInput = () => container.querySelector<HTMLInputElement>('input[name="githubToken"]')!;
  const submit = async () => {
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  };

  it("asks for a fine-grained, single-repo token with the minimum permissions, and masks it", () => {
    render();
    const howto = container.querySelector('[data-testid="github-token-howto"]')!.textContent!;
    expect(howto).toContain("Only select repositories");
    expect(howto).toContain("Contents: Read and write");
    expect(howto).toContain("Pull requests: Read and write");
    expect(howto).toContain("can read this token");
    expect(container.querySelector<HTMLAnchorElement>('a[href="https://github.com/settings/personal-access-tokens/new"]')).not.toBeNull();
    expect(tokenInput().type).toBe("password");
    expect(tokenInput().autocomplete).toBe("off");
  });

  it("connects with a valid token, then clears it and reports the connection", async () => {
    mockConnect.mockResolvedValue({ connection: CONNECTION, projectCreated: true });
    const { onConnected } = render({ projectId: "project-1" });
    act(() => setInput(repoInput(), " https://github.com/acme/app "));
    act(() => setInput(tokenInput(), ` ${TOKEN} `));
    await submit();
    expect(mockConnect).toHaveBeenCalledWith("company-1", {
      repoUrl: "https://github.com/acme/app",
      githubToken: TOKEN,
      projectId: "project-1",
    });
    expect(onConnected).toHaveBeenCalledWith({ connection: CONNECTION, projectCreated: true });
    expect(container.innerHTML).not.toContain(TOKEN);
  });

  it("shows the missing permission when the token has the wrong scope, and keeps the form", async () => {
    mockConnect.mockRejectedValue(
      new ApiError("The token can read acme/app but cannot push to it. Missing permission: Contents: Read and write.", 422, {}),
    );
    const { onConnected } = render();
    act(() => setInput(repoInput(), "acme/app"));
    act(() => setInput(tokenInput(), TOKEN));
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Missing permission: Contents: Read and write");
    expect(onConnected).not.toHaveBeenCalled();
    expect(container.querySelector("form")).not.toBeNull();
  });

  it("says so plainly on a network error", async () => {
    mockConnect.mockRejectedValue(new TypeError("Failed to fetch"));
    render();
    act(() => setInput(repoInput(), "acme/app"));
    act(() => setInput(tokenInput(), TOKEN));
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not reach the workspace");
  });

  it("shows the connected repo, never a token, and lets an admin replace it", () => {
    render({ connection: CONNECTION });
    expect(container.querySelector('[data-testid="github-connected"]')?.textContent).toContain("acme/app");
    expect(container.querySelector("form")).toBeNull();
    const replace = [...container.querySelectorAll("button")].find((button) => button.textContent === "Replace token")!;
    act(() => replace.click());
    expect(repoInput().value).toBe("https://github.com/acme/app");
    expect(tokenInput().value).toBe("");
  });

  it("shows a member the state but no form", () => {
    render({ connection: CONNECTION, canManage: false });
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector('[data-testid="github-connect-restricted"]')).not.toBeNull();
    expect(container.textContent).toContain("acme/app");
  });
});
