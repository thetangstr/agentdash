import "./HowYouGetIt.css";
import { Eyebrow } from "../components/Eyebrow";
import { SectionContainer } from "../components/SectionContainer";
import { Button } from "../components/Button";
import { CTA, INSTALL_COMMAND } from "../content/site";

export function HowYouGetIt() {
  return (
    <SectionContainer id="get-it" background="cream-2">
      <div className="mkt-get__intro">
        <Eyebrow>How you get it today</Eyebrow>
        <h2 className="mkt-display-section">Three honest options.</h2>
        <p>
          AgentDash runs as one instance per company on a machine you control.
          There is no shared, multi-tenant cloud yet, and we would rather say so
          than sell you a sign-up button.
        </p>
      </div>
      <div className="mkt-get">
        <article className="mkt-get__card">
          <span className="mkt-get__status is-now">Available now</span>
          <h3>Install it yourself</h3>
          <p>
            Open source, one machine, your own Claude Code or Codex subscription.
            Embedded Postgres, no external database. One command on a fresh Mac or VPS.
          </p>
          <pre className="mkt-get__cmd"><code>{INSTALL_COMMAND}</code></pre>
          <Button href={CTA.selfHost.href} variant="ghost">{CTA.selfHost.label}</Button>
        </article>
        <article className="mkt-get__card mkt-get__card--featured">
          <span className="mkt-get__status is-limited">Limited</span>
          <h3>Managed pilot</h3>
          <p>
            We install and operate a dedicated instance for a small number of
            design partners, run the first Chief of Staff interview with you, and
            stay through the first quarter.
          </p>
          <Button href={CTA.walkthrough.href}>{CTA.walkthrough.label}</Button>
        </article>
        <article className="mkt-get__card">
          <span className="mkt-get__status is-soon">In design</span>
          <h3>Hosted AgentDash</h3>
          <p>
            Sign up and get your own hosted environment. We are working out how it
            should be provisioned, priced and secured, and it is not available yet.
          </p>
          <Button href={CTA.cloudList.href} variant="ghost">{CTA.cloudList.label}</Button>
        </article>
      </div>
    </SectionContainer>
  );
}
