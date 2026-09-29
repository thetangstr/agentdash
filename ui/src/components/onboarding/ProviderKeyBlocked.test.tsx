// @vitest-environment jsdom
// AgentDash (GH #794, UX-13): the shared "waiting for a model key" block.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";

const mockAdmins = vi.hoisted(() => vi.fn());
const mockRequest = vi.hoisted(() => vi.fn());

vi.mock("@/api/onboarding", () => ({
  onboardingApi: { modelKeyAdmins: mockAdmins, requestModelKey: mockRequest },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

import { ProviderKeyBlocked } from "./ProviderKeyBlocked";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const INSTANCE_ADMIN = { userId: "u1", name: "Asha Instance", email: "asha@x.test", membershipRole: "admin", canFix: true };
const COMPANY_ADMIN = { userId: "u2", name: "Bo Admin", email: "bo@x.test", membershipRole: "admin", canFix: false };

async function flush(ticks = 4) {
  for (let i = 0; i < ticks; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("ProviderKeyBlocked", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockAdmins.mockReset();
    mockRequest.mockReset();
    mockAdmins.mockResolvedValue({ admins: [] });
    mockRequest.mockResolvedValue({ results: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  async function render(props: Partial<Parameters<typeof ProviderKeyBlocked>[0]> = {}) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProviderKeyBlocked companyId="company-1" {...props} />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  it("names the admins who can fix it and links to the model-key settings", async () => {
    mockAdmins.mockResolvedValue({ admins: [INSTANCE_ADMIN] });
    await render();
    expect(container.textContent).toContain("Asha Instance");
    expect(container.querySelector('a[href="/company/settings/model-key"]')).not.toBeNull();
    expect(mockAdmins).toHaveBeenCalledWith("company-1");
  });

  it("prefers instance admins over company admins who cannot fix it", async () => {
    mockAdmins.mockResolvedValue({ admins: [COMPANY_ADMIN, INSTANCE_ADMIN] });
    await render();
    expect(container.textContent).toContain("Asha Instance");
    expect(container.textContent).not.toContain("Bo Admin");
  });

  it("falls back to company admins when nobody is an instance admin", async () => {
    mockAdmins.mockResolvedValue({ admins: [COMPANY_ADMIN] });
    await render();
    expect(container.textContent).toContain("Bo Admin");
  });

  it("shows a generic ask when the contact list is empty", async () => {
    await render();
    expect(container.textContent).toContain("Ask a workspace admin");
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Let them know");
    expect(button.disabled).toBe(true);
  });

  it("emails the admins on Let them know and confirms", async () => {
    mockAdmins.mockResolvedValue({ admins: [INSTANCE_ADMIN] });
    mockRequest.mockResolvedValue({ results: [{ name: "Asha Instance", status: "sent" }] });
    await render();
    const button = container.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(mockRequest).toHaveBeenCalledWith("company-1");
    expect(container.querySelector('[data-testid="provider-key-notified"]')?.textContent).toContain(
      "they've been emailed",
    );
  });

  it("is honest when the mailer is not configured (skipped, not sent)", async () => {
    mockAdmins.mockResolvedValue({ admins: [INSTANCE_ADMIN] });
    mockRequest.mockResolvedValue({ results: [{ name: "Asha Instance", status: "skipped" }] });
    await render();
    await act(async () => {
      container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("The email couldn't be sent");
    expect(container.textContent).not.toContain("they've been emailed");
  });

  it("tells the user to message them directly when nobody can be reached", async () => {
    mockAdmins.mockResolvedValue({ admins: [INSTANCE_ADMIN] });
    mockRequest.mockResolvedValue({ results: [] });
    await render();
    await act(async () => {
      container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("No one has an email address on file");
  });

  it("surfaces a failed request", async () => {
    mockAdmins.mockResolvedValue({ admins: [INSTANCE_ADMIN] });
    mockRequest.mockRejectedValue(new Error("boom"));
    await render();
    await act(async () => {
      container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not reach the server");
  });

  // UX-13 review: the server refuses repeat nudges inside the cooldown, and
  // the button has to look done rather than clickable-but-failing.
  it("disables the button and shows the server's message on a 429 cooldown", async () => {
    mockAdmins.mockResolvedValue({ admins: [INSTANCE_ADMIN] });
    mockRequest.mockRejectedValue(
      new ApiError("The people who can fix this have already been told — give them a little while.", 429, {
        details: { retryAfterSeconds: 600 },
      }),
    );
    await render();
    const button = container.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const after = container.querySelector("button")!;
    expect(after.disabled).toBe(true);
    expect(after.textContent).toBe("They've been told");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("already been told");
  });

  it("renders the Home link only when asked", async () => {
    await render({ homeHref: "/ACM/dashboard" });
    expect(container.querySelector('a[href="/ACM/dashboard"]')).not.toBeNull();
  });
});
