// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalPayloadRenderer, approvalLabel, HireAgentPayload } from "./ApprovalPayload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Approval: Reply with an ASCII frog");
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
            recommendedAction: "Approve the frog reply.",
            nextActionOnApproval: "Post the frog comment on the issue.",
            risks: ["The frog might be too powerful."],
            proposedComment: "(o)<",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("shows the hire's model in plain words for a hermes_local payload", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="hire_agent"
          payload={{
            name: "Ava",
            role: "chief_of_staff",
            title: "Chief of Staff",
            adapterType: "hermes_local",
            adapterConfig: { model: "qwen3.8-max-0902", provider: "alibaba-token-plan-cn" },
            metadata: { modelTier: "high" },
          }}
        />,
      );
    });
    expect(container.textContent).toContain("Qwen 3.8 Max · high tier");
    expect(container.textContent).not.toContain("qwen3.8-max-0902");
    act(() => { root.unmount(); });
  });

  it("names the tier a modelless hermes_local hire will get", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <HireAgentPayload
          payload={{ name: "Bex", role: "engineer", adapterType: "hermes_local" }}
        />,
      );
    });
    expect(container.textContent).toContain("DeepSeek V4.1 Flash · ops tier");
    act(() => { root.unmount(); });
  });

  it("shows no model line for a non-hermes adapter", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <HireAgentPayload
          payload={{ name: "Claude", role: "engineer", adapterType: "claude_local" }}
        />,
      );
    });
    expect(container.textContent).not.toContain("Model");
    act(() => { root.unmount(); });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          hidePrimaryTitle
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });
});
