import "./MarketingHeader.css";
import { Button } from "./components/Button";
import { AgentDashLogo } from "./components/AgentDashLogo";

export function MarketingHeader() {
  return (
    <header className="mkt-header">
      <div className="mkt-header__inner">
        <a href="/" className="mkt-header__brand" aria-label="AgentDash home">
          <AgentDashLogo size="md" />
        </a>
        <nav className="mkt-header__nav" aria-label="Primary">
          <a href="/">Product</a>
          <a href="/consulting">Consulting</a>
          <a href="/assess">Assessment</a>
          <a href="/about">About</a>
        </nav>
        <div className="mkt-header__cta">
          <Button href="/auth" variant="link">Sign in</Button>
          <Button href="/auth?mode=sign_up">Start free</Button>
        </div>
      </div>
    </header>
  );
}
