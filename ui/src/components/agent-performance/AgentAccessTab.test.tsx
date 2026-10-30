// @vitest-environment jsdom
//
// Agent Performance Management gate 1: the Access tab groups what today's
// rules allow into See, Do, Talk and Spend, and shows Requested, Defined,
// Enforced, Working and Used for each item as text — never colour alone.
// Only the agent's accountable person, its steward and company admins may
// read it; everyone else gets the plain explanation.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAccessInventory, AgentAccessItem } from "@paperclipai/shared";
import { ApiError } from "../../api/client";

const mockApi = vi.hoisted(() => ({ profile: vi.fn(), access: vi.fn(), projection: vi.fn() }));
const mockActivity = vi.hoisted(() => ({ list: vi.fn(), forIssue: vi.fn(), runsForIssue: vi.fn(), issuesForRun: vi.fn() }));

vi.mock("../../api/agent-performance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-performance")>();
  return { ...actual, agentPerformanceApi: mockApi };
});
vi.mock("../../api/activity", () => ({ activityApi: mockActivity }));

const { AgentAccessTab, ACCESS_BANNER_TEXT, ACCESS_PROFILE_BANNER_TEXT, SHADOW_ITEM_TEXT, ENFORCED_REFUSED_TEXT, ENFORCED_ALLOWED_TEXT } = await import(
  "./AgentAccessTab"
);
const { RESTRICTED_VIEW_TEXT } = await import("./shared");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function item(overrides: Partial<AgentAccessItem> & Pick<AgentAccessItem, "id" | "dimension" | "label">): AgentAccessItem {
  return {
    requested: { state: "not_defined" },
    defined: { allowed: true, source: "company_boundary" },
    enforced: { state: "enforced" },
    working: { state: "not_applicable" },
    used: { state: "not_observed" },
    ...overrides,
  };
}

function inventory(overrides: Partial<AgentAccessInventory> = {}): AgentAccessInventory {
  return {
    kind: "agent_access_inventory",
    version: "agent-access/0",
    companyId: "company-1",
    agentId: "agent-1",
    agentName: "Ivy",
    generatedAt: "2026-10-29T12:00:00.000Z",
    window: { from: "2026-09-29T12:00:00.000Z", to: "2026-10-29T12:00:00.000Z" },
    profileDefined: false,
    enforcementMode: "off",
    items: [
      item({
        id: "see.projects.open",
        dimension: "see",
        label: "Read issues in every project that isn't restricted",
        target: { kind: "project", count: 4, label: "Unrestricted projects" },
        defined: {
          allowed: "unrestricted",
          source: "project_visibility",
          detail: "Restricted projects you can't see are not listed",
        },
        enforced: { state: "partial", note: "API reads only; run context and export are not checked" },
        used: { state: "used", uses: 12, lastAt: "2026-10-28T09:00:00.000Z" },
      }),
      item({
        id: "do.connection:conn-1.send",
        dimension: "do",
        label: "Send through HubSpot",
        target: { kind: "connection", id: "conn-1", label: "HubSpot" },
        defined: { allowed: true, source: "connector_autonomy", detail: "Every send files connector_send for approval" },
        enforced: { state: "enforced" },
        working: { state: "not_working", detail: "Connection is disconnected" },
        used: { state: "used_and_refused", uses: 1, refusals: 2 },
      }),
      item({
        id: "talk.agents.assign",
        dimension: "talk",
        label: "Assign work to other agents",
        target: { kind: "agent", count: 7, label: "All agents" },
        defined: { allowed: "unrestricted", source: "issue_assignment" },
        enforced: { state: "not_enforced" },
        used: { state: "refused", refusals: 3 },
      }),
    ],
    hostEnvironment: {
      adapterType: "claude_local",
      kind: "local_host",
      hostPermissionsRestricted: false,
      environmentId: null,
      detail: "Local machine, host permissions not restricted",
    },
    refusalsByCode: {
      "issue.agent_handoff_refused": 3,
      "connector_send.refused": 2,
      AGENT_CROSS_COMPANY: 1,
      SOME_FUTURE_CODE: 1,
    },
    alwaysReachable: [
      { kind: "user", id: "user-yang", label: "Yang", role: "accountable" },
      { kind: "user", id: "user-admin", label: "Avery", role: "admin" },
    ],
    gaps: [
      { code: "PROFILE_NOT_DEFINED", message: "No person has defined this agent's access yet." },
      { code: "WAKE_ANY_AGENT", message: "It can wake any agent in the company.", itemId: "talk.agents.assign" },
      { code: "HOST_UNRESTRICTED", message: "Host permissions are not restricted." },
    ],
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <AgentAccessTab companyId="company-1" agentId="agent-1" />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  mockApi.access.mockReset();
  mockActivity.list.mockReset();
});

