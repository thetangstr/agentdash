import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { Button } from "../components/Button";
import { CTA } from "../content/site";
import { LAUNCH_WEEK, UPDATE_SOURCES } from "../content/updates";
import { useDocumentMeta } from "../hooks/useDocumentMeta";
import { TeamSidebar, FollowingTranscript } from "../updates/ReleaseIllustrations";
import "./WhatsNew.css";

export function LaunchWeek() {
  useDocumentMeta(`${LAUNCH_WEEK.title} · AgentDash`, LAUNCH_WEEK.summary);
  return (
    <MarketingShell>
      <article className="mkt-launch-post">
        <SectionContainer padding="hero">
          <a className="mkt-updates__back" href="/whats-new">← All updates</a>
          <div className="mkt-updates__intro mkt-updates__intro--article">
            <Eyebrow>Launch week · October 7, 2026</Eyebrow>
            <h1 className="mkt-display-page">{LAUNCH_WEEK.title}</h1>
            <p className="mkt-body-lg">{LAUNCH_WEEK.summary}</p>
            <p className="mkt-updates__versions">{LAUNCH_WEEK.versions.join(" + ")}</p>
          </div>
        </SectionContainer>
        <SectionContainer id="sidebar-teams">
          <div className="mkt-update-feature">
            <div className="mkt-update-feature__copy">
              <Eyebrow>01 · Find your people</Eyebrow>
              <h2 className="mkt-display-section">Your team is back in sight.</h2>
              <p className="mkt-body-lg">The left sidebar lists your agents, grouped under the agent they report to. Open one team, close another, and get to the person doing the work.</p>
              <p>The list starts open. Each team collapses independently, and the agent you are viewing stays visible even when its team is closed. A broken reporting loop no longer makes agents disappear.</p>
            </div>
            <TeamSidebar />
          </div>
        </SectionContainer>
        <SectionContainer background="cream-2" id="transcript-follow">
          <div className="mkt-update-feature">
            <div className="mkt-update-feature__copy">
              <Eyebrow>02 · Keep your place</Eyebrow>
              <h2 className="mkt-display-section">Follow along. Stop to read.</h2>
              <p className="mkt-body-lg">Chats and live transcripts keep up with new messages while you’re at the bottom. Scroll up to read something earlier, and the view holds still.</p>
              <p>Choose Jump to latest to follow again. Sending a message also resumes following. Links to a specific comment keep their place, and an issue still opens at its description.</p>
              <p>The same behavior now reaches issue chat, live run panes on the dashboard, and Ask chat.</p>
            </div>
            <FollowingTranscript />
          </div>
        </SectionContainer>
        <SectionContainer id="release-improvements">
          <div className="mkt-update-notes">
            <div className="mkt-update-notes__intro"><Eyebrow>Under the surface</Eyebrow><h2 className="mkt-display-section">Less waiting. Clearer boundaries.</h2></div>
            <div className="mkt-update-notes__grid">
              <section><h3>Run logs without the long stall</h3><p>Run-log reads now redact in small, paged slices, giving other requests time to get through. Reading a long log no longer requires one blocking pass over the whole file.</p></section>
              <section><h3>A focused security pass</h3><p>This update tightens access checks for restricted projects, approvals and agent configuration; company boundaries for goals and plugin secrets; and cost visibility on the dashboard. Malformed input gets clean errors, and responses carry standard security headers.</p></section>
            </div>
          </div>
        </SectionContainer>
        <SectionContainer background="cream-2">
          <div className="mkt-update-sources">
            <Eyebrow>The release notes behind this update</Eyebrow>
            <h2 className="mkt-display-section">Read the details.</h2>
            <p>Both October 7 releases require no database migrations. Availability on your instance depends on the version your operator has installed. These illustrations are scripted; they do not run agents or connect to a workspace.</p>
            <ul>{UPDATE_SOURCES.map((source) => <li key={source.href}><a href={source.href} target="_blank" rel="noreferrer">{source.label} <span aria-hidden>↗</span></a></li>)}</ul>
            <div className="mkt-update-sources__cta"><Button href={CTA.demo.href}>{CTA.demo.label}</Button><Button href={CTA.walkthrough.href} variant="ghost">{CTA.walkthrough.label}</Button></div>
          </div>
        </SectionContainer>
      </article>
    </MarketingShell>
  );
}
