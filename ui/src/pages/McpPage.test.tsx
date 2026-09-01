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
  it("renders the MCP-access headline and the no-signup-forms pitch", () => {
    render();
    expect(container.textContent).toContain("Access AgentDash from any MCP client");
    expect(container.textContent).toContain("No signup forms");
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

  it("shows no kickoff prompt — the server's own instructions steer the agent", () => {
    render();
    expect(container.textContent).toContain("Set up AgentDash for me.");
    expect(container.textContent).toContain("No prompt to paste");
    // The old pasted playbook must NOT be on the customer page.
    expect(container.textContent).not.toContain("Read the\nagentdash://playbook resource first");
    expect(container.textContent).not.toContain("BOUNDARIES:");
    expect(container.textContent).not.toContain("Never hire agents beyond the confirmed plan.");
  });

  it("renders the tool catalog groups with journey tool names", () => {
    render();
    expect(container.textContent).toContain("What your agent can do");
    expect(container.textContent).toContain("agentdash_install_checklist");
    expect(container.textContent).toContain("agentdash_get_dashboard");
    expect(container.textContent).toContain("agentdash_request_approval");
    expect(container.textContent).toContain("agentdash_confirm_plan");
  });

  it("renders the four how-it-works steps", () => {
    render();
    expect(container.textContent).toContain("Install");
    expect(container.textContent).toContain("Sign up via chat");
    expect(container.textContent).toContain("Deep interview");
    expect(container.textContent).toContain("Team runs with approval gates");
  });

  it("links to pricing and the GitHub repo", () => {
    render();
    expect(container.querySelector('a[href="/pricing"]')).not.toBeNull();
    expect(
      container.querySelector('a[href="https://github.com/thetangstr/agentdash"]'),
    ).not.toBeNull();
  });
});
