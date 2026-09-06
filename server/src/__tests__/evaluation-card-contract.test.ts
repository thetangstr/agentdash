import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { A, at, ev, evidenced, I1, I2, roster, score, T } from "./helpers/evaluation-fixtures.js";

// AgentDash: Company Evaluator — the card contract between the scoring engine
// and the Milestone 4 surfaces. The UI renders `ui/src/pages/evaluation/
// __fixtures__/scored-card.json`, a real card scored from the shared fixture
// window; this test keeps that file byte-identical to what the engine produces
// today, so a change to the card's shape fails here before it misleads a page.
// Regenerate deliberately with EVALUATION_CARD_FIXTURE_WRITE=1.

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../../../ui/src/pages/evaluation/__fixtures__/scored-card.json");

describe("card contract fixture", () => {
  it("the committed scored card equals what the engine scores from the fixture window", () => {
    const window = [
      ...roster(),
      ...evidenced(I1),
      ...evidenced(I2, 10),
      ev({ type: "authz.refused", time: at(12), actor: ["agent", T], issueId: I1, sourceTable: "activity_log", payload: { method: "POST", routePath: "/api/companies/:companyId/verdicts", reasonCode: "NEUTRAL_VALIDATOR_VIOLATION" } }),
      ev({ type: "issue.comment_added", time: at(13), actor: ["user", "founder-1"], issueId: I2, payload: { commentId: "human-1", reopened: true } }),
    ];
    const card = JSON.parse(JSON.stringify(score(window)));
    if (process.env.EVALUATION_CARD_FIXTURE_WRITE === "1" || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, `${JSON.stringify(card, null, 2)}\n`);
    }
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"));
    expect(card).toEqual(committed);
    // the shape the surfaces rely on
    expect(card.outcomeComposite.guard.reasons).toBeInstanceOf(Array);
    expect(card.actors.some((a: { actorType: string; name: string | null }) => a.actorType === "company" && a.name === null)).toBe(true);
    for (const m of Object.values(card.outcome) as Array<Record<string, unknown>>) {
      expect(typeof m.formulaVersion).toBe("string");
      expect(typeof m.evidenceRefCount).toBe("number");
      expect(typeof m.confidenceLabel).toBe("string");
    }
    void A;
  });
});
