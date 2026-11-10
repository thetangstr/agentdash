// @vitest-environment jsdom
//
// AgentDash admin powers (part 4): the admin audit page. Owners and admins
// only (the server's company:manage answer); nothing is offered while that is
// being checked; filters, "Load more" and "Export CSV" for the rest.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEvent } from "@paperclipai/shared";

const capability = vi.hoisted(() => ({ current: { allowed: true, isLoading: false } }));
const mockAuditApi = vi.hoisted(() => ({ list: vi.fn(), csvUrl: vi.fn() }));
vi.mock("@/hooks/useCapability", () => ({ useCapability: () => capability.current }));
vi.mock("@/api/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/audit")>();
  return { ...actual, auditApi: mockAuditApi };
});
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn(async () => [{ id: "agent-1", name: "Casper" }]) } }));
vi.mock("@/api/access", () => ({
  accessApi: { listUserDirectory: vi.fn(async () => ({ users: [{ principalId: "user-1", status: "active", user: { id: "user-1", name: "Ada", email: null, image: null } }] })) },
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Meridian" } }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));

const { auditQueryString } = await import("@/api/audit");
const { CompanyAudit } = await import("./CompanyAudit");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function event(id: string, action: string, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id,
    companyId: "company-1",
    actorType: "user",
    actorId: "user-1",
    action,
    entityType: "issue",
    entityId: `issue-${id}`,
    agentId: null,
    runId: null,
    details: null,
    createdAt: new Date("2026-11-01T12:00:00.000Z"),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  capability.current = { allowed: true, isLoading: false };
  mockAuditApi.csvUrl.mockImplementation((companyId: string, filters: object) => `/api/companies/${companyId}/audit.csv${auditQueryString(filters)}`);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CompanyAudit />
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
}

const byTestId = <T extends Element>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);

async function choose(id: string, value: string) {
  const el = byTestId<HTMLSelectElement | HTMLInputElement>(id)!;
  await act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  await flush();
  await flush();
}

describe("CompanyAudit", () => {
  it("offers nothing while company:manage is being checked", async () => {
    capability.current = { allowed: false, isLoading: true };
    await render();
    expect(byTestId("company-audit-loading")).not.toBeNull();
    expect(byTestId("company-audit-filters")).toBeNull();
    expect(byTestId("company-audit-export")).toBeNull();
    expect(mockAuditApi.list).not.toHaveBeenCalled();
  });

  it("tells someone without access, plainly, and never asks the server for rows", async () => {
    capability.current = { allowed: false, isLoading: false };
    await render();
    expect(byTestId("company-audit-no-access")?.textContent).toBe("Only owners and admins can see this.");
    expect(byTestId("company-audit-filters")).toBeNull();
    expect(mockAuditApi.list).not.toHaveBeenCalled();
  });

  it("shows the rows with names, loads more with the cursor, and says when nothing matches", async () => {
    mockAuditApi.list.mockImplementation(async (_companyId: string, _filters: object, cursor: string | null) =>
      cursor === "c1"
        ? { items: [event("3", "issue.created")], actorNames: { "user-1": "Ada" }, nextCursor: null }
        : {
            items: [
              event("1", "issue.updated", { details: { via: "assistant_grant g1 (Claude)" } }),
              event("2", "agent.paused", { actorType: "system", actorId: "system" }),
            ],
            actorNames: { "user-1": "Ada" },
            nextCursor: "c1",
          },
    );
    await render();
    expect(mockAuditApi.list).toHaveBeenCalledWith("company-1", { includeSystem: true, from: undefined, to: undefined }, null, 100);
    const rows = () => [...container.querySelectorAll("[data-testid='company-audit-row']")];
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.textContent).toContain("Ada");
    expect(rows()[0]!.textContent).toContain("assistant_grant g1 (Claude)");
    expect(rows()[1]!.textContent).toContain("The system");
    await act(async () => {
      byTestId<HTMLButtonElement>("company-audit-load-more")!.click();
    });
    await flush();
    await flush();
    expect(mockAuditApi.list).toHaveBeenLastCalledWith("company-1", expect.any(Object), "c1", 100);
    expect(rows()).toHaveLength(3);
    expect(byTestId("company-audit-load-more")).toBeNull();

    mockAuditApi.list.mockResolvedValue({ items: [], actorNames: {}, nextCursor: null });
    await choose("company-audit-action", "budget.*");
    expect(byTestId("company-audit-empty")?.textContent).toBe("Nothing matches these filters.");
  });

  it("filters by person, action and dates, and the export link carries the same filters", async () => {
    mockAuditApi.list.mockResolvedValue({ items: [event("1", "issue.updated")], actorNames: {}, nextCursor: null });
    await render();
    const person = byTestId<HTMLSelectElement>("company-audit-person")!;
    expect([...person.options].map((option) => option.textContent)).toEqual(["Everyone", "Ada", "Casper", "The system"]);
    const actions = [...byTestId<HTMLSelectElement>("company-audit-action")!.options].map((option) => option.value);
    expect(actions).toContain("issue.*");
    expect(actions).toContain("audit.exported");

    await choose("company-audit-person", "agent:agent-1");
    await choose("company-audit-action", "issue.*");
    await choose("company-audit-from", "2026-11-01");
    const last = mockAuditApi.list.mock.calls.at(-1)!;
    expect(last[1]).toMatchObject({ actorType: "agent", actorId: "agent-1", actions: ["issue.*"], includeSystem: true });
    expect(new Date(last[1].from).getTime()).toBe(new Date("2026-11-01T00:00:00").getTime());

    const href = byTestId<HTMLAnchorElement>("company-audit-export")!.getAttribute("href")!;
    expect(href.startsWith("/api/companies/company-1/audit.csv?")).toBe(true);
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("actorType")).toBe("agent");
    expect(params.get("actorId")).toBe("agent-1");
    expect(params.get("action")).toBe("issue.*");
    expect(params.get("from")).toBe(last[1].from);
    expect(byTestId("company-audit-export")!.hasAttribute("download")).toBe(true);
  });

  it("on a phone only the table scrolls sideways", async () => {
    mockAuditApi.list.mockResolvedValue({ items: [event("1", "issue.updated")], actorNames: {}, nextCursor: null });
    await render();
    const table = byTestId("company-audit-table")!;
    expect(table.className).toContain("overflow-x-auto");
    expect(byTestId("company-audit-page")!.className).toContain("min-w-0");
    expect(byTestId("company-audit-filters")!.className).toContain("flex-wrap");
  });
});
