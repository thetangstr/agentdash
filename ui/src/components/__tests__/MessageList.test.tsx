// @vitest-environment jsdom
// AgentDash: chat substrate — MessageList smoke test

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageList } from "../MessageList";
import type { Message } from "../../api/conversations";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("MessageList", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders text messages and proposal cards", async () => {
    const messages: Message[] = [
      {
        id: "m1",
        conversationId: "c",
        role: "user",
        content: "hello",
        createdAt: new Date(0).toISOString(),
      },
      {
        id: "m2",
        conversationId: "c",
        role: "agent",
        content: "fallback text",
        cardKind: "proposal_card_v1",
        cardPayload: { name: "Reese", role: "SDR", oneLineOkr: "200 meetings", rationale: "ok" },
        createdAt: new Date(0).toISOString(),
      },
    ];

    const root = createRoot(container);
    await act(async () => {
      root.render(<MessageList messages={messages} cardContext={{}} />);
    });

    expect(container.textContent).toContain("hello");
    expect(container.textContent).toContain("Reese — SDR");

    await act(async () => {
      root.unmount();
    });
  });
});
