// @vitest-environment jsdom
//
// What this protects: a guide never shows a new person a literal `{{instanceUrl}}`
// or somebody else's address. The token is replaced with what this instance
// publishes before the markdown is rendered.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Guide } from "@/lib/guides";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useParams: () => ({}),
}));

// MarkdownBody pulls in theme, query and router context. The substitution is
// what is under test, so the renderer is a pass-through here.
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="body">{children}</div>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { GuideView } = await import("./Guide");

const guide: Guide = {
  group: "steward",
  slug: "connect-your-terminal",
  title: "Connect Your Terminal",
  summary: "One command.",
  audience: "steward",
  order: 2,
  body: "Run `npx -y agentdash-connect@latest --url {{instanceUrl}} KVTX-8F02` and open {{instanceUrl}}/my-agent.",
};

describe("GuideView", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("puts this instance's published address where the token was", () => {
    act(() => {
      root.render(<GuideView guide={guide} instanceUrl="http://10.0.0.5:3102/" />);
    });
    const body = container.querySelector('[data-testid="body"]')?.textContent ?? "";
    expect(body).toContain("--url http://10.0.0.5:3102 KVTX-8F02");
    expect(body).toContain("open http://10.0.0.5:3102/my-agent");
    expect(body).not.toContain("{{");
  });

  it("shows the title and summary, and a way back to the index", () => {
    act(() => {
      root.render(<GuideView guide={guide} instanceUrl="http://10.0.0.5:3102" />);
    });
    expect(container.querySelector("h1")?.textContent).toBe("Connect Your Terminal");
    expect(container.textContent).toContain("One command.");
    expect(container.querySelector('a[href="/guides"]')).not.toBeNull();
  });
});
