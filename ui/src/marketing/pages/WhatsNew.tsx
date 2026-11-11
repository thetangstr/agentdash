import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { ADMIN_POWERS_UPDATE, AGENT_PERFORMANCE_UPDATE, LAUNCH_WEEK, isUpdatePublished } from "../content/updates";
import { useDocumentMeta } from "../hooks/useDocumentMeta";
import "./WhatsNew.css";
import "./AgentPerformance.css";

export function WhatsNew({ published }: { published?: readonly string[] }) {
  useDocumentMeta("What's new · AgentDash", "Product updates from AgentDash: what changed, what it means for your team, and the release notes behind it.");
  return (
    <MarketingShell>
      <SectionContainer padding="hero">
        <div className="mkt-updates__intro">
          <Eyebrow>Product updates</Eyebrow>
          <h1 className="mkt-display-page">What’s new.</h1>
          <p className="mkt-body-lg">The work keeps moving. Here’s what changed in AgentDash, and what it means for your team.</p>
          <p><a href="/releases">All release notes <span aria-hidden>→</span></a></p>
        </div>
        {/* AgentDash: listed once v2026.1110.0 is published; the site builds from main before the cut. */}
        {isUpdatePublished(ADMIN_POWERS_UPDATE, published) ? (
          <article className="mkt-update-entry" data-update="admin-powers">
            <div className="mkt-update-entry__date"><time dateTime={ADMIN_POWERS_UPDATE.date}>November 10, 2026</time><span>Admin powers</span></div>
            <div className="mkt-update-entry__body">
              <p className="mkt-updates__versions">{ADMIN_POWERS_UPDATE.versions.join(" + ")}</p>
              <h2 className="mkt-display-section"><a href={ADMIN_POWERS_UPDATE.path}>{ADMIN_POWERS_UPDATE.title}</a></h2>
              <p className="mkt-body-lg">{ADMIN_POWERS_UPDATE.summary}</p>
              <a className="mkt-update-entry__link" href={ADMIN_POWERS_UPDATE.path}>Read the update <span aria-hidden>↗</span></a>
            </div>
          </article>
        ) : null}
        <article className="mkt-update-entry" data-update="agent-performance">
          <div className="mkt-update-entry__date"><time dateTime={AGENT_PERFORMANCE_UPDATE.date}>November 5, 2026</time><span>Agent performance</span></div>
          <div className="mkt-update-entry__body">
            <p className="mkt-updates__versions">{AGENT_PERFORMANCE_UPDATE.versions.join(" + ")}</p>
            <h2 className="mkt-display-section"><a href={AGENT_PERFORMANCE_UPDATE.path}>{AGENT_PERFORMANCE_UPDATE.title}</a></h2>
            <p className="mkt-body-lg">{AGENT_PERFORMANCE_UPDATE.summary}</p>
            <a className="mkt-update-entry__link" href={AGENT_PERFORMANCE_UPDATE.path}>Read the update <span aria-hidden>↗</span></a>
          </div>
        </article>
        <article className="mkt-update-entry" data-update="launch-week">
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
