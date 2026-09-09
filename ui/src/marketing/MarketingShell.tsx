import "./MarketingShell.css";
import type { ReactNode } from "react";
import { MarketingHeader } from "./MarketingHeader";
import { MarketingFooter } from "./MarketingFooter";
import { useMarketingFonts } from "./hooks/useMarketingFonts";

export function MarketingShell({ children }: { children: ReactNode }) {
  useMarketingFonts();
  return (
    <div className="mkt-root">
      <a href="#mkt-main" className="mkt-skip-link">Skip to content</a>
      <MarketingHeader />
      <main id="mkt-main">{children}</main>
      <MarketingFooter />
    </div>
  );
}
