import { describe, expect, it } from "vitest";
import {
  ATTENTION_LIMIT,
  BRIEFING_MAX_CHARS,
  buildAttention,
  buildBriefing,
  kindForActivity,
  type RowSource,
} from "../services/assistant-provenance.js";

// AgentDash consolidation PR-A (design Rev 3 §4.1, §4.4): the provenance
// derivation and the deterministic briefing, pinned without a database.

const marco: RowSource = {
  kind: "agent_state",
  actor: { type: "agent", name: "Marco" },
  entity: "issue",
  id: "i-1",
  recordedAt: "2026-09-27T01:00:00.000Z",
};
const kai: RowSource = {
  kind: "human_or_system",
  actor: { type: "user", name: "Kai" },
  entity: "issue",
  id: "i-2",
  recordedAt: "2026-09-27T02:00:00.000Z",
};

describe("kindForActivity", () => {
  it("only a server-stamped user or system row is a human/system record", () => {
    expect(kindForActivity({ origin: "server", actorType: "user", details: null })).toEqual({ kind: "human_or_system" });
    expect(kindForActivity({ origin: "server", actorType: "system", details: null })).toEqual({ kind: "human_or_system" });
  });

  it("agent and plugin rows are agent_state even when the server wrote them", () => {
    expect(kindForActivity({ origin: "server", actorType: "agent", details: null }).kind).toBe("agent_state");
    expect(kindForActivity({ origin: "server", actorType: "plugin", details: null }).kind).toBe("agent_state");
  });

  it("manual and pre-origin rows are never better than agent_state, whatever they claim", () => {
    for (const origin of ["manual", null]) {
      for (const actorType of ["system", "user", "agent"]) {
        expect(kindForActivity({ origin, actorType, details: { via: "assistant_grant g (c)" } }).kind).toBe("agent_state");
      }
    }
  });

  it("a row written through an assistant grant is via assistant and never human_or_system", () => {
    for (const actorType of ["user", "system"]) {
      expect(
        kindForActivity({ origin: "server", actorType, details: { via: "assistant_grant g-1 (ChatGPT)" } }),
      ).toEqual({ kind: "agent_state", via: "assistant" });
    }
  });
});

const baseInput = {
  scopeName: "Yarda",
  since: new Date("2026-09-26T00:00:00.000Z"),
  asOf: new Date("2026-09-27T00:00:00.000Z"),
  decisions: {
    total: 1,
    items: [{ approvalId: "a-1", type: "hire_agent", scopeLabel: "in Yarda", source: marco }],
  },
  blocked: { total: 1, items: [{ issueId: "i-2", identifier: "YAR-2", title: "Payment webhook retries", source: kai }] },
  shipped: {
    total: 1,
    items: [{ issueId: "i-1", identifier: "YAR-1", title: "Ship booking calendar", source: marco, prTitle: "feat: calendar" }],
  },
  changedTotal: 4,
  quiet: { quiet: false, reason: null },
  truncated: false,
};

describe("buildBriefing (golden)", () => {
  it("renders the sourced briefing deterministically", () => {
    expect(buildBriefing(baseInput)).toBe(
      "At Yarda since 2026-09-26T00:00:00Z: 1 decision waits for you (hire agent, in Yarda); " +
        "1 blocked (YAR-2 “Payment webhook retries”: Kai marked it blocked); 4 recorded changes; " +
        "1 finished (“Ship booking calendar”, PR “feat: calendar”: Marco marked it done (agent-set)). " +
        "As of 2026-09-27T00:00:00Z.",
    );
  });

  it("says who did it via assistant, says when nobody is on record, and states truncation", () => {
    const text = buildBriefing({
      ...baseInput,
      blocked: { total: 1, items: [{ ...baseInput.blocked.items[0]!, source: { ...kai, kind: "agent_state", via: "assistant" } }] },
      shipped: {
        total: 3,
        items: [{ ...baseInput.shipped.items[0]!, source: { ...marco, actor: { type: "unknown", name: null } } }],
      },
      quiet: { quiet: true, reason: "2 open tasks, no recorded activity in the last 3 days" },
      truncated: true,
    });
    expect(text).toContain("Kai marked it blocked via assistant");
    expect(text).toContain("marked it done, no recorded author");
    const legacy = buildBriefing({
      ...baseInput,
      shipped: { total: 1, items: [{ ...baseInput.shipped.items[0]!, source: { ...marco, origin: "unknown", actor: { type: "unknown", name: null } } }] },
    });
    expect(legacy).toContain("marked it done, origin unknown");
    expect(text).toContain("Quiet: 2 open tasks, no recorded activity in the last 3 days.");
    expect(text).toContain("lists are capped, counts are complete");
  });

  it("stays within 600 characters by dropping examples first", () => {
    const long = "x".repeat(400);
    const text = buildBriefing({
      ...baseInput,
      scopeName: "Yarda",
      blocked: { total: 9, items: [{ ...baseInput.blocked.items[0]!, title: long }] },
      shipped: { total: 9, items: [{ ...baseInput.shipped.items[0]!, title: long, prTitle: long }] },
      quiet: { quiet: true, reason: long },
    });
    expect(text.length).toBeLessThanOrEqual(BRIEFING_MAX_CHARS);
    expect(text).toContain("9 blocked");
  });
});

describe("buildAttention", () => {
  it("orders decisions → blocked → quiet → shipped and caps at five", () => {
    const items = buildAttention({
      ...baseInput,
      decisions: { total: 4, items: Array.from({ length: 4 }, (_, n) => ({ ...baseInput.decisions.items[0]!, approvalId: `a-${n}` })) },
      quiet: { quiet: true, reason: "quiet" },
      quietTarget: { type: "company", ref: "c-1" },
    });
    expect(items).toHaveLength(ATTENTION_LIMIT);
    expect(items.map((i) => i.reason)).toEqual([
      "decision_waiting",
      "decision_waiting",
      "decision_waiting",
      "decision_waiting",
      "blocked",
    ]);
    const small = buildAttention({ ...baseInput, quiet: { quiet: true, reason: "quiet" }, quietTarget: null });
    expect(small.map((i) => i.reason)).toEqual(["decision_waiting", "blocked", "quiet", "shipped"]);
    expect(small[1]!.source).toBe(kai);
  });
});
