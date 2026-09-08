import { describe, expect, it } from "vitest";
import { describeActivity, describeActor } from "./agent-activity-copy";
import { timeAgo, timeSince, timeUntil } from "./timeAgo";

const base = { actorType: "agent" as const, actorId: "agent-1", details: null };

describe("describeActivity", () => {
  it("composes a sentence from the entity and the verb", () => {
    expect(describeActivity({ ...base, action: "issue.created" }, "Casper")).toBe(
      "Casper created an issue",
    );
    expect(describeActivity({ ...base, action: "approval.approved" }, "Casper")).toBe(
      "Casper approved an approval",
    );
  });

  it("names the thing when the event carries a title", () => {
    expect(
      describeActivity(
        { ...base, action: "issue.updated", details: { title: "Reconcile vendor invoices" } },
        "Casper",
      ),
    ).toBe("Casper updated an issue — Reconcile vendor invoices");
  });

  /**
   * The point of the fallback. There are 275 action strings and this maps a
   * fraction of them on purpose; the rest must still read as a line about
   * somebody doing something, not vanish and not render blank.
   */
  it("falls back to the previous wording for an action it does not know", () => {
    const out = describeActivity({ ...base, action: "billing.disburse" }, "Casper");
    expect(out).toBe("Casper: billing disburse");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain(".");
  });

  it("falls back for a known entity with an unknown verb, rather than half a sentence", () => {
    expect(describeActivity({ ...base, action: "issue.tree_hold_run_interrupted" }, "Casper")).toBe(
      "Casper: issue tree hold run interrupted",
    );
  });

  it("handles an action with no dot at all", () => {
    expect(describeActivity({ ...base, action: "dod_set" }, "Casper")).toBe("Casper: dod set");
  });
});

describe("describeActor", () => {
  /**
   * The honesty case. This feed is where a steward would notice something they
   * did not do, so a teammate's action must not be labelled "You". An admin can
   * act on an agent someone else stewards, so actorType alone cannot decide it.
   */
  it("says You only when the actor is the viewer", () => {
    const event = { actorType: "user" as const, actorId: "user-me" };
    expect(describeActor(event, "Casper", "user-me")).toBe("You");
    expect(describeActor(event, "Casper", "user-someone-else")).toBe("A teammate");
    expect(describeActor(event, "Casper", null)).toBe("A teammate");
  });

  it("distinguishes the agent, the system and an integration", () => {
    expect(describeActor({ actorType: "agent", actorId: "a" }, "Casper", null)).toBe("Casper");
    expect(describeActor({ actorType: "system", actorId: "s" }, "Casper", null)).toBe("AgentDash");
    expect(describeActor({ actorType: "plugin", actorId: "p" }, "Casper", null)).toBe(
      "An integration",
    );
  });
});

describe("timeUntil", () => {
  it("counts forward to a deadline", () => {
    expect(timeUntil(new Date(Date.now() + 4 * 3600 * 1000))).toBe("4h");
    expect(timeUntil(new Date(Date.now() + 90 * 1000))).toBe("1m");
    expect(timeUntil(new Date(Date.now() + 3 * 86400 * 1000))).toBe("3d");
  });

  /** Null, not a negative duration — "expired" is a different sentence. */
  it("returns null once the deadline has passed", () => {
    expect(timeUntil(new Date(Date.now() - 1000))).toBeNull();
  });
});

describe("timeSince", () => {
  /**
   * The defect this exists for, caught by looking at the rendered page rather
   * than asserting on substrings: the waiting chip composed its label from
   * `timeAgo`, which already ends in "ago", so it read "waiting 2d ago".
   */
  it("returns a bare duration that a caller can put words around", () => {
    const twoDays = new Date(Date.now() - 2 * 86400 * 1000);
    expect(timeSince(twoDays)).toBe("2d");
    expect(`waiting ${timeSince(twoDays)}`).toBe("waiting 2d");
    expect(timeSince(twoDays)).not.toMatch(/ago/);
  });

  it("still reads as a phrase for something that just arrived", () => {
    expect(`waiting ${timeSince(new Date())}`).toBe("waiting under a minute");
  });

  it("covers minutes and hours", () => {
    expect(timeSince(new Date(Date.now() - 20 * 60 * 1000))).toBe("20m");
    expect(timeSince(new Date(Date.now() - 5 * 3600 * 1000))).toBe("5h");
  });

  /** A clock skew must not produce a negative duration. */
  it("clamps a future timestamp instead of counting backwards", () => {
    expect(timeSince(new Date(Date.now() + 60_000))).toBe("under a minute");
  });

  /** timeAgo is unchanged and still the right tool for a standalone label. */
  it("leaves timeAgo alone for labels that stand on their own", () => {
    expect(timeAgo(new Date(Date.now() - 2 * 86400 * 1000))).toBe("2d ago");
  });
});
