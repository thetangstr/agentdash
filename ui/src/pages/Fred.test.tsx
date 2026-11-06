// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { FredWorkspace } from "./Fred";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, disableIssueQuicklook: _quicklook, ...props }: { to: string; children: ReactNode; disableIssueQuicklook?: boolean }) => <a href={to} {...props}>{children}</a>,
}));

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let requests: Array<{ url: string; method: string; body: any }>;
let workspace: any;
let failure: string | null;
let getFailure: string | null;
let holdBrief: boolean;
let releaseBrief: (() => void) | null;

function fresh(companyId = "one") {
  return { companyId, registration: null, agent: null, issue: null, brief: null, canConfigure: true, startBlocker: "Set up Fred first.", latestRun: null };
}
function ready() {
  return {
    ...fresh(),
    registration: { id: "registration-one", agentId: "fred-one", mainIssueId: "job-one", ownerUserId: "owner-one", state: "ready", mandateVersion: "fred-v1", startedAt: null },
    agent: { id: "fred-one", name: "Fred", status: "idle", adapterType: "claude_local", budgetMonthlyCents: 1000, spentMonthlyCents: 0 },
    issue: { id: "job-one", identifier: "ONE-1", title: "Discover one useful agent job", status: "backlog" },
    brief: { revision: 1, goal: "Reduce proposal preparation", firstJob: "Draft a proposal brief", successCriteria: ["Cite each shared source"], baseline: "Not measured", target: "Agree after first job", outcomeWindow: "Review after the first job", boundaries: "No external messages", documentRevisionId: "doc-revision-one" },
    startBlocker: null,
  };
}
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
function render(companyId = "one") {
  act(() => root.render(<QueryClientProvider client={client}><FredWorkspace key={companyId} companyId={companyId} /></QueryClientProvider>));
}
function button(label: string) { return [...host.querySelectorAll("button")].find(element => element.textContent === label) as HTMLButtonElement; }
async function click(label: string) { const element = button(label); expect(element, label).toBeTruthy(); await act(async () => element.click()); await flush(); }
async function field(label: string, value: string) {
  const element = host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  expect(element, label).toBeTruthy();
  await act(async () => {
    const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : element.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function consent(label: string) {
  const element = host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  expect(element).toBeTruthy(); await act(async () => element.click());
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  requests = []; workspace = fresh(); failure = null; getFailure = null; holdBrief = false; releaseBrief = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : null;
    requests.push({ url, method, body });
    if (method === "PUT" && holdBrief) await new Promise<void>(resolve => { releaseBrief = resolve; });
    if ((method === "GET" && getFailure) || (method !== "GET" && failure)) return new Response(JSON.stringify({ error: getFailure ?? failure }), { status: 409 });
    if (method === "POST" && url.endsWith("/setup")) workspace = { ...ready(), agent: { ...ready().agent, adapterType: body.adapterType, budgetMonthlyCents: body.budgetMonthlyCents } };
    if (method === "PUT" && url.endsWith("/brief")) workspace = { ...workspace, brief: { ...body, revision: body.expectedRevision + 1, documentRevisionId: "doc-revision-two" } };
    if (method === "POST" && url.endsWith("/start")) workspace = { ...workspace, registration: { ...workspace.registration, startedAt: "2026-11-05T20:00:00Z" }, issue: { ...workspace.issue, status: "todo" }, latestRun: { id: "run-one", status: "queued", error: null } };
    return new Response(JSON.stringify(url.includes("/two/") ? fresh("two") : workspace), { headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });

it("loads Fred without provisioning, starting or probing a model", async () => {
  render(); await flush(); await flush();
  expect(host.textContent).toContain("Meet Fred");
  expect(host.textContent).toContain("Company-shared");
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every(request => request.method === "GET")).toBe(true);
  expect(button("Set up Fred").disabled).toBe(true);
  expect(host.textContent).toContain("No work has started");
});
it("lets an owner explicitly resume interrupted materialization without creating a new identity on page load", async () => {
  workspace = { ...ready(), registration: { ...ready().registration, state: "materializing" }, brief: null, agent: { ...ready().agent, status: "paused" }, startBlocker: "Setup was interrupted." };
  render(); await flush(); await flush();
  expect(requests.every(request => request.method === "GET")).toBe(true);
  expect(button("Repair Fred’s setup")).toBeTruthy();
  expect(host.textContent).not.toContain("No brief saved yet");
  await consent("Share Fred’s brief and discovery thread with this company");
  await click("Repair Fred’s setup");
  expect(requests.filter(request => request.url.endsWith("/setup"))).toHaveLength(1);
  expect(requests.some(request => request.url.endsWith("/start"))).toBe(false);
});
it("requires explicit sharing and a positive budget before setup, then does not start discovery", async () => {
  render(); await flush(); await flush();
  await field("Monthly model budget in dollars", "0");
  await consent("Share Fred’s brief and discovery thread with this company");
  expect(button("Set up Fred").disabled).toBe(true);
  await field("Monthly model budget in dollars", "12.50");
  await field("Fred runtime", "codex_local");
  await click("Set up Fred");
  expect(requests.find(request => request.method === "POST")?.body).toEqual({ adapterType: "codex_local", budgetMonthlyCents: 1250, shareWithCompany: true });
  expect(requests.some(request => request.url.endsWith("/start"))).toBe(false);
  expect(host.textContent).toContain("Ready for discovery");
});
it("saves a revision-bound brief separately from an explicit Start discovery request", async () => {
  workspace = ready(); render(); await flush(); await flush();
  await field("Customer goal", "Reduce research handoff time");
  expect(button("Start discovery").disabled).toBe(true);
  await consent("Confirm this adoption brief is company-shared");
  await click("Save adoption brief");
  expect(requests.find(request => request.method === "PUT")?.body).toMatchObject({ expectedRevision: 1, goal: "Reduce research handoff time", shareWithCompany: true, successCriteria: ["Cite each shared source"] });
  expect(requests.some(request => request.url.endsWith("/start"))).toBe(false);
  await click("Start discovery");
  expect(requests.find(request => request.url.endsWith("/start"))?.body).toEqual({ expectedRevision: 2, registrationId: "registration-one" });
  expect(host.textContent).toContain("Discovery queued");
  expect(host.textContent).toContain("Queued");
});
it("keeps native job, profile, workforce and evaluation links, without inventing acceptance or ROI", async () => {
  workspace = { ...ready(), latestRun: { id: "run-one", status: "succeeded", error: null }, registration: { ...ready().registration, startedAt: "2026-11-05T20:00:00Z" } };
  render(); await flush(); await flush();
  expect(host.querySelector('a[href="/issues/job-one"]')).toBeTruthy();
  expect(host.querySelector('a[href="/agents/fred-one/profile"]')).toBeTruthy();
  expect(host.querySelector('a[href="/workforce"]')).toBeTruthy();
  expect(host.querySelector('a[href="/evaluation"]')).toBeTruthy();
  expect(host.textContent).toContain("Run finished");
  expect(host.textContent).toContain("Acceptance is not recorded here");
  expect(host.textContent).toContain("Business outcome: not measured");
  expect(host.textContent).not.toContain("ROI achieved");
});
it("waits for a brief save to commit before allowing discovery, even when its text did not change", async () => {
  workspace = ready(); render(); await flush(); await flush();
  expect(button("Start discovery").disabled).toBe(false);
  holdBrief = true;
  await consent("Confirm this adoption brief is company-shared");
  await click("Save adoption brief");
  expect(button("Start discovery").disabled).toBe(true);
  expect(requests.some(request => request.url.endsWith("/start"))).toBe(false);
  await act(async () => releaseBrief?.()); await flush();
  expect(button("Start discovery").disabled).toBe(false);
});
it.each(["paused", "terminated", "pending_approval"])("does not start a %s Fred even if a server blocker is missing", async status => {
  workspace = { ...ready(), agent: { ...ready().agent, status } };
  render(); await flush(); await flush();
  expect(button("Start discovery").disabled).toBe(true);
  expect(host.textContent).toContain(status === "pending_approval" ? "Awaiting approval" : status === "paused" ? "Paused" : "Terminated");
});
it("surfaces a legitimate approval block as waiting, not completed work or a platform error", async () => {
  workspace = { ...ready(), startBlocker: "An owner must approve Fred’s setup before work can start." };
  render(); await flush(); await flush();
  expect(button("Start discovery").disabled).toBe(true);
  expect(host.textContent).toContain("An owner must approve Fred’s setup");
  expect(host.textContent).not.toContain("Platform error");
  expect(host.textContent).not.toContain("Discovery started");
});
it("offers materialization repair without creating an automatic job", async () => {
  workspace = { ...ready(), registration: { ...ready().registration, state: "repair_needed" }, startBlocker: "Fred’s instructions need repair." };
  render(); await flush(); await flush();
  expect(button("Repair Fred’s setup")).toBeTruthy();
  expect(button("Start discovery").disabled).toBe(true);
  expect(requests.every(request => request.method === "GET")).toBe(true);
});
it("preserves an edited brief and surfaces a stale-revision refusal", async () => {
  workspace = ready(); render(); await flush(); await flush();
  await field("Customer goal", "Do not lose this goal");
  await consent("Confirm this adoption brief is company-shared");
  failure = "Adoption brief changed; reload before saving.";
  await click("Save adoption brief");
  expect(host.textContent).toContain(failure);
  expect((host.querySelector('[aria-label="Customer goal"]') as HTMLTextAreaElement).value).toBe("Do not lose this goal");
  expect(button("Start discovery").disabled).toBe(true);
});
it("clears company drafts and prevents old data from flashing on company switch", async () => {
  workspace = ready(); render(); await flush(); await flush();
  await field("Customer goal", "Unsaved sensitive draft");
  render("two"); await flush(); await flush();
  expect(host.innerHTML).not.toContain("Unsaved sensitive draft");
  expect(host.querySelector('a[href="/issues/job-one"]')).toBeNull();
  expect(host.textContent).toContain("Meet Fred");
});
it("shows fetch errors and a human-only setup explanation without trying another company", async () => {
  getFailure = "This company is unavailable"; render(); await flush(); await flush();
  expect(host.textContent).toContain("This company is unavailable");
  expect(requests.every(request => request.url.includes("/companies/one/fred"))).toBe(true);
  expect(requests.every(request => request.method === "GET")).toBe(true);
  client.clear(); getFailure = null; workspace = { ...fresh(), canConfigure: false };
  render(); await flush(); await flush();
  expect(host.textContent).toContain("An owner or admin sets up Fred");
  expect(host.querySelector('[data-testid="fred-setup"]')).toBeNull();
});

it("lets the owner retry the same saved discovery request after submission failed before any run", async () => {
  workspace = ready(); render(); await flush(); await flush();
  failure = "Discovery submission was unavailable";
  await click("Start discovery");
  workspace = { ...ready(), registration: { ...ready().registration, startedAt: "2026-11-06T16:00:00Z" }, issue: { ...ready().issue, status: "todo" } };
  failure = null;
  await click("Reload discovery state");
  expect(requests.filter(request => request.url.endsWith("/start"))).toHaveLength(1);
  expect(button("Retry discovery request").disabled).toBe(false);
  await click("Retry discovery request");
  const starts = requests.filter(request => request.url.endsWith("/start"));
  expect(starts).toHaveLength(2);
  expect(starts[1].body).toEqual(starts[0].body);
  expect(button("Retry discovery request")).toBeUndefined();
  expect(host.textContent).toContain("Discovery queued");
});
it("never offers request retry after native execution has been recorded", async () => {
  workspace = { ...ready(), registration: { ...ready().registration, startedAt: "2026-11-06T16:00:00Z" }, latestRun: { id: "already-recorded", status: "failed", error: "Inspect the native receipt" }, startBlocker: "Continue in the native work thread." };
  render(); await flush(); await flush();
  expect(button("Retry discovery request")).toBeUndefined();
  expect(requests.every(request => request.method === "GET")).toBe(true);
});
