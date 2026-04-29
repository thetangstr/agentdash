import "./MarketingHeader.css";
import { Button } from "./components/Button";

export function MarketingHeader() {
  return (
    <header className="mkt-header">
      <div className="mkt-header__inner">
        <a href="/" className="mkt-header__brand">AgentDash</a>
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
