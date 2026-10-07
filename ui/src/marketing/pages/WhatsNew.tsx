import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { LAUNCH_WEEK } from "../content/updates";
import { useDocumentMeta } from "../hooks/useDocumentMeta";
import "./WhatsNew.css";

export function WhatsNew() {
  useDocumentMeta("What's new · AgentDash", "Product updates from AgentDash: what changed, what it means for your team, and the release notes behind it.");
  return (
    <MarketingShell>
      <SectionContainer padding="hero">
        <div className="mkt-updates__intro">
          <Eyebrow>Product updates</Eyebrow>
          <h1 className="mkt-display-page">What’s new.</h1>
          <p className="mkt-body-lg">The work keeps moving. Here’s what changed in AgentDash, and what it means for your team.</p>
        </div>
        <article className="mkt-update-entry">
          <div className="mkt-update-entry__date"><time dateTime={LAUNCH_WEEK.date}>October 7, 2026</time><span>Launch week</span></div>
          <div className="mkt-update-entry__body">
            <p className="mkt-updates__versions">{LAUNCH_WEEK.versions.join(" + ")}</p>
            <h2 className="mkt-display-section"><a href={LAUNCH_WEEK.path}>{LAUNCH_WEEK.title}</a></h2>
            <p className="mkt-body-lg">{LAUNCH_WEEK.summary}</p>
            <a className="mkt-update-entry__link" href={LAUNCH_WEEK.path}>Read the update <span aria-hidden>↗</span></a>
          </div>
        </article>
      </SectionContainer>
    </MarketingShell>
  );
}