describe("AgentAccessTab", () => {
  it("shows a loading state while the inventory is read", async () => {
    mockApi.access.mockReturnValue(new Promise(() => {}));
    const node = await render();
    expect(node.querySelector("[role='status']")?.textContent).toContain("Loading access");
  });

  it("groups items into See, Do, Talk and Spend under the not-yet-defined banner", async () => {
    mockApi.access.mockResolvedValue(inventory());
    const node = await render();

    expect(mockApi.access).toHaveBeenCalledWith("company-1", "agent-1");
    expect(node.querySelector("[role='note']")?.textContent).toContain(ACCESS_BANNER_TEXT);
    const headings = Array.from(node.querySelectorAll("h3")).map((h) => h.textContent?.trim());
    expect(headings).toEqual([
      "See",
      "Do",
      "Talk",
      "Spend",
      "What it used",
      "What was refused",
      "Execution environment",
      "Always reachable",
      "Gaps",
    ]);
    // No spend items in this fixture: the group says so rather than vanishing.
    expect(node.querySelector("[data-testid='agent-access-spend']")?.textContent).toContain("Nothing recorded in this group.");
  });

  it("states all five states for each item as text", async () => {
    mockApi.access.mockResolvedValue(inventory());
    const node = await render();
    const rows = Array.from(node.querySelectorAll("[data-testid='agent-access-item']"));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      for (const label of ["Requested:", "Defined:", "Enforced:", "Working:", "Used:"]) {
        expect(row.textContent).toContain(label);
      }
      expect(row.textContent).toContain("Requested: Not defined");
    }
    const [open, hubspot, assign] = rows.map((row) => row.textContent ?? "");
    expect(open).toContain("Defined: Unrestricted (project visibility)");
    expect(open).toContain("Enforced: Partly enforced");
    expect(open).toContain("API reads only; run context and export are not checked");
    expect(open).toContain("Defined: Restricted projects you can't see are not listed");
    expect(open).toContain("Used: Used 12 times");
    expect(open).toContain("Unrestricted projects (4)");
    expect(hubspot).toContain("Working: Not working");
    expect(hubspot).toContain("Connection is disconnected");
    expect(hubspot).toContain("Used: Used 1 time, refused 2 times");
    expect(assign).toContain("Enforced: Not enforced");
    expect(assign).toContain("Used: Refused 3 times");
  });

  it("lists what it used, what was refused, where it runs, who is reachable and the gaps", async () => {
    mockApi.access.mockResolvedValue(inventory());
    const node = await render();
    const usedBlock = node.querySelector("[data-testid='agent-access-used']")?.textContent ?? "";
    expect(usedBlock).toContain("Read issues in every project that isn't restricted: 12 times");
    expect(usedBlock).toContain("Send through HubSpot: 1 time");
    expect(usedBlock).not.toContain("Assign work to other agents");
    const refusedBlock = node.querySelector("[data-testid='agent-access-refused']")?.textContent ?? "";
    expect(refusedBlock).toContain("Refused attempts are attempts, not misconduct.");
    const byItem = node.querySelector("[data-testid='agent-access-refused-by-item']")?.textContent ?? "";
    expect(byItem).toContain("Assign work to other agents: 3 times");
    expect(byItem).toContain("Send through HubSpot: 2 times");
    // Refusals by code, most first, in plain words where the code is known and raw otherwise.
    const byCode = Array.from(
      node.querySelectorAll("[data-testid='agent-access-refused-by-code'] li"),
    ).map((li) => li.textContent);
    expect(byCode).toEqual([
      "A handoff to another agent was refused (issue.agent_handoff_refused): 3 times",
      "A connector send was refused (connector_send.refused): 2 times",
      "Tried to reach another company (AGENT_CROSS_COMPANY): 1 time",
      "SOME_FUTURE_CODE: 1 time",
    ]);
    expect(node.querySelector("[data-testid='agent-access-host-detail']")?.textContent).toBe(
      "Local machine, host permissions not restricted",
    );
    expect(node.textContent).toContain("Host permissionsNot restricted");
    const reachable = node.querySelector("[data-testid='agent-access-reachable']")?.textContent ?? "";
    expect(reachable).toContain("Yang · Accountable person");
    expect(reachable).toContain("Avery · Company admin");
    for (const code of ["PROFILE_NOT_DEFINED", "WAKE_ANY_AGENT", "HOST_UNRESTRICTED"]) {
      expect(node.textContent).toContain(code);
    }
  });

  it("says nothing was observed when the window has no use or refusals", async () => {
    mockApi.access.mockResolvedValue(
      inventory({
        items: [item({ id: "see.company", dimension: "see", label: "Stay inside the company" })],
        refusalsByCode: {},
      }),
    );
    const node = await render();
    expect(node.textContent).toContain("No use observed in this window.");
    expect(node.textContent).toContain("No refused attempts observed in this window.");
    expect(node.textContent).toContain("Used: Not observed");
  });

  it("explains who can see it when the server refuses (403)", async () => {
    mockApi.access.mockRejectedValue(new ApiError("Forbidden", 403, { error: "Forbidden" }));
    const node = await render();
    expect(node.textContent).toBe(RESTRICTED_VIEW_TEXT);
    expect(RESTRICTED_VIEW_TEXT).toBe(
      "Only the agent's accountable person, its steward and company admins can see this.",
    );
  });

  it("shows the server's message for any other failure", async () => {
    mockApi.access.mockRejectedValue(new ApiError("Agent not found", 404, { error: "Agent not found" }));
    const node = await render();
    const alert = node.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("Couldn't load this agent's access.");
    expect(alert?.textContent).toContain("Agent not found");
  });

  it("never reads the activity record, and shows no would-be refusals outside shadow mode", async () => {
    mockApi.access.mockResolvedValue(inventory());
    const node = await render();
    expect(mockActivity.list).not.toHaveBeenCalled();
    expect(node.querySelector("[data-testid='agent-access-would-refuse']")).toBeNull();
    expect(node.querySelector("[data-testid='agent-access-mode']")?.textContent).toContain(
      "Enforcement of person-defined access: off.",
    );
  });
});

