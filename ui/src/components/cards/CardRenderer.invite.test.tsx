// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardRenderer } from "./index";

/**
 * The onboarding invite card sends through POST /onboarding/invites, which
 * needs `users:invite`. A viewer the server would refuse gets no send handler,
 * and then no card: a control that 403s reads as a broken product.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

const payload = { companyId: "company-1", conversationId: "conv-1" };

describe("CardRenderer invite_prompt_v1", () => {
  it("renders the invite card when the viewer may invite", () => {
    act(() => {
      root.render(<CardRenderer cardKind="invite_prompt_v1" payload={payload} context={{ onInviteSend: vi.fn() }} />);
    });
    expect(container.textContent).toContain("Want to bring anyone else in?");
    expect(container.textContent).toContain("Send invites");
  });

  it("renders nothing when the viewer has no send handler", () => {
    act(() => {
      root.render(<CardRenderer cardKind="invite_prompt_v1" payload={payload} context={{}} />);
    });
    expect(container.textContent).toBe("");
  });
});
