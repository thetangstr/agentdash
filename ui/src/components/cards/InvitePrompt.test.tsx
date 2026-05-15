// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvitePrompt } from "./InvitePrompt";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("InvitePrompt", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let clipboardWriteTextMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    clipboardWriteTextMock = vi.fn(async () => {});
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteTextMock },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function setNativeValue(el: HTMLInputElement, value: string) {
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    desc?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("keeps generated invite links visible and copyable after sending", async () => {
    const onSkip = vi.fn();
    const onSendInvites = vi.fn(async () => ({
      inviteIds: ["invite-1"],
      invites: [
        {
          id: "invite-1",
          email: "jane@example.com",
          invitePath: "/invite/pcp_invite_test",
          inviteUrl: "https://agentdash.local/invite/pcp_invite_test",
          expiresAt: "2026-05-16T00:00:00.000Z",
          emailStatus: "skipped",
        },
      ],
      errors: [],
    }));

    await act(async () => {
      root.render(
        <InvitePrompt
          companyId="company-1"
          conversationId="conversation-1"
          onSendInvites={onSendInvites as any}
          onSkip={onSkip}
        />,
      );
    });

    const input = container.querySelector("input") as HTMLInputElement;
    await act(async () => {
      setNativeValue(input, "jane@example.com");
    });

    const sendButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Send invites",
    );
    expect(sendButton).toBeDefined();
    await act(async () => {
      sendButton?.click();
    });

    expect(onSendInvites).toHaveBeenCalledWith(["jane@example.com"]);
    expect(onSkip).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Generated invite links");
    expect(container.textContent).toContain("jane@example.com");
    expect(container.textContent).toContain("https://agentdash.local/invite/pcp_invite_test");
    expect(container.textContent).toContain("Email not sent");

    const copyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Copy invite link for jane@example.com",
    );
    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(clipboardWriteTextMock).toHaveBeenCalledWith("https://agentdash.local/invite/pcp_invite_test");
    expect(container.textContent).toContain("Copied");
  });
});
