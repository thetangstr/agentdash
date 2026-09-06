import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = path.resolve(here, "..");

/**
 * The mandatory prompt surfaces from AGENTS.md.
 *
 * Every adapter reads these, so a behavior change that lands in one of them
 * silently leaves the other surface's workers running the old contract. This
 * used to guard four surfaces — the `ceo` and `chief_of_staff` archetype
 * copies were two of them — which is itself evidence of the problem: three
 * hand-synced copies of the same 45KB. The persona archetypes are gone (one
 * steward-centric bundle for every role; see default-agent-instructions.ts),
 * so the sync surface shrank to the one archetype plus the proposal renderer.
 */
const PROMPT_SURFACES: Array<{ name: string; path: string }> = [
  { name: "default", path: path.join(serverSrc, "onboarding-assets/default/AGENTS.md") },
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
  // Integrations are opt-in skills, not standing mandate (2026-09-02).
  //
  // These blocks were generated into every agent's AGENTS.md whether or not the
  // capability existed, and the `connections` table on this instance is empty
  // and always has been — so every agent carried pages about providers it
  // cannot reach. The rules are unchanged and live in `skills/` now; they apply
  // the moment a connection exists, which is why they are opt-in and not
  // deleted.
  //
  // Asserting the ABSENCE keeps the removal deliberate: re-adding any of this
  // to the always-loaded mandate fails here and has to be decided on purpose.
  it("keeps integration material out of the generated mandate", () => {
    const OPT_IN_ONLY = [
      "connectors",
      "gmail-connector",
      "slack-connector",
      "agentdash-mk-sharepoint",
      "msp-pilot-demo-routes",
    ];
    for (const surface of renderedPromptSurfaces) {
      for (const slug of OPT_IN_ONLY) {
        expect(
          surface.content,
          `${surface.name} re-added the generated '${slug}' block; integrations belong in skills/`,
        ).not.toContain(`<!-- AgentDash: ${slug}`);
      }
    }
  });

  // Governance prose is explicitly NOT part of that removal.
  it("still carries the governance rules in every surface", () => {
    for (const surface of renderedPromptSurfaces) {
      for (const slug of [
        "agentdash-mk-workforce",
        "agentdash-mk-harness-directives",
        "agentdash-mk-agent-facts",
        "agentdash-mk-deliverables",
        "agentdash-mk-measurement",
        "agentdash-mk-recommendations",
        "goals-eval-hitl",
      ]) {
        expect(surface.content, `${surface.name} lost the '${slug}' governance block`).toContain(
          `<!-- AgentDash: ${slug}`,
        );
      }
    }
  });

  it("includes the run-attributed issue comment contract in every prompt surface", () => {
    for (const surface of renderedPromptSurfaces) {
      expect(surface.content, `${surface.name} is missing the named output contract`).toContain(
        "<!-- AgentDash: agent-output-contract",
      );
      expect(surface.content, `${surface.name} omits the supported comment endpoint`).toContain(
        "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/comments",
      );
      expect(surface.content, `${surface.name} omits bearer agent authentication`).toContain(
        "Authorization: Bearer $PAPERCLIP_API_KEY",
      );
      expect(surface.content, `${surface.name} omits run attribution`).toContain(
        "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID",
      );
      expect(surface.content, `${surface.name} omits the injected agent identity`).toContain(
        "PAPERCLIP_AGENT_ID",
      );
      expect(surface.content, `${surface.name} suggests the invalid company-scoped comment route`).not.toContain(
        "/api/companies/$PAPERCLIP_COMPANY_ID/issues/$PAPERCLIP_TASK_ID/comments",
      );
    }
  });

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

  /**
   * Slice H. The recommendation half is agent-facing in exactly one direction:
   * an agent must know that a recommendation is advisory, that it cannot read
   * one, and that it must not act on one on somebody's behalf. An agent whose
   * prompt omits this will treat an accepted suggestion as a work order, which
   * is the only way "it never acts" gets falsified in practice.
   */
  it("tells every agent that recommendations are advisory and name nobody", () => {
    for (const surface of renderedPromptSurfaces) {
      expect(surface.content, `${surface.name} omits the recommendations block`).toContain(
        "<!-- AgentDash: agentdash-mk-recommendations",
      );
      expect(surface.content, `${surface.name} omits the block terminator`).toContain(
        "<!-- /AgentDash: agentdash-mk-recommendations -->",
      );
      expect(surface.content, `${surface.name} omits that it never acts`).toMatch(
        /It observes and suggests\. It never acts/,
      );
      expect(surface.content, `${surface.name} omits the seat exclusion`).toMatch(
        /seat exclusion/i,
      );
      expect(surface.content, `${surface.name} omits who a recommendation is addressed to`).toMatch(
        /not up the org chart/i,
      );
      // The boundary statement has to reach the agents too, not just the docs.
      expect(surface.content, `${surface.name} omits that nothing has been validated`).toMatch(
        /No real cycle has run/,
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
