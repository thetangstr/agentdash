import "./HowItWorks.css";
import { useEffect } from "react";
import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { FinalCTA } from "../sections/FinalCTA";
import { GITHUB_URL } from "../content/site";
import { useDocumentMeta } from "../hooks/useDocumentMeta";
import { StorySection, treatmentFromSearch } from "../how-it-works/StorySection";

export const HOW_IT_WORKS_RELEASE_URL = `${GITHUB_URL}/blob/main/releases/v2026.1031.0.md`;

/**
 * What each chapter of the story stands for in the product, one mechanism per step. Sources:
 * releases/v2026.1031.0.md ("Features"), packages/mcp-server/src/journey.ts (the team plan and
 * requireBoardApprovalForNewAgents) and server/src/routes/onboarding-v2.ts (the plan's hire gate).
 */
export const BEHIND_EACH_STEP: Array<{ step: string; mechanism: string }> = [
  {
    step: "Plan",
    mechanism:
      "The Chief of Staff interviews you and posts the team plan as a card, and confirming it creates the agents in it. Setting up through the AgentDash MCP server turns on “Require board approval for new agents”, so new hires, including any beyond the plan, wait for a person’s approval.",
  },
  {
    step: "Profile",
    mechanism:
      "Operating profiles are versioned. A change is proposed as an approval that needs the same authority as editing each changed field directly; once approved it is applied one agent at a time, stale changes are refused and every step is recorded. Agents can’t edit their own profile text.",
  },
  {
    step: "Access",
    mechanism:
      "An admin sets the company to off, shadow or enforce, and it starts off. In shadow, would-be refusals are recorded and nothing is refused; in enforce, the server answers an out-of-scope action with a refusal, the reason and how to ask for more, while the accountable person, the steward and admins stay reachable.",
  },
  {
    step: "Scorecard",
    mechanism:
      "Scorecards are computed from the agent’s records. Owed work comes from its schedule history, so a day when nothing ran still counts; automated acceptance, human acceptance, use and outcome stay separate facts; anything missing is shown as unknown.",
  },
  {
    step: "Decide",
    mechanism:
      "A designated agent, the Chief of Staff by default, is the performance manager: it reads scorecards and proposes changes or recommendations, and people decide them. A pause recommendation never pauses the agent.",
  },
];

export function HowItWorks() {
  useDocumentMeta(
    "How AgentDash works · Agents managed like staff",
    "How AgentDash manages agents like staff: a team plan you confirm, operating profiles approved before they apply, access rules from shadow to enforce, scorecards from real records, and decisions left to people.",
  );
  const treatment = treatmentFromSearch(typeof window === "undefined" ? "" : window.location.search);
  /* /how-it-works#story deep-links to the animation; the SPA renders after the browser's own hash jump */
  useEffect(() => {
    if (window.location.hash === "#story") document.getElementById("story")?.scrollIntoView({ block: "start" });
  }, []);
  return (
    <MarketingShell>
      <SectionContainer padding="hero">
        <div className="hiw-head">
          <Eyebrow>How it works</Eyebrow>
          <h1 className="mkt-display-page">Agents managed like staff.</h1>
          <p className="mkt-body-lg">
            Every agent in AgentDash has a job written by a person, access rules, and a scorecard
            drawn from real records. The Chief of Staff plans the team and reads the scorecards.
            People make the decisions.
          </p>
        </div>
        <div id="story" className="hiw-story-wrap">
          <StorySection treatment={treatment} />
        </div>
      </SectionContainer>

      <SectionContainer background="cream-2">
        <div className="hiw-behind__intro">
          <Eyebrow>What’s behind each step</Eyebrow>
          <h2 className="mkt-display-section">The mechanism, step by step.</h2>
        </div>
        <ol className="hiw-behind">
          {BEHIND_EACH_STEP.map((b, i) => (
            <li key={b.step} className="hiw-behind__item">
              <span className="hiw-behind__n">{String(i + 1).padStart(2, "0")}</span>
              <h3>{b.step}</h3>
              <p>{b.mechanism}</p>
            </li>
          ))}
        </ol>
        <p className="hiw-behind__source">
          These features shipped in AgentDash v2026.1031.0 (
          <a href={HOW_IT_WORKS_RELEASE_URL} target="_blank" rel="noreferrer">release notes</a>
          ). Access rules stay off until an admin turns them on, and what an instance shows depends
          on the version its operator has installed.
        </p>
      </SectionContainer>

      <FinalCTA />
    </MarketingShell>
  );
}
