import "./MarketingShell.css";
import type { ReactNode } from "react";
import { MarketingHeader } from "./MarketingHeader";
import { MarketingFooter } from "./MarketingFooter";

export function MarketingShell({ children }: { children: ReactNode }) {
  return (
    <div className="mkt-root">
      <a href="#mkt-main" className="mkt-skip-link">Skip to content</a>
      <MarketingHeader />
      <main id="mkt-main">{children}</main>
      <MarketingFooter />
    </div>
  );
}