describe("AgentAccessTab — gate 2 (profile-defined access)", () => {
  async function renderSettled() {
    const node = await render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return node;
  }

  function rowsByLabel(node: HTMLElement): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of Array.from(node.querySelectorAll("[data-testid='agent-access-item']"))) {
      const label = row.querySelector("p")?.textContent ?? "";
      out[label] = row.textContent ?? "";
    }
    return out;
  }

  function profileInventory(mode: AgentAccessInventory["enforcementMode"]): AgentAccessInventory {
    return inventory({
      profileDefined: true,
      enforcementMode: mode,
      items: [
        item({
          id: "see.projects.open",
          dimension: "see",
          label: "Read issues in every project that isn't restricted",
          requested: { state: "requested", revisionId: "rev-1" },
          defined: { allowed: "unrestricted", source: "project_visibility", v2: { allowed: true, rule: "see.projects:all" } },
        }),
        item({
          id: "talk.agents.assign",
          dimension: "talk",
          label: "Assign work to other agents",
          requested: { state: "not_requested", revisionId: "rev-1" },
          defined: { allowed: "unrestricted", source: "issue_assignment", v2: { allowed: false, rule: "talk.agents:reports_chain" } },
          enforced: { state: "not_enforced" },
        }),
        item({ id: "see.company", dimension: "see", label: "Stay inside the company" }),
      ],
      refusalsByCode: {},
    });
  }

  it("reads Requested from the active profile and names the mode", async () => {
    mockApi.access.mockResolvedValue(profileInventory("off"));
    const node = await renderSettled();
    expect(node.querySelector("[role='note']")?.textContent).toContain(ACCESS_PROFILE_BANNER_TEXT);
    const rows = rowsByLabel(node);
    const open = rows["Read issues in every project that isn't restricted"];
    expect(open).toContain("Requested: Requested");
    expect(open).toContain("Profile rule: Defined, not checked (enforcement off)");
    expect(open).toContain("Profile rule: allows this (see.projects:all)");
    expect(rows["Assign work to other agents"]).toContain("Requested: Not requested");
    // An item the profile says nothing about keeps the gate 1 reading and has no profile rule badge.
    expect(rows["Stay inside the company"]).toContain("Requested: Not defined");
    expect(rows["Stay inside the company"]).not.toContain("Profile rule");
  });

  it("in shadow mode reads 'Defined, not enforced' and lists would-be refusals from the inventory's shadow summary", async () => {
    mockApi.access.mockResolvedValue({
      ...profileInventory("shadow"),
      shadow: {
        wouldRefuseTotal: 3,
        byDimension: { "talk.agents": 2, "see.projects": 1 },
        recent: [
          { at: "2026-10-29T11:00:00.000Z", dimension: "talk.agents", rule: "talk.agents.reports_chain", site: "wake.dispatch", targetLabel: "Agent Rex" },
          { at: "2026-10-29T10:00:00.000Z", dimension: "see.projects", rule: null, site: null, targetLabel: null },
        ],
      },
    } satisfies AgentAccessInventory);
    const node = await renderSettled();
    // The summary rides on the inventory: no activity rows are fetched.
    expect(mockActivity.list).not.toHaveBeenCalled();
    expect(node.querySelector("[data-testid='agent-access-mode']")?.textContent).toContain(
      "shadow (checked and logged; nothing is refused)",
    );
    const rows = rowsByLabel(node);
    const assign = rows["Assign work to other agents"];
    expect(rows["Read issues in every project that isn't restricted"]).toContain(`Profile rule: ${SHADOW_ITEM_TEXT}`);
    expect(assign).toContain(`Profile rule: ${SHADOW_ITEM_TEXT}`);
    expect(assign).toContain("would refuse this once enforced (talk.agents:reports_chain)");
    // Shadow never reads as a refusal of today's access.
    expect(assign).toContain("Enforced: Not enforced");

    const section = node.querySelector("[data-testid='agent-access-would-refuse']")?.textContent ?? "";
    expect(section).toContain("Would be refused once enforced");
    expect(section).toContain("nothing is refused");
    const items = node.querySelector("[data-testid='agent-access-would-refuse-items']")?.textContent ?? "";
    expect(items).toContain("Assign work to other agents");
    expect(items).not.toContain("Read issues in every project");
    expect(node.querySelector("[data-testid='agent-access-would-refuse-total']")?.textContent).toBe("3 would-be refusals logged.");
    const byDimension = Array.from(
      node.querySelectorAll("[data-testid='agent-access-would-refuse-by-dimension'] li"),
    ).map((li) => li.textContent);
    expect(byDimension).toEqual(["talk.agents: 2 times", "see.projects: 1 time"]);
    const recent = node.querySelector("[data-testid='agent-access-would-refuse-recent']")?.textContent ?? "";
    expect(recent).toContain("talk.agents · rule talk.agents.reports_chain · Agent Rex");
    expect(recent).toContain("checked at wake.dispatch");
    const logged = node.querySelector("[data-testid='agent-access-would-refuse-logged']")?.textContent ?? "";
    expect(logged).toContain("The newest 2 of 3.");
  });

  it("in shadow mode says when nothing was logged in the window", async () => {
    mockApi.access.mockResolvedValue({ ...profileInventory("shadow"), shadow: { wouldRefuseTotal: 0, byDimension: {}, recent: [] } });
    const node = await renderSettled();
    expect(node.querySelector("[data-testid='agent-access-would-refuse-logged']")?.textContent).toContain("None logged in this window.");
    expect(mockActivity.list).not.toHaveBeenCalled();
  });

  // Gate 3 (P3.4/P3.5): enforce refuses what the profile's rules don't allow.
  it("in enforce mode reads 'Enforced' per item and lists the refused items with the refusals recorded", async () => {
    const base = profileInventory("enforce");
    mockApi.access.mockResolvedValue({
      ...base,
      items: base.items.map((entry) =>
        entry.id === "talk.agents.assign"
          ? { ...entry, used: { state: "refused", refusals: 2, lastAt: "2026-10-29T11:00:00.000Z" } }
          : entry,
      ),
      // The by-code tally counts every refusal; the enforced summary only those this viewer may see (P3.7).
      refusalsByCode: { ACCESS_POLICY_REFUSED: 3, AGENT_CROSS_COMPANY: 1 },
      shadow: { wouldRefuseTotal: 4, byDimension: { "talk.agents": 4 }, recent: [] },
      enforced: {
        refusedTotal: 2,
        recent: [
          { at: "2026-10-29T11:00:00.000Z", dimension: "talk.agents", rule: "talk.agents.reports_chain", site: "issue.assign", targetLabel: "Writer" },
          { at: "2026-10-29T10:00:00.000Z", dimension: "talk.agents", rule: "talk.agents.reports_chain", site: "wake.dispatch", targetLabel: null },
        ],
      },
    } satisfies AgentAccessInventory);
    const node = await renderSettled();
    expect(node.querySelector("[data-testid='agent-access-mode']")?.textContent).toContain(
      "enforce (anything the profile's rules don't allow is refused)",
    );
    const rows = rowsByLabel(node);
    expect(rows["Read issues in every project that isn't restricted"]).toContain(`Profile rule: ${ENFORCED_ALLOWED_TEXT}`);
    expect(rows["Assign work to other agents"]).toContain(`Profile rule: ${ENFORCED_REFUSED_TEXT}`);
    expect(rows["Assign work to other agents"]).toContain("Profile rule: refuses this (talk.agents:reports_chain)");
    // The shadow section is for shadow only.
    expect(node.querySelector("[data-testid='agent-access-would-refuse']")).toBeNull();

    const enforced = node.querySelector("[data-testid='agent-access-enforced']")?.textContent ?? "";
    expect(enforced).toContain("Refused under enforcement");
    expect(enforced).toContain("Its accountable person, steward and company admins stay reachable.");
    const refusedRows = Array.from(node.querySelectorAll("[data-testid='agent-access-enforced-row']")).map((li) => li.textContent);
    expect(refusedRows).toHaveLength(1);
    expect(refusedRows[0]).toContain("Assign work to other agents · rule talk.agents:reports_chain");
    expect(refusedRows[0]).toContain(`${ENFORCED_REFUSED_TEXT} · refused 2 times in this window`);
    expect(node.querySelector("[data-testid='agent-access-enforced-total']")?.textContent).toBe(
      "2 refusals by its access rules recorded in this window.",
    );
    const recent = Array.from(node.querySelectorAll("[data-testid='agent-access-enforced-recent'] li")).map((li) => li.textContent);
    expect(recent).toHaveLength(2);
    expect(recent[0]).toContain("talk.agents · rule talk.agents.reports_chain · Writer");
    expect(recent[0]).toContain("checked at issue.assign");
    expect(recent[1]).toContain("checked at wake.dispatch");
    expect(node.querySelector("[data-testid='agent-access-enforced-shadow-history']")?.textContent).toContain(
      "4 would-be refusals were logged in this window",
    );
    // The by-reason list words the enforced code too.
    expect(node.querySelector("[data-testid='agent-access-refused-by-code']")?.textContent).toContain(
      "Refused by its access rules (ACCESS_POLICY_REFUSED): 3 times",
    );
  });

  it("in enforce mode says when the profile's rules allow everything and nothing was refused", async () => {
    const base = profileInventory("enforce");
    mockApi.access.mockResolvedValue({
      ...base,
      items: base.items.filter((entry) => entry.id !== "talk.agents.assign"),
      shadow: { wouldRefuseTotal: 0, byDimension: {}, recent: [] },
      enforced: { refusedTotal: 0, recent: [] },
    });
    const node = await renderSettled();
    expect(node.querySelector("[data-testid='agent-access-enforced-items']")?.textContent).toContain(
      "The profile's rules allow every item above.",
    );
    expect(node.querySelector("[data-testid='agent-access-enforced-total']")?.textContent).toBe(
      "No refusals by its access rules recorded in this window.",
    );
    expect(node.querySelector("[data-testid='agent-access-enforced-recent']")).toBeNull();
    expect(node.querySelector("[data-testid='agent-access-enforced-shadow-history']")).toBeNull();
  });

  it("in enforce mode says so when the server sent no refusal summary, rather than a count", async () => {
    const base = profileInventory("enforce");
    mockApi.access.mockResolvedValue({ ...base, refusalsByCode: { ACCESS_POLICY_REFUSED: 5 }, enforced: null });
    const node = await renderSettled();
    expect(node.querySelector("[data-testid='agent-access-enforced-logged']")?.textContent).toContain(
      "The server sent no refusal summary for this window.",
    );
    expect(node.querySelector("[data-testid='agent-access-enforced-total']")).toBeNull();
  });
});
