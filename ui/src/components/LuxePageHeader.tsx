// AgentDash: shared editorial page header.
// Pages opt in by rendering <LuxePageHeader eyebrow title subtitle meta /> instead
// of their own h1/p combo. Styles live in ui/src/styles/luxe.css (.lux-*).
//
// This component intentionally does NOT require the `.luxe-root` wrapper used by
// the Dashboard — the .lux-* class family targets semantic CSS vars (--foreground,
// --muted-foreground) that are already in play globally.

import type { ReactNode } from "react";

interface LuxePageHeaderProps {
  /** Small mono-uppercase label above the title (e.g. date stamp, section name). */
  eyebrow?: ReactNode;
  /** Serif display title. Pass a ReactNode to include a `<span className="soft">` for a muted italic connector phrase. */
  title: ReactNode;
  /** Sentence-tone subtitle under the title. */
  subtitle?: ReactNode;
  /** Optional right-aligned meta slot (live pulse, timestamp, mode tag). */
  meta?: ReactNode;
  /** Slim variant trims the bottom margin. */
  slim?: boolean;
}

export function LuxePageHeader({ eyebrow, title, subtitle, meta, slim }: LuxePageHeaderProps) {
  return (
    <div className="lux-page-head" style={slim ? { marginBottom: 16 } : undefined}>
      <div style={{ minWidth: 0 }}>
        {eyebrow ? <div className="lux-eyebrow">{eyebrow}</div> : null}
        <h1 className="lux-h1">{title}</h1>
        {subtitle ? <div className="lux-subtitle">{subtitle}</div> : null}
      </div>
      {meta ? <div className="lux-meta">{meta}</div> : null}
    </div>
  );
}
