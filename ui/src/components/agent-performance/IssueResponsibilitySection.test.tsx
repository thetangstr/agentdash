// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";

const api = vi.hoisted(() => ({ get: vi.fn(), map: vi.fn(), profile: vi.fn(), revision: vi.fn() }));
vi.mock("@/api/agent-profiles", () => ({ issueResponsibilityApi: api, agentProfilesApi: { revision: api.revision } }));
vi.mock("@/api/agent-performance", () => ({ agentPerformanceApi: { profile: api.profile }, agentPerformanceQueryKeys: { profile: (c: string, a: string) => ["profile", c, a] } }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a> }));
const { IssueResponsibilitySection } = await import("./IssueResponsibilitySection");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
let node: HTMLDivElement;
let queryClient: QueryClient;
const current = { id: "map-1", agentId: "agent-1", responsibilityKey: "report", profileRevisionId: "rev-old" };
const responsibility = { key: "report", title: "Weekly report", performance: { criteria: [{ id: "quality", text: "Current criterion", check: { kind: "record", record: "harness.criterion_passed" } }] } };
beforeEach(() => {
  api.get.mockResolvedValue({ current: null, history: [], viewer: { assigneeAgentId: "agent-1", canMapAssignee: true } });
  api.profile.mockResolvedValue({ active: { id: "rev-new", revisionNumber: 2, body: { responsibilities: [responsibility] } } });
  api.revision.mockResolvedValue({ id: "rev-old", revisionNumber: 1, body: { responsibilities: [{ ...responsibility, performance: { criteria: [{ id: "quality", text: "Historical criterion" }] } }] } });
  api.map.mockImplementation(async () => {
    api.get.mockResolvedValue({ current, history: [current], viewer: { assigneeAgentId: "agent-1", canMapAssignee: true } });
    return current;
  });
});
afterEach(() => { if (root) act(() => root.unmount()); node?.remove(); vi.resetAllMocks(); });
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
async function render(assigneeAgentId: string | null = "agent-1") {
  node = document.createElement("div"); document.body.appendChild(node); root = createRoot(node);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => { root.render(<QueryClientProvider client={queryClient}><IssueResponsibilitySection companyId="company-1" issueId="issue-1" assigneeAgentId={assigneeAgentId} /></QueryClientProvider>); });
  await flush(); await flush(); await flush();
}
function button(text: string) { return [...node.querySelectorAll("button")].find((el) => el.textContent === text)!; }
it("maps the selected active responsibility and distinguishes retained historical mapping criteria", async () => {
  await render();
  expect(node.textContent).toContain("Unmapped");
  const select = node.querySelector("select")!;
  await act(async () => { select.value = "report"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => button("Map responsibility").click());
  await flush(); await flush();
  expect(api.map).toHaveBeenCalledWith("company-1", "issue-1", { agentId: "agent-1", responsibilityKey: "report" });
  expect(node.textContent).toContain("Recorded mapping revision");
  expect(node.textContent).toContain("rev-old");
  expect(node.textContent).toContain("Current active revision 2");
  expect(node.textContent).toContain("Historical criterion");
  expect(node.textContent).toContain("Current criterion");
  expect(node.querySelector('a[href="/agents/agent-1/profile"]')).not.toBeNull();
  expect(node.textContent).toContain("Acceptance requires separate evidence");
});
it("keeps read-only mappings visible and provides no mapping action when the server refuses authority", async () => {
  api.get.mockResolvedValue({ current, history: [current], viewer: { assigneeAgentId: "agent-1", canMapAssignee: false } });
  await render();
  expect(node.textContent).toContain("permission to map");
  expect(node.querySelector("select")).toBeNull();
  expect(button("Map responsibility")).toBeUndefined();
  expect(api.map).not.toHaveBeenCalled();
});
it("shows no-agent and no-active-profile states without offering a mapping", async () => {
  api.get.mockResolvedValue({ current: null, history: [], viewer: { assigneeAgentId: null, canMapAssignee: false } });
  await render(null);
  expect(node.textContent).toContain("Assign an agent");
  expect(api.profile).not.toHaveBeenCalled();
});
it("shows a no-active-profile state", async () => {
  api.profile.mockResolvedValue({ active: null });
  await render();
  expect(node.textContent).toContain("No active operating profile");
  expect(button("Map responsibility")).toBeUndefined();
});
it("surfaces revoked authority and stale key failures while retaining the selection", async () => {
  api.map.mockRejectedValue(new ApiError("Forbidden", 403, null));
  await render();
  const select = node.querySelector("select")!;
  await act(async () => { select.value = "report"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => button("Map responsibility").click());
  await flush();
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("permission");
  expect(api.map).toHaveBeenCalledTimes(1);
});
it("does not fetch profile choices when the mapping itself is forbidden", async () => {
  api.get.mockRejectedValue(new ApiError("Forbidden", 403, null));
  await render();
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("permission");
  expect(api.profile).not.toHaveBeenCalled();
  expect(node.querySelector("select")).toBeNull();
});

it("hides stale cached profile choices after permission is revoked", async () => {
  await render();
  expect(node.querySelector("select")).not.toBeNull();
  api.profile.mockRejectedValue(new ApiError("Forbidden", 403, null));
  await act(async () => { await queryClient.invalidateQueries({ queryKey: ["profile", "company-1", "agent-1"] }); });
  await flush();
  expect(node.querySelector("select")).toBeNull();
  expect(node.textContent).not.toContain("Current criterion");
  expect(node.querySelector('[role="alert"]')?.textContent).toContain("permission");
});
it("refreshes stale responsibility choices after the server refuses a removed key", async () => {
  await render();
  const select = node.querySelector("select")!;
  await act(async () => { select.value = "report"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  api.map.mockRejectedValue(new ApiError("Unknown responsibility", 422, null));
  api.profile.mockResolvedValue({ active: { id: "rev-newer", revisionNumber: 3, body: { responsibilities: [] } } });
  await act(async () => button("Map responsibility").click());
  await flush(); await flush();
  expect(node.textContent).toContain("absent from the current active profile");
  expect(button("Map responsibility").disabled).toBe(true);
  expect(node.textContent).toContain("Current active revision 3");
});

it("shows scoped mapping history with keys, revisions and interval timestamps", async () => {
  api.get.mockResolvedValue({ current, history: [{ ...current, id: "map-older", responsibilityKey: "prior-duty", profileRevisionId: "rev-previous", validFrom: "2026-11-01T12:00:00Z", validTo: "2026-11-02T12:00:00Z" }, { ...current, validFrom: "2026-11-02T12:00:00Z", validTo: null }], viewer: { assigneeAgentId: "agent-1", canMapAssignee: true } });
  await render();
  const history = node.querySelector('[data-testid="issue-responsibility-history"]');
  expect(history?.textContent).toContain("prior-duty");
  expect(history?.textContent).toContain("rev-previous");
  expect(history?.textContent).toContain("2026-11-01T12:00:00Z");
  expect(history?.textContent).toContain("Current interval");
});

it("uses the server's unassigned state when the task prop is stale", async () => {
  api.get.mockResolvedValue({ current: null, history: [], viewer: { assigneeAgentId: null, canMapAssignee: false } });
  await render("agent-1");
  expect(node.textContent).toContain("Assign an agent");
  expect(api.profile).not.toHaveBeenCalled();
});
