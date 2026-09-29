// @vitest-environment jsdom
// AgentDash (GH #790): the cap walls carry an upgrade action, not dead text.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStartCheckout = vi.hoisted(() => vi.fn());
vi.mock("../api/billing", () => ({
  billingApi: { startCheckout: mockStartCheckout, status: vi.fn(), openPortal: vi.fn() },
}));

import { UpgradePromptCard } from "./UpgradePromptCard";
import { RunQuotaUpgrade } from "./RunQuotaUpgrade";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("UpgradePromptCard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const realLocation = window.location;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockStartCheckout.mockReset();
    mockStartCheckout.mockResolvedValue({ url: "https://checkout.example/session" });
    Object.defineProperty(window, "location", {
      value: { ...realLocation, href: "" },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Object.defineProperty(window, "location", { value: realLocation, writable: true, configurable: true });
  });

  it.each([
    ["seat_cap_exceeded", "Free workspaces are limited to 1 user."],
    ["agent_cap_exceeded", "Free workspaces include only the Chief of Staff."],
  ] as const)("shows the %s message with the trial button", (reason, message) => {
    act(() => {
      root.render(<UpgradePromptCard reason={reason} companyId="c1" />);
    });
    expect(container.textContent).toContain(message);
    const button = container.querySelector("button")!;
    expect(button.textContent).toContain("Start 14-day Pro trial, no card");
  });

  it("opens checkout for the company on click", async () => {
    act(() => {
      root.render(<UpgradePromptCard reason="seat_cap_exceeded" companyId="c9" />);
    });
    const button = container.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockStartCheckout).toHaveBeenCalledWith("c9");
    expect(window.location.href).toBe("https://checkout.example/session");
  });

  it("shows a retry hint when checkout fails", async () => {
    mockStartCheckout.mockRejectedValue(new Error("no stripe"));
    act(() => {
      root.render(<UpgradePromptCard reason="agent_cap_exceeded" companyId="c1" />);
    });
    const button = container.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("Could not open checkout");
  });
});

describe("RunQuotaUpgrade", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockStartCheckout.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the upgrade action for a quota_exceeded run", () => {
    act(() => {
      root.render(<RunQuotaUpgrade run={{ errorCode: "quota_exceeded", companyId: "c2" }} />);
    });
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button!.textContent).toContain("Start 14-day Pro trial, no card");
  });

  it.each(["cancelled", "adapter_failed", null])("renders nothing for errorCode %s", (errorCode) => {
    act(() => {
      root.render(<RunQuotaUpgrade run={{ errorCode, companyId: "c2" }} />);
    });
    expect(container.querySelector("button")).toBeNull();
  });
});
