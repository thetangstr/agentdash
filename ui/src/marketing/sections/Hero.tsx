import "./Hero.css";
import { Eyebrow } from "../components/Eyebrow";
import { Button } from "../components/Button";
import { SectionContainer } from "../components/SectionContainer";
import { AgentOrgChart } from "./AgentOrgChart";

export function Hero() {
  return (
    <SectionContainer>
      <div className="mkt-hero">
        <div className="mkt-hero__copy">
          <Eyebrow>The control plane for your AI company</Eyebrow>
          <h1 className="mkt-display-hero">
            Run an AI workforce the way you'd run a company.
          </h1>
          <p className="mkt-body-lg">
            Goals, agents, budgets, and audit trails — in one control plane your
            board would actually approve of.
          </p>
          <div className="mkt-hero__cta-row">
            <Button href="/auth?mode=sign_up">Start free</Button>
            <Button href="#layered-descent" variant="ghost">See the architecture</Button>
          </div>
          <p className="mkt-hero__reassure">No credit card · Free single-seat tier</p>
        </div>
        <div className="mkt-hero__art" aria-hidden>
          <AgentOrgChart />
        </div>
      </div>
    </SectionContainer>
  );
}
