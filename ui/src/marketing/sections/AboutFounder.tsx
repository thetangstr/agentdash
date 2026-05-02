import "./AboutFounder.css";
import { Linkedin } from "lucide-react";
import { SectionContainer } from "../components/SectionContainer";

// FILL IN: founder.{name|portrait|bio|linkedin} — supplied by the user.
const FOUNDER = {
  name: "[Founder Name]",
  portrait: "", // empty string renders the placeholder ring
  bio: "[Title] of AgentDash | [Background line, modeled on yarda's: e.g., 'Former Google & Consulting professional focused on giving every company the operating clarity to run AI agents safely.']",
  linkedin: "https://www.linkedin.com/in/",
};

export function AboutFounder() {
  return (
    <SectionContainer>
      <div className="mkt-founder-card">
        <div className="mkt-founder-card__title">Who We Are</div>
        <div className="mkt-founder">
          {FOUNDER.portrait ? (
            <img src={FOUNDER.portrait} alt={FOUNDER.name} className="mkt-founder__portrait" />
          ) : (
            <div className="mkt-founder__portrait" aria-label="Portrait placeholder" />
          )}
          <div>
            <div className="mkt-founder__name">{FOUNDER.name}</div>
            <p className="mkt-founder__bio">{FOUNDER.bio}</p>
            <a href={FOUNDER.linkedin} className="mkt-founder__linkedin" target="_blank" rel="noreferrer">
              <Linkedin size={18} strokeWidth={1.5} aria-hidden /> Follow on LinkedIn
            </a>
          </div>
        </div>
      </div>
    </SectionContainer>
  );
}
