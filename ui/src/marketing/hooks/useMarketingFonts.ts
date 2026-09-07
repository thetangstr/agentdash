import { useEffect } from "react";

const LINK_ID = "mkt-fonts";
const HREF =
  "https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&family=Inter+Tight:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap";

/**
 * The marketing surface uses its own type families (Newsreader, Inter Tight,
 * JetBrains Mono). index.html only loads the dashboard's Manrope, so the
 * families are requested when a marketing page mounts and left in place for
 * the session. The dashboard never pays for them on a cold start.
 */
export function useMarketingFonts() {
  useEffect(() => {
    if (document.getElementById(LINK_ID)) return;
    const link = document.createElement("link");
    link.id = LINK_ID;
    link.rel = "stylesheet";
    link.href = HREF;
    document.head.appendChild(link);
  }, []);
}
