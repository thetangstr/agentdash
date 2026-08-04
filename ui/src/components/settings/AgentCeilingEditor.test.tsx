// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_POLICY_CEILING_EXCEEDED,
  type AgentGovernancePolicy,
  collectCeilingViolations,
} from "@paperclipai/shared";
import { ApiError } from "../../api/client";
import type { AgentGovernanceRecord } from "../../api/agent-governance";

const mockAccessApi = vi.hoisted(() => ({ listMembers: vi.fn() }));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockGovernanceApi = vi.hoisted(() => ({ get: vi.fn(), updateCeiling: vi.fn() }));

vi.mock("../../api/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/access")>();
  return { ...actual, accessApi: mockAccessApi };
});
vi.mock("../../api/agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agents")>();
  return { ...actual, agentsApi: mockAgentsApi };
});
vi.mock("../../api/agent-governance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-governance")>();
  return { ...actual, agentGovernanceApi: mockGovernanceApi };
});

const { AgentCeilingEditor } = await import("./AgentCeilingEditor");

// A ceiling that constrains every dimension class so an over-ceiling value is
// expressible for each one (list overflow, budget, destructive rank, approval rank).
const CEILING: AgentGovernancePolicy = {
  permissions: ["read"],
  monthlyBudgetCents: 10_000,
  destructiveActions: "approval_required",
  dataScopes: ["crm"],
  providers: ["hubspot"],
  minimumApproval: "steward",
};

function makeRecord(overrides: Partial<AgentGovernanceRecord> = {}): AgentGovernanceRecord {
  return {
    id: "policy-1",
    companyId: "company-1",
    agentId: "agent-1",
    ownerCeiling: CEILING,
    stewardRequest: CEILING,
    effectivePolicy: CEILING,
    revision: 4,
    ownerCeilingUpdatedByUserId: null,
    stewardRequestUpdatedByUserId: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

/** Build the exact body the real route returns for an over-ceiling submission. */
function ceilingErrorBody(requested: AgentGovernancePolicy) {
  const violations = collectCeilingViolations(CEILING, requested);
  return {
    error: "Requested agent configuration exceeds the owner ceiling",
    details: { code: AGENT_POLICY_CEILING_EXCEEDED, violations },
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <AgentCeilingEditor companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function findButton(pattern: RegExp): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    pattern.test(button.textContent ?? ""),
  );
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

function setInput(selector: string, value: string) {
  const el = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
  if (!el) throw new Error(`no field for ${selector}`);
  const proto =
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(
    new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

/** Pick the only agent so the governance query runs and the editor renders. */
async function selectAgent() {
  setInput('[aria-label="Ceiling agent"]', "agent-1");
  await settle();
}

describe("AgentCeilingEditor", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    mockAccessApi.listMembers.mockResolvedValue({
      members: [],
      access: { canManageAgents: true },
    });
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-1", name: "Marketing Agent", role: "marketing", status: "idle" },
    ]);
    mockGovernanceApi.get.mockResolvedValue({ policy: makeRecord() });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("exposes an input for every one of the six ceiling dimensions", async () => {
    await render();
    await selectAgent();

    for (const label of [
      "Allowed permissions",
      "Maximum monthly budget",
      "Destructive actions",
      "Allowed data scopes",
      "Allowed providers",
      "Minimum approval",
    ]) {
      expect(
        container.querySelector(`[aria-label="${label}"]`),
        `no field for ${label}`,
      ).not.toBeNull();
    }
  });

  it("round-trips all six dimensions — including dataScopes and providers — through updateCeiling", async () => {
    mockGovernanceApi.updateCeiling.mockResolvedValue({
      policy: makeRecord({ revision: 5 }),
    });

    await render();
    await selectAgent();

    setInput('[aria-label="Allowed permissions"]', "read, write");
    setInput('[aria-label="Maximum monthly budget"]', "20000");
    setInput('[aria-label="Destructive actions"]', "allowed");
    setInput('[aria-label="Allowed data scopes"]', "crm, marketing");
    setInput('[aria-label="Allowed providers"]', "hubspot, salesforce");
    setInput('[aria-label="Minimum approval"]', "none");

    await click(findButton(/save ceiling/i)!);

    expect(mockGovernanceApi.updateCeiling).toHaveBeenCalledWith("company-1", "agent-1", {
      policy: {
        permissions: ["read", "write"],
        monthlyBudgetCents: 20_000,
        destructiveActions: "allowed",
        dataScopes: ["crm", "marketing"],
        providers: ["hubspot", "salesforce"],
        minimumApproval: "none",
      },
      revision: 4,
    });
  });

  it("carries the '*' wildcard through the two new list dimensions", async () => {
    mockGovernanceApi.updateCeiling.mockResolvedValue({ policy: makeRecord({ revision: 5 }) });

    await render();
    await selectAgent();

    setInput('[aria-label="Allowed data scopes"]', "*");
    setInput('[aria-label="Allowed providers"]', "*");
    await click(findButton(/save ceiling/i)!);

    const [, , payload] = mockGovernanceApi.updateCeiling.mock.calls[0];
    expect(payload.policy.dataScopes).toEqual(["*"]);
    expect(payload.policy.providers).toEqual(["*"]);
  });

  // G4 — a ceiling-violation case per T2b's taxonomy, built from the real
  // shared collectCeilingViolations so the body matches what the route emits.
  const overCeilingCases: Array<{
    name: string;
    label: string;
    value: string;
    requested: AgentGovernancePolicy;
    expected: string;
  }> = [
    {
      name: "list overflow (providers)",
      label: "Allowed providers",
      value: "hubspot, salesforce",
      requested: { ...CEILING, providers: ["hubspot", "salesforce"] },
      expected: "hubspot",
    },
    {
      name: "budget",
      label: "Maximum monthly budget",
      value: "50000",
      requested: { ...CEILING, monthlyBudgetCents: 50_000 },
      expected: "$100.00/mo",
    },
    {
      name: "destructive-mode rank",
      label: "Destructive actions",
      value: "allowed",
      requested: { ...CEILING, destructiveActions: "allowed" },
      expected: "approval required",
    },
    {
      name: "approval-mode rank",
      label: "Minimum approval",
      value: "none",
      requested: { ...CEILING, minimumApproval: "none" },
      expected: "steward",
    },
  ];

  for (const testCase of overCeilingCases) {
    it(`surfaces the server's named ceiling violation: ${testCase.name}`, async () => {
      mockGovernanceApi.updateCeiling.mockRejectedValue(
        new ApiError(
          "Requested agent configuration exceeds the owner ceiling",
          422,
          ceilingErrorBody(testCase.requested),
        ),
      );

      await render();
      await selectAgent();

      setInput(`[aria-label="${testCase.label}"]`, testCase.value);
      await click(findButton(/save ceiling/i)!);

      const alert = container.querySelector('[role="alert"]');
      expect(alert, "no violation surfaced to the owner").not.toBeNull();
      expect(container.textContent).toContain("exceeds the owner ceiling");
      expect(container.textContent).toContain(testCase.expected);
    });
  }
});
