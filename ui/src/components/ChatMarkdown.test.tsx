// @vitest-environment jsdom
// AgentDash (scan 4, lane N, PR #989 review): links in CoS chat markdown can't
// disguise where they go.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatMarkdown, externalHost, hostNamedByText } from "./ChatMarkdown";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("externalHost", () => {
  const origin = "https://app.agentdash.com";
  it("treats in-app paths and same-origin URLs as internal", () => {
    expect(externalHost("/ACM/issues/ACM-1", origin)).toBeNull();
    expect(externalHost("#top", origin)).toBeNull();
    expect(externalHost("issues/ACM-1", origin)).toBeNull();
    expect(externalHost("https://app.agentdash.com/billing", origin)).toBeNull();
  });
  it("names the host of an external or protocol-relative link", () => {
    expect(externalHost("https://evil.example/login", origin)).toBe("evil.example");
    expect(externalHost("//evil.example/x", origin)).toBe("evil.example");
  });
});

describe("hostNamedByText", () => {
  it("reads a host from URL- or domain-looking text only", () => {
    expect(hostNamedByText("https://app.agentdash.com/billing")).toBe("app.agentdash.com");
    expect(hostNamedByText("app.agentdash.com/billing")).toBe("app.agentdash.com");
    expect(hostNamedByText("//evil.example")).toBe("evil.example");
    expect(hostNamedByText("the billing page")).toBeNull();
    expect(hostNamedByText("Billing")).toBeNull();
  });
});

describe("ChatMarkdown links", () => {
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

  function render(text: string) {
    act(() => {
      root.render(<ChatMarkdown>{text}</ChatMarkdown>);
    });
  }

  it("does not link text that names another site than the link opens", () => {
    render("Pay here: [https://app.agentdash.com/billing](https://evil.example/pay)");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("https://app.agentdash.com/billing");
    expect(container.querySelector('[data-testid="chat-link-disarmed"]')).not.toBeNull();
  });

  it("shows the real hostname after an external link's text", () => {
    render("Open [the billing page](https://evil.example/pay).");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://evil.example/pay");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
    expect(container.textContent).toContain("the billing page (evil.example)");
  });

  it("shows the host of a protocol-relative link", () => {
    render("[docs](//evil.example/docs)");
    expect(container.textContent).toContain("docs (evil.example)");
  });

  it("keeps an in-app path a plain link with no host", () => {
    render("See [ACM-1](/ACM/issues/ACM-1).");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/ACM/issues/ACM-1");
    expect(link?.getAttribute("target")).toBeNull();
    expect(container.querySelector('[data-testid="chat-link-host"]')).toBeNull();
  });

  it("does not turn bare www. text into a link", () => {
    render("Visit www.evil.example today");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("www.evil.example");
  });

  it("keeps a typed-out URL a link; its text already shows the host", () => {
    render("Docs: https://docs.example.com/start");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://docs.example.com/start");
    expect(container.querySelector('[data-testid="chat-link-host"]')).toBeNull();
  });

  it("drops script links", () => {
    render("[click](javascript:alert(1))");
    expect(container.querySelector("a")?.getAttribute("href") ?? "").not.toContain("javascript:");
  });
});
