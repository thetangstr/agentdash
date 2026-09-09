import "./MarketingHeader.css";
import { useEffect, useId, useState } from "react";
import { Menu, X } from "lucide-react";
import { Button } from "./components/Button";
import { AgentDashLogo } from "./components/AgentDashLogo";
import { CTA, NAV_LINKS } from "./content/site";

export function MarketingHeader() {
  const [open, setOpen] = useState(false);
  const menuId = useId();

  // Close the sheet on Escape and whenever the viewport grows past the
  // breakpoint, so a rotated phone never keeps a stale overlay open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const mq = window.matchMedia("(min-width: 861px)");
    const onChange = () => {
      if (mq.matches) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    mq.addEventListener("change", onChange);
    return () => {
      window.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onChange);
    };
  }, [open]);

  return (
    <header className="mkt-header">
      <div className="mkt-header__inner">
        <a href="/" className="mkt-header__brand" aria-label="AgentDash home">
          <AgentDashLogo size="md" />
        </a>
        <nav className="mkt-header__nav" aria-label="Primary">
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href}>{l.label}</a>
          ))}
        </nav>
        <div className="mkt-header__cta">
          <Button href={CTA.signIn.href} variant="link">{CTA.signIn.label}</Button>
          <Button href={CTA.walkthrough.href}>{CTA.walkthrough.label}</Button>
        </div>
        <button
          type="button"
          className="mkt-header__toggle"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X size={22} strokeWidth={1.75} aria-hidden /> : <Menu size={22} strokeWidth={1.75} aria-hidden />}
        </button>
      </div>
      <div id={menuId} className="mkt-header__sheet" hidden={!open}>
        <nav aria-label="Primary, mobile" className="mkt-header__sheet-nav">
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} onClick={() => setOpen(false)}>{l.label}</a>
          ))}
          <a href={CTA.signIn.href} onClick={() => setOpen(false)}>{CTA.signIn.label}</a>
        </nav>
        <div className="mkt-header__sheet-cta">
          <Button href={CTA.walkthrough.href}>{CTA.walkthrough.label}</Button>
          <Button href={CTA.demo.href} variant="ghost">{CTA.demo.label}</Button>
        </div>
      </div>
    </header>
  );
}
