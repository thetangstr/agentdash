import "./MarketingFooter.css";
import { AgentDashLogo } from "./components/AgentDashLogo";
import { CONTACT_EMAIL, CTA, GITHUB_URL, PAPERCLIP_URL, READINESS_LINE } from "./content/site";

export function MarketingFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="mkt-footer">
      <div className="mkt-footer__inner">
        <div className="mkt-footer__cols">
          <div className="mkt-footer__about">
            <AgentDashLogo size="sm" />
            <p className="mkt-footer__tagline">
              A Chief of Staff agent for your company, stewarded by you, run from
              the tools you already use.
            </p>
            <p className="mkt-footer__status">{READINESS_LINE}</p>
          </div>
          <div className="mkt-footer__col">
            <h4>Product</h4>
            <ul>
              <li><a href="/#how-it-works">How it works</a></li>
              <li><a href="/demo">Interactive demo</a></li>
              <li><a href="/mcp">MCP setup</a></li>
              <li><a href={CTA.selfHost.href} target="_blank" rel="noreferrer">Self-host on GitHub</a></li>
              <li><a href={CTA.signIn.href}>Sign in</a></li>
            </ul>
          </div>
          <div className="mkt-footer__col">
            <h4>Company</h4>
            <ul>
              <li><a href="/about">About</a></li>
              <li><a href="/consulting">Consulting</a></li>
              <li><a href="/assess">Readiness assessment</a></li>
              <li><a href={`mailto:${CONTACT_EMAIL}`}>Contact</a></li>
            </ul>
          </div>
          <div className="mkt-footer__col">
            <h4>Legal</h4>
            <ul>
              <li><a href="/terms">Terms</a></li>
              <li><a href="/privacy">Privacy</a></li>
              <li><a href={PAPERCLIP_URL} target="_blank" rel="noreferrer">Built on Paperclip</a></li>
              <li><a href={GITHUB_URL} target="_blank" rel="noreferrer">Source</a></li>
            </ul>
          </div>
        </div>
        <div className="mkt-footer__legal">
          <span>© {year} AgentDash. All rights reserved.</span>
          <span>{CONTACT_EMAIL}</span>
        </div>
      </div>
    </footer>
  );
}
