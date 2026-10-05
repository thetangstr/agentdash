// @vitest-environment jsdom
// AgentDash (review-1028, items 6 + 11): the echoed hire card shows the
// tier+model the SERVER stamped on the payload — it never recomputes from
// shipped defaults, so env overrides and the opt-in/BYOK gate are honored.
// Unstamped payloads (older writes, tiers off, BYOK) render no model line.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalCard } from "./ProposalCard";
import type { ProposalPayload } from "@paperclipai/shared";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const basePayload: ProposalPayload = {
  name: "Ava",
  role: "Chief of Staff",
  oneLineOkr: "Keep the company moving",
  rationale: "A leader to coordinate the team.",
};

describe("ProposalCard", () => {
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

  it("renders the server-stamped tier+model in plain words", () => {
    act(() => {
      root.render(
        <ProposalCard
          payload={{
            ...basePayload,
            adapterType: "hermes_local",
            modelTier: "high",
            model: "qwen3.8-max",
          }}
          onConfirm={vi.fn()}
          onReject={vi.fn()}
        />,
      );
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Qwen 3.8 Max · high tier");
    expect(text).not.toContain("qwen3.8-max");
  });

  it("renders the stamped ops tier for a non-leadership hire", () => {
    act(() => {
      root.render(
        <ProposalCard
          payload={{
            ...basePayload,
            role: "engineer",
            adapterType: "hermes_local",
            modelTier: "low",
            model: "deepseek-v4.1-flash",
          }}
          onConfirm={vi.fn()}
          onReject={vi.fn()}
        />,
      );
    });
    expect(container.textContent ?? "").toContain("DeepSeek V4.1 Flash · ops tier");
  });

  it("shows no model line when the payload carries no stamp", () => {
    act(() => {
      root.render(
        <ProposalCard
          payload={{ ...basePayload, adapterType: "hermes_local" }}
          onConfirm={vi.fn()}
          onReject={vi.fn()}
        />,
      );
    });
    const text = container.textContent ?? "";
    expect(text).not.toContain("Model:");
    expect(text).not.toContain("tier");
  });

  it("shows no model line for a non-hermes adapter even when stamped", () => {
    act(() => {
      root.render(
        <ProposalCard
          payload={{
            ...basePayload,
            adapterType: "claude_local" as never,
            modelTier: "high",
            model: "qwen3.8-max",
          }}
          onConfirm={vi.fn()}
          onReject={vi.fn()}
        />,
      );
    });
    expect(container.textContent ?? "").not.toContain("Model:");
  });
});
