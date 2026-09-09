import "./Hero.css";
import { Eyebrow } from "../components/Eyebrow";
import { Button } from "../components/Button";
import { SectionContainer } from "../components/SectionContainer";
import { CTA, READINESS_LINE } from "../content/site";
import { HeroPlayer } from "./HeroPlayer";

export function Hero() {
  return (
    <SectionContainer padding="hero">
      <div className="mkt-hero">
        <div className="mkt-hero__top">
          <div className="mkt-hero__headline">
            <Eyebrow>Chief of Staff agents, stewarded by you</Eyebrow>
            <h1 className="mkt-display-hero">
              Hire a Chief of Staff agent. It answers to you.
            </h1>
          </div>
          <div className="mkt-hero__copy">
            <p className="mkt-body-lg">
              AgentDash pairs every agent with an accountable human. Direct your Chief
              of Staff from Claude Code or Codex, let it delegate across the rest of
              your agent workforce, and keep anything risky waiting on your decision.
            </p>
            <div className="mkt-hero__cta-row">
              <Button href={CTA.demo.href}>{CTA.demo.label}</Button>
              <Button href={CTA.walkthrough.href} variant="ghost">{CTA.walkthrough.label}</Button>
            </div>
            <p className="mkt-hero__reassure">{READINESS_LINE}</p>
          </div>
        </div>
        <div className="mkt-hero__art">
          <HeroPlayer />
        </div>
      </div>
    </SectionContainer>
  );
}
