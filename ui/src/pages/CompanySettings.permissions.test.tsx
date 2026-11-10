// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Company settings are an owner/admin decision; the server refuses everyone
 * else. A member sees the settings read-only with one plain line, and no
 * archive, import or export control. The answer comes from `company:manage`, and while
 * it is loading the page shows neither state.
 */

const mockCapabilitiesApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/capabilities", () => ({ capabilitiesApi: mockCapabilitiesApi }));

const mockHealthApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/health", () => ({ healthApi: mockHealthApi }));

const mockCompaniesApi = vi.hoisted(() => ({ update: vi.fn(), archive: vi.fn() }));
vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));

vi.mock("../api/access", () => ({
  accessApi: { createOpenClawInvitePrompt: vi.fn(), getInviteOnboarding: vi.fn() },
}));
vi.mock("../api/assets", () => ({ assetsApi: { uploadCompanyLogo: vi.fn() } }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Meridian", issuePrefix: "MER", status: "active" }],
    selectedCompany: {
      id: "company-1",
      name: "Meridian",
      description: null,
      brandColor: "#123456",
      logoUrl: "/api/assets/logo/content",
      issuePrefix: "MER",
      status: "active",
    },
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// The cards below the fold ask their own servers; they are not under test here.
vi.mock("@/components/settings/NeedsReconciliationPanel", () => ({
  NeedsReconciliationPanel: () => null,
  useNeedsReconciliationCount: () => 0,
}));
// The Labels card asks its own server; it has its own suite.
vi.mock("@/components/settings/LabelsCard", () => ({ LabelsCard: () => null }));
vi.mock("@/components/settings/AgentCeilingEditor", () => ({ AgentCeilingEditor: () => null }));
vi.mock("@/components/settings/AgentAccessEnforcementCard", () => ({ AgentAccessEnforcementCard: () => null }));
vi.mock("@/components/settings/PerformanceManagerCard", () => ({ PerformanceManagerCard: () => null }));

vi.mock("@/lib/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/router")>();
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => (
      <a href={to} {...props}>{children}</a>
    ),
  };
});

const { CompanySettings } = await import("./CompanySettings");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const READ_ONLY_LINE = "Only owners and admins can change company settings.";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  mockHealthApi.get.mockResolvedValue({ status: "ok", hostedBox: false });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function capabilities(manage: boolean) {
  mockCapabilitiesApi.get.mockResolvedValue({
    companyId: "company-1",
    actorType: "board",
    membershipRole: manage ? "owner" : "member",
    isInstanceAdmin: false,
    capabilities: { "company:manage": manage, "users:invite": manage },
  });
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <CompanySettings />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 15; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function input(label: string) {
  return container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
}

function toggle(testId: string) {
  return container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
}

const EDITABLE_INPUTS = ["Workspace name", "Description", "Logo", "Brand color", "Brand color value", "Attachment size limit in MiB"];
const TOGGLES = [
  "company-settings-team-approval-toggle",
  "company-settings-issue-start-toggle",
  // Admin powers: the same rule (company:manage) as every other setting.
  "admin-powers-directive-read-toggle",
  "admin-powers-transcript-read-toggle",
  "admin-powers-assistant-batches-toggle",
];

describe("CompanySettings for a member", () => {
  it("shows the settings read-only with one plain line", async () => {
    capabilities(false);
    await render();

    expect(container.querySelector('[data-testid="company-settings-read-only"]')?.textContent).toBe(READ_ONLY_LINE);
    for (const label of EDITABLE_INPUTS) {
      const el = input(label);
      expect(el, label).not.toBeNull();
      expect(el!.disabled, label).toBe(true);
    }
    // The current values are still shown.
    expect(input("Workspace name")!.value).toBe("Meridian");
    for (const id of TOGGLES) expect(toggle(id)!.disabled, id).toBe(true);
    expect(mockCapabilitiesApi.get).toHaveBeenCalledWith("company-1");
  });

  it("hides archive, import, export and the logo and colour clear buttons", async () => {
    capabilities(false);
    await render();

    expect(container.querySelector('[data-testid="company-settings-danger-zone"]')).toBeNull();
    expect(container.textContent).not.toContain("Archive workspace");
    expect(container.querySelector('a[href="/company/import"]')).toBeNull();
    expect(container.querySelector('a[href="/company/export"]')).toBeNull();
    expect(container.querySelector('[data-testid="company-settings-packages"]')).toBeNull();
    expect(container.textContent).not.toContain("Remove logo");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Clear")).toBe(false);
    // The OpenClaw invite needs users:invite, which this member lacks.
    expect(container.querySelector('[data-testid="company-settings-invites-section"]')).toBeNull();
  });

  it("does not change a setting when a disabled toggle is clicked", async () => {
    capabilities(false);
    await render();
    await act(async () => {
      toggle("company-settings-issue-start-toggle")!.click();
    });
    expect(mockCompaniesApi.update).not.toHaveBeenCalled();
  });
});

describe("CompanySettings for an owner or admin", () => {
  it("is editable, with archive, import and export offered", async () => {
    capabilities(true);
    await render();

    expect(container.querySelector('[data-testid="company-settings-read-only"]')).toBeNull();
    for (const label of EDITABLE_INPUTS) expect(input(label)!.disabled, label).toBe(false);
    for (const id of TOGGLES) expect(toggle(id)!.disabled, id).toBe(false);
    expect(container.querySelector('[data-testid="company-settings-danger-zone"]')).not.toBeNull();
    expect(container.textContent).toContain("Archive workspace");
    expect(container.querySelector('a[href="/company/import"]')).not.toBeNull();
    expect(container.querySelector('a[href="/company/export"]')).not.toBeNull();
    expect(container.textContent).toContain("Remove logo");
    expect(container.querySelector('[data-testid="company-settings-invites-generate-button"]')).not.toBeNull();
  });
});

describe("CompanySettings while the answer is loading", () => {
  it("shows neither state: no read-only line, no destructive controls, nothing editable", async () => {
    mockCapabilitiesApi.get.mockReturnValue(new Promise(() => {}));
    await render();

    expect(container.querySelector('[data-testid="company-settings-read-only"]')).toBeNull();
    expect(container.querySelector('[data-testid="company-settings-danger-zone"]')).toBeNull();
    expect(container.querySelector('a[href="/company/import"]')).toBeNull();
    expect(container.querySelector('a[href="/company/export"]')).toBeNull();
    expect(input("Workspace name")!.disabled).toBe(true);
  });
});
