import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.resolve(here, "..");

/**
 * The four mandatory prompt surfaces from AGENTS.md.
 *
 * Every adapter reads these, so a behavior change that lands in three of them
 * silently leaves the fourth adapter's workers running the old contract. CI
 * enforces that a PR touching routes/services/schema touches one of these; this
 * test enforces that the AgentDash-MK block is actually present in ALL of them
 * and says the same thing.
 */
const PROMPT_SURFACES: Array<{ name: string; path: string }> = [
  { name: "default", path: path.join(serverSrc, "onboarding-assets/default/AGENTS.md") },
  { name: "ceo", path: path.join(serverSrc, "onboarding-assets/ceo/AGENTS.md") },
  {
    name: "chief_of_staff",
    path: path.join(serverSrc, "onboarding-assets/chief_of_staff/AGENTS.md"),
  },
  {
    name: "agent-creator-from-proposal",
    path: path.join(serverSrc, "services/agent-creator-from-proposal.ts"),
  },
];

const renderedPromptSurfaces = PROMPT_SURFACES.map((surface) => ({
  ...surface,
  content: readFileSync(surface.path, "utf8"),
}));

describe("AgentDash-MK prompt surface synchronization", () => {
  it("includes the AgentDash-MK workforce block in every prompt surface", () => {
    for (const surface of renderedPromptSurfaces) {
      expect(surface.content, `${surface.name} is missing the named block`).toContain(
        "<!-- AgentDash: agentdash-mk-workforce",
      );
      expect(surface.content, `${surface.name} is missing the block terminator`).toContain(
        "<!-- /AgentDash: agentdash-mk-workforce -->",
      );
      expect(surface.content, `${surface.name} does not mention the steward`).toContain(
        "current human steward",
      );
      expect(surface.content, `${surface.name} does not mention child contributions`).toContain(
        "complete child contribution",
      );
    }
  });

  it("describes the governed behaviors an agent must actually follow", () => {
    for (const surface of renderedPromptSurfaces) {
      // Approval decisions now carry a revision; an agent that resubmits must
      // know the old card is dead.
      expect(surface.content, `${surface.name} omits approval revision`).toMatch(/revision/i);
      // Ceiling refusals are a normal outcome, not a bug to retry against.
      expect(surface.content, `${surface.name} omits the ceiling`).toMatch(
        /AGENT_POLICY_CEILING_EXCEEDED/,
      );
    }
  });

  it("stays adapter-neutral: HTTP endpoints and JSON fields, not UI gestures", () => {
    for (const surface of renderedPromptSurfaces) {
      const block = surface.content.slice(
        surface.content.indexOf("<!-- AgentDash: agentdash-mk-workforce"),
        surface.content.indexOf("<!-- /AgentDash: agentdash-mk-workforce -->"),
      );
      // Endpoints, so every adapter reaches the control plane the same way.
      expect(block, `${surface.name} omits an HTTP endpoint`).toMatch(
        /GET \/api\/companies\/:companyId\/me\/agent/,
      );
      expect(block, `${surface.name} omits the contributions endpoint`).toMatch(
        /child-contributions/,
      );
      // Adapters that cannot render cards still need the comment path.
      expect(block, `${surface.name} omits the card-or-comment fallback`).toMatch(
        /card .*or .*comment|comment .*fallback/i,
      );
      // No UI-only instructions.
      expect(block, `${surface.name} describes a UI gesture`).not.toMatch(
        /click the (green|red|approve|reject) button/i,
      );
    }
  });

  it("tells every agent that a steward may decide from a chat channel", () => {
    // Telegram decisions are indistinguishable from dashboard decisions at the
    // service layer. An agent whose prompt does not say so will poll the
    // dashboard and conclude an approval is still pending after it was decided
    // on someone's phone.
    for (const surface of renderedPromptSurfaces) {
      expect(surface.content, `${surface.name} omits the chat-channel section`).toContain(
        "Talking to your steward over a chat channel",
      );
      expect(surface.content, `${surface.name} omits who starts pairing`).toMatch(
        /Pairing is started by the human/,
      );
      // The channel is one human, not a room — the guard that matters most,
      // because an agent that asks to be added to a group defeats it socially
      // even though the server refuses it.
      expect(surface.content, `${surface.name} omits the one-human rule`).toMatch(
        /one human, not a room/,
      );
    }
  });

  it("tells every agent how the local machine bridge works, and what it cannot bound", () => {
    // INVERTED 2026-07-30. This test used to assert the bridge was NOT
    // mentioned, because it was deferred. The owner brought it into scope, so
    // silence is now the defect: an agent that does not know the bridge exists
    // cannot use it, and one that does not know the ceiling stops at the
    // network boundary will assume a guarantee that is not there.
    for (const surface of renderedPromptSurfaces) {
      expect(surface.content, `${surface.name} omits the bridge section`).toContain(
        "Asking a human's machine to do something",
      );
      expect(surface.content, `${surface.name} omits the act-class approval rule`).toMatch(
        /act.{0,40}steward|steward.{0,40}approv/i,
      );
      // The honest limit has to reach the agents, not just the design docs.
      expect(surface.content, `${surface.name} omits the bridge's trust limit`).toMatch(
        /cannot (bound|constrain) what that machine/i,
      );
      // Results come back framed; an agent that treats them as instructions is
      // the exact failure this warning exists to prevent.
      expect(surface.content, `${surface.name} omits the untrusted-result warning`).toContain(
        "untrusted-bridge-result",
      );
    }
  });
});
