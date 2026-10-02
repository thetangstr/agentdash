// @vitest-environment jsdom
// AgentDash (scan 4, lane N): CoS replies render as safe markdown, and a task
// shows once even in a conversation that still holds the old extra
// "Task created" message.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../api/conversations";

vi.mock("./cards", () => ({
  CardRenderer: ({ cardKind }: { cardKind: string }) => <div data-testid="card">{cardKind}</div>,
}));

import { MessageList } from "./MessageList";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function msg(id: string, fields: Partial<Message>): Message {
  return { id, conversationId: "conv1", role: "agent", content: "", createdAt: "2026-10-02T08:00:00Z", ...fields } as Message;
}

describe("MessageList", () => {
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

  function render(messages: Message[]) {
    act(() => {
      root.render(<MessageList messages={messages} cardContext={{}} />);
    });
  }

  it("renders an agent's markdown list as a list, not literal dashes", () => {
    render([msg("m1", { content: "Here's the plan:\n\n- **Avery** sorts email\n- Marcus runs the close" })]);
    const items = Array.from(container.querySelectorAll("li")).map((li) => li.textContent);
    expect(items).toEqual(["Avery sorts email", "Marcus runs the close"]);
    expect(container.querySelector("strong")?.textContent).toBe("Avery");
    expect(container.textContent).not.toContain("- ");
  });

  it("never renders raw HTML or script links from a reply", () => {
    render([msg("m1", { content: '<img src=x onerror="alert(1)"> [click](javascript:alert(1)) <b>bold</b>' })]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    const link = container.querySelector("a");
    expect(link?.getAttribute("href") ?? "").not.toContain("javascript:");
  });

  it("keeps a person's own message as plain text", () => {
    render([msg("m1", { role: "user", content: "- not a list" })]);
    expect(container.querySelector("li")).toBeNull();
    expect(container.textContent).toContain("- not a list");
  });

  it("hides an old separate Task created card for a task its proposal card already shows", () => {
    render([
      msg("p1", { cardKind: "issue_proposal_v1", cardPayload: { status: "created", issueId: "i1", title: "T" } }),
      msg("c1", { cardKind: "issue_created_v1", cardPayload: { issueId: "i1", title: "T" } }),
      msg("c2", { cardKind: "issue_created_v1", cardPayload: { issueId: "i2", title: "Other" } }),
    ]);
    const cards = Array.from(container.querySelectorAll('[data-testid="card"]')).map((c) => c.textContent);
    expect(cards).toEqual(["issue_proposal_v1", "issue_created_v1"]);
  });
});
