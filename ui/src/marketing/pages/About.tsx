import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { AboutMission } from "../sections/AboutMission";
import { CONTACT_EMAIL, GITHUB_URL, PAPERCLIP_URL, READINESS_LINE } from "../content/site";
import { useDocumentMeta } from "../hooks/useDocumentMeta";

export function About() {
  useDocumentMeta(
    "About AgentDash",
    "Why AgentDash exists, what it is built on, and where the product is today.",
  );
  return (
    <MarketingShell>
      <SectionContainer>
        <Eyebrow>About</Eyebrow>
        <h1 className="mkt-display-page" style={{ marginTop: 16 }}>Why AgentDash exists.</h1>
      </SectionContainer>
      <AboutMission />
      <SectionContainer background="cream-2">
        <div style={{ display: "grid", gap: 24, maxWidth: "62ch", color: "var(--mkt-ink-soft)" }}>
          <p className="mkt-body-lg">
            Most teams that try agents end up with a few clever scripts nobody is
            accountable for. AgentDash starts from the other end: every agent has a
            human steward, every risky action waits for a decision, and every action
            lands in a log you could hand to your board.
          </p>
          <p className="mkt-body-lg">
            It is built on <a href={PAPERCLIP_URL} target="_blank" rel="noreferrer">Paperclip</a>,
            an open-source control plane for agent companies, and adds the steward
            relationship, a harness-side inbox for Claude Code and Codex, and the
            human-in-the-loop controls. The code is <a href={GITHUB_URL} target="_blank" rel="noreferrer">on GitHub</a>.
          </p>
          <p className="mkt-body-lg">{READINESS_LINE}</p>
        </div>
      </SectionContainer>
      <SectionContainer>
        <p style={{ textAlign: "center", color: "var(--mkt-ink-soft)" }}>
          Press, partnerships, pilots: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </p>
      </SectionContainer>
    </MarketingShell>
  );
}
