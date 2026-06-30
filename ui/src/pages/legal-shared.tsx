// AgentDash — shared layout for the PUBLIC legal pages (/terms and /privacy).
// No auth, no sidebar, no company context. Both pages mount OUTSIDE
// CloudAccessGate in ui/src/App.tsx, the same public tier as /trial, /pricing,
// and /investors. The app shell sets `body { overflow: hidden }`, so each legal
// page owns its OWN scroll region (`h-screen overflow-y-auto`).
//
// Design: the "Porcelain" system — clay accent (var(--accent-500)), Manrope,
// hairline borders, generous radii (rounded-2xl), near-zero shadows. Mirrors
// PricingPage.tsx / InvestorsPage.tsx so the public marketing surface stays one
// coherent brand. Unlike those pages, these are intentionally STATIC: a legal
// document is a reading surface, so there is no scroll-reveal / IntersectionObserver
// / setTimeout choreography here — content renders directly.
//
// IMPORTANT: this is template legal content. It is a starting point that must be
// reviewed with legal counsel before anyone relies on it, and it carries clearly
// marked placeholders the founder must complete (legal entity + registered
// address; governing law / jurisdiction). See LAST_UPDATED below.

import type { ReactNode } from "react";
import { ArrowRight, Sparkles, ShieldAlert } from "lucide-react";

const CLAY = "var(--accent-500)";

// Single source of truth for the "Last updated" date shown in the notice banner
// on BOTH legal pages. Update this whenever the policy/terms text changes.
export const LAST_UPDATED = "June 30, 2026";

// The standing template disclaimer shown at the top of both pages.
export const TEMPLATE_NOTICE = `Template — review with legal counsel before relying on this. Last updated: ${LAST_UPDATED}.`;

// Contact address used across both documents.
export const LEGAL_CONTACT_EMAIL = "edward@agentdash.cloud";

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="flex items-center justify-center rounded-lg text-white"
        style={{ width: 26, height: 26, background: CLAY, flex: "none" }}
      >
        <Sparkles style={{ width: 14, height: 14 }} />
      </span>
      <span className="text-[15px] font-extrabold tracking-[-0.03em] text-foreground">
        AgentDash
      </span>
    </span>
  );
}

// A top-level document section: an <h2> heading + arbitrary body content.
export function LegalSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section style={{ marginTop: 36 }}>
      <h2
        className="text-foreground"
        style={{
          fontSize: 21,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          lineHeight: 1.15,
          scrollMarginTop: 80,
        }}
      >
        {title}
      </h2>
      <div
        className="text-muted-foreground"
        style={{ fontSize: 15, lineHeight: 1.65, marginTop: 12 }}
      >
        {children}
      </div>
    </section>
  );
}

// A standard reading paragraph inside a LegalSection.
export function P({ children }: { children: ReactNode }) {
  return <p style={{ marginTop: 12 }}>{children}</p>;
}

// A simple bulleted list inside a LegalSection.
export function List({ items }: { items: ReactNode[] }) {
  return (
    <ul style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map((item, i) => (
        <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: CLAY,
              flex: "none",
              marginTop: 9,
            }}
          />
          <span style={{ flex: 1 }}>{item}</span>
        </li>
      ))}
    </ul>
  );
}

// A clearly-marked placeholder the founder must complete before relying on the
// document (legal entity, governing law, etc.). Rendered inline, visually flagged.
export function Placeholder({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        display: "inline",
        fontWeight: 700,
        color: CLAY,
        background: `color-mix(in oklab, ${CLAY} 10%, transparent)`,
        borderRadius: 6,
        padding: "1px 6px",
      }}
    >
      {children}
    </span>
  );
}

// The shared page shell: header, the template-notice banner, the document
// reading column, and the footer. `eyebrow` + `title` head the document.
export function LegalPageShell({
  eyebrow,
  title,
  intro,
  children,
}: {
  eyebrow: string;
  title: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="h-screen overflow-y-auto bg-background text-foreground">
      {/* top bar */}
      <header
        className="sticky top-0 z-40 bg-background/85 backdrop-blur"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div
          className="mx-auto flex w-full max-w-[1080px] items-center justify-between px-6 sm:px-7"
          style={{ height: 60 }}
        >
          <a href="/" aria-label="AgentDash">
            <Wordmark />
          </a>
          <nav className="flex items-center gap-2.5">
            <a
              href="/auth"
              className="hidden rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-[var(--accent-500)] sm:inline-flex"
            >
              Sign in
            </a>
            <a
              href="/auth?mode=sign_up"
              className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-500)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              Start free
              <ArrowRight className="size-4" />
            </a>
          </nav>
        </div>
      </header>

      {/* document reading column */}
      <main className="mx-auto w-full px-6 sm:px-7" style={{ maxWidth: 760, padding: "56px 24px 40px" }}>
        {/* template notice banner */}
        <div
          role="note"
          className="border rounded-2xl"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            padding: "14px 16px",
            borderColor: CLAY,
            background: `color-mix(in oklab, ${CLAY} 7%, var(--card))`,
          }}
        >
          <ShieldAlert size={18} className="text-[var(--accent-500)]" style={{ flex: "none", marginTop: 1 }} />
          <span className="text-foreground" style={{ fontSize: 13.5, lineHeight: 1.5, fontWeight: 600 }}>
            {TEMPLATE_NOTICE}
          </span>
        </div>

        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            textTransform: "uppercase",
            letterSpacing: "0.14em",
            color: CLAY,
            marginTop: 36,
          }}
        >
          {eyebrow}
        </div>
        <h1
          className="text-foreground"
          style={{ fontSize: 36, fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1.05, marginTop: 12 }}
        >
          {title}
        </h1>
        <p className="text-muted-foreground" style={{ fontSize: 13, marginTop: 12 }}>
          Last updated: {LAST_UPDATED}
        </p>
        <div className="text-muted-foreground" style={{ fontSize: 16, lineHeight: 1.65, marginTop: 18 }}>
          {intro}
        </div>

        {children}

        {/* contact footer block */}
        <section style={{ marginTop: 40 }}>
          <div className="bg-card border border-border rounded-2xl" style={{ padding: 20 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 800,
                textTransform: "uppercase",
                letterSpacing: "0.14em",
                color: "var(--muted-foreground)",
              }}
            >
              Contact
            </div>
            <a
              href={`mailto:${LEGAL_CONTACT_EMAIL}`}
              className="inline-flex items-center gap-2 font-semibold transition-opacity hover:opacity-80"
              style={{ fontSize: 16, color: CLAY, marginTop: 8 }}
            >
              {LEGAL_CONTACT_EMAIL}
              <ArrowRight className="size-4" />
            </a>
          </div>
        </section>
      </main>

      {/* footer */}
      <footer style={{ borderTop: "1px solid var(--border)" }}>
        <div
          className="mx-auto flex w-full max-w-[1080px] flex-wrap items-center justify-between gap-4 px-6 sm:px-7"
          style={{ padding: "24px" }}
        >
          <Wordmark />
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            <a href="/terms" className="transition-colors hover:text-foreground">Terms</a>
            <a href="/privacy" className="transition-colors hover:text-foreground">Privacy</a>
            <a href="/pricing" className="transition-colors hover:text-foreground">Pricing</a>
            <a href="/trial" className="transition-colors hover:text-foreground">Test drive</a>
            <a href="/" className="transition-colors hover:text-foreground">Home</a>
            <a href="/auth" className="transition-colors hover:text-foreground">Sign in</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
