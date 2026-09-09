import { describe, expect, it } from "vitest";
import {
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  AGENT_POLICY_WILDCARD,
  type AgentGovernancePolicy,
} from "@paperclipai/shared";
import { describeAuthority, isUnrestricted } from "./agent-authority-copy";

const base: AgentGovernancePolicy = {
  permissions: [AGENT_POLICY_WILDCARD],
  monthlyBudgetCents: AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  destructiveActions: "approval_required",
  dataScopes: [AGENT_POLICY_WILDCARD],
  providers: [AGENT_POLICY_WILDCARD],
  minimumApproval: "steward",
};

describe("describeAuthority", () => {
  it("says what the agent may do in sentences, not field names", () => {
    const lines = describeAuthority(base);
    expect(lines).toContain(
      "Must get your approval before deleting anything or doing something it cannot undo.",
    );
    expect(lines).toContain("You are the one who approves its requests.");
    expect(lines.join(" ")).not.toMatch(/monthlyBudgetCents|destructiveActions|minimumApproval/);
  });

  /**
   * The sentinel is Postgres' integer maximum, not a budget. Rendering it as a
   * number would tell a steward their agent may spend twenty-one million
   * dollars.
   */
  it("reads the unlimited sentinel as no limit, never as $21,474,836", () => {
    expect(describeAuthority(base)).toContain("No spending limit has been set.");
    expect(describeAuthority(base).join(" ")).not.toMatch(/21,474,836|2147483647/);
  });

  it("states a real budget in dollars", () => {
    expect(describeAuthority({ ...base, monthlyBudgetCents: 10_000 })).toContain(
      "Can spend up to $100 a month.",
    );
    expect(describeAuthority({ ...base, monthlyBudgetCents: 12_550 })).toContain(
      "Can spend up to $125.50 a month.",
    );
  });

  it("distinguishes the three destructive-action modes", () => {
    expect(describeAuthority({ ...base, destructiveActions: "blocked" }).join(" ")).toMatch(
      /Cannot delete or undo anything/,
    );
    expect(describeAuthority({ ...base, destructiveActions: "allowed" }).join(" ")).toMatch(
      /without asking first/,
    );
  });

  /**
   * A wildcard means "not narrowed", so listing it as a restriction would be
   * backwards. Only genuine narrowing is worth a line.
   */
  it("mentions narrowing only when something is actually narrowed", () => {
    expect(describeAuthority(base).join(" ")).not.toMatch(/Limited to|only reach|Restricted to/);
    const narrowed = describeAuthority({ ...base, permissions: ["issues:read", "issues:write"] });
    expect(narrowed.join(" ")).toMatch(/Limited to 2 specific permission\(s\)/);
  });

  /** An unknown value must not become a reassuring sentence. */
  it("names an unrecognised value rather than inventing copy for it", () => {
    const odd = describeAuthority({
      ...base,
      destructiveActions: "sometimes" as never,
    });
    expect(odd.join(" ")).toMatch(/Destructive actions: sometimes/);
  });

  it("returns nothing when there is no policy", () => {
    expect(describeAuthority(null)).toEqual([]);
    expect(describeAuthority(undefined)).toEqual([]);
  });
});

describe("isUnrestricted", () => {
  it("is false for the safe default, which restricts two dimensions", () => {
    expect(isUnrestricted(base)).toBe(false);
  });

  it("is true only when nothing at all has been narrowed", () => {
    expect(
      isUnrestricted({ ...base, destructiveActions: "allowed", minimumApproval: "none" }),
    ).toBe(true);
  });
});
