// @vitest-environment jsdom
// AgentDash (GH #790 review): a failed checkout must say *why* — a non-admin
// is told who can upgrade, an instance without Stripe is told billing is not
// configured, and everything else is a generic retry.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpgradeCheckoutButton } from "./UpgradeCheckoutButton";
import { ApiError } from "../api/client";

const mockStartCheckout = vi.hoisted(() => vi.fn());
vi.mock("../api/billing", () => ({
  billingApi: { startCheckout: mockStartCheckout },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function renderButton() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<UpgradeCheckoutButton companyId="c1" />);
  });
  return { container, root };
}

async function click(container: HTMLDivElement) {
  const button = container.querySelector("button")!;
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("UpgradeCheckoutButton", () => {
  const rendered: Array<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> = [];

  beforeEach(() => {
    mockStartCheckout.mockReset();
  });

  afterEach(() => {
    for (const r of rendered.splice(0)) {
      act(() => r.root.unmount());
      r.container.remove();
    }
  });

  it("tells a non-admin who can upgrade when checkout answers 403", async () => {
    mockStartCheckout.mockRejectedValue(new ApiError("Forbidden", 403, null));
    rendered.push(await renderButton());

    await click(rendered[0].container);

    const text = rendered[0].container.textContent!;
    expect(text).toContain("owner or admin");
    expect(text).not.toContain("try again");
  });

  it("says billing is not configured when checkout answers 503", async () => {
    mockStartCheckout.mockRejectedValue(new ApiError("Billing not configured", 503, null));
    rendered.push(await renderButton());

    await click(rendered[0].container);

    const text = rendered[0].container.textContent!;
    expect(text).toContain("Billing isn't turned on for this workspace.");
  });

  it("keeps the generic retry message for any other failure", async () => {
    mockStartCheckout.mockRejectedValue(new Error("network"));
    rendered.push(await renderButton());

    await click(rendered[0].container);

    expect(rendered[0].container.textContent!).toContain("try again");
  });
});
