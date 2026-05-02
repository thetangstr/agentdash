import "./MarketingFooter.css";

export function MarketingFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="mkt-footer">
      <div className="mkt-footer__inner">
        <div className="mkt-footer__cols">
          <div>
            <div className="mkt-footer__brand">AgentDash</div>
            <p className="mkt-footer__tagline">
              The control plane for your AI company.
            </p>
          </div>
          <div className="mkt-footer__col">
            <h4>Product</h4>
            <ul>
              <li><a href="/">Features</a></li>
              <li><a href="/assess">Assessment</a></li>
              <li><a href="/auth">Sign in</a></li>
            </ul>
          </div>
          <div className="mkt-footer__col">
            <h4>Consulting</h4>
            <ul>
              <li><a href="/consulting">Approach</a></li>
              <li><a href="/consulting#research">Research</a></li>
              <li><a href="mailto:consulting@agentdash.com">Talk to us</a></li>
            </ul>
          </div>
          <div className="mkt-footer__col">
            <h4>Company</h4>
            <ul>
              <li><a href="/about">About</a></li>
              <li><a href="mailto:hello@agentdash.com">Contact</a></li>
            </ul>
          </div>
        </div>
        <div className="mkt-footer__legal">
          <span>© {year} AgentDash. All rights reserved.</span>
          <span>consulting@agentdash.com</span>
        </div>
      </div>
    </footer>
  );
}
