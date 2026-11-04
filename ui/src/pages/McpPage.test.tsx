// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpPage } from "./McpPage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => {
    root.render(<McpPage />);
  });
}

describe("McpPage", () => {
  it("introduces hosted workspace requests without promising automatic setup", () => {
    render();
    expect(container.textContent).toContain("Access AgentDash from any MCP client");
    expect(container.textContent).toContain("Request a hosted workspace");
  });

  it("renders the one-line fresh-machine bootstrap command", () => {
    render();
    expect(container.textContent).toContain(
      "curl -fsSL https://raw.githubusercontent.com/thetangstr/agentdash/main/scripts/bootstrap-fresh-mac.sh | bash",
    );
  });

  it("renders the existing-instance claude mcp add command", () => {
    render();
    expect(container.textContent).toContain("claude mcp add agentdash");
    expect(container.textContent).toContain("PAPERCLIP_API_URL=https://YOUR-INSTANCE:3100");
    expect(container.textContent).toContain("PAPERCLIP_API_KEY=YOUR-BOARD-API-KEY");
    expect(container.textContent).toContain("packages/mcp-server/dist/stdio.js");
  });

  it("shows the remote hosted endpoint and its four request tools before local installation", () => {
    render();
    const hosted = [...container.querySelectorAll("section")].find((section) =>
      section.querySelector("h2")?.textContent === "Request a hosted workspace",
    );
    expect(hosted).toBeTruthy();
    expect(hosted!.querySelector("pre")?.textContent).toContain("https://www.agentdash.cloud/api/cloud/mcp");
    expect([...hosted!.querySelectorAll("li code")].map((code) => code.textContent)).toEqual([
      "agentdash_cloud_check_name", "agentdash_cloud_start", "agentdash_cloud_status", "agentdash_cloud_connect",
    ]);
    const bootstrap = [...container.querySelectorAll("pre")].find((pre) => pre.textContent?.includes("bootstrap-fresh-mac.sh"));
    expect(bootstrap).toBeTruthy();
    expect(hosted!.compareDocumentPosition(bootstrap!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hosted!.textContent).toMatch(/no local install or API key/i);
    expect(hosted!.textContent).toMatch(/four request tools.*does not switch.*setup tools/i);
    expect(hosted!.querySelector('a[href="/docs/mcp/connecting"]')).not.toBeNull();
    expect(hosted!.querySelector('a[href="/docs/start/quickstart"]')).not.toBeNull();
    expect(hosted!.querySelector('a[href="/start"]')).not.toBeNull();
  });

  it("makes the owner's verification, claim, access approval and model prerequisites visible", () => {
    render();
    const text = container.querySelector("main")!.textContent!;
    expect(text).toMatch(/accept the terms/i);
    expect(text).toMatch(/verify.*email/i);
    expect(text).toMatch(/claim.*password/i);
    expect(text).toMatch(/confirmation code.*approve/i);
    expect(text).toMatch(/admission.*capacity/i);
    expect(text).toMatch(/provider.*API key.*before the Chief of Staff can reply/i);
    expect(text).toMatch(/provider usage is billed separately/i);
    expect(container.querySelector('a[href="/terms"]')).not.toBeNull();
  });

  it("renders the tool catalog groups with journey tool names", () => {
    render();
    expect(container.textContent).toContain("Self-hosted workspace tools");
    expect(container.textContent).toContain("agentdash_install_checklist");
    expect(container.textContent).toContain("agentdash_get_dashboard");
    expect(container.textContent).toContain("agentdash_request_approval");
    expect(container.textContent).toContain("agentdash_confirm_plan");
  });

  it("keeps the self-hosted setup steps separate", () => {
    render();
    expect(container.textContent).toContain("Self-hosted setup");
    expect(container.textContent).toContain("Sign up via chat");
    expect(container.textContent).toContain("Deep interview");
    expect(container.textContent).toContain("Team runs with approval gates");
  });

  it("links to the MCP documentation", () => {
    render();
    expect(container.querySelector('a[href="/docs/mcp/overview"]')).not.toBeNull();
    expect(container.querySelector('a[href="/docs/mcp/connecting"]')).not.toBeNull();
  });

  it("links to pricing and the GitHub repo", () => {
    render();
    expect(container.querySelector('a[href="/pricing"]')).not.toBeNull();
    expect(
      container.querySelector('a[href="https://github.com/thetangstr/agentdash"]'),
    ).not.toBeNull();
  });
});
