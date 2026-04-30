# AgentDash Marketing Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a 5-route marketing surface (`/`, `/consulting`, `/about`, plus a restyled `/assess` and `/assess/history`) for AgentDash, with a scroll-driven cinematic descent through 7 architectural layers as the landing-page centerpiece.

**Architecture:** New isolated `ui/src/marketing/` namespace owns its own CSS variables, fonts, components, sections, and pages. The existing dashboard chrome and shadcn surface are untouched. Marketing routes mount at the App's top-level Routes block, OUTSIDE `CloudAccessGate`. The landing page itself short-circuits to the existing `<CompanyRootRedirect />` for logged-in users so the existing dashboard entry behavior is preserved.

**Tech Stack:** React 19, Vite, Tailwind 4 (used only for layout primitives like `flex`/`grid`/spacing — colors and typography come from CSS variables, not Tailwind config), TypeScript, vitest + RTL for unit/component tests, Playwright for E2E. Fonts via Fontsource (no Google Fonts CDN). No Framer Motion.

**Spec:** [docs/superpowers/specs/2026-04-28-marketing-site-design.md](../specs/2026-04-28-marketing-site-design.md)

**Verification command (run before any commit that closes a phase):**
```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

---

## Phase 0: Foundation — fonts, tokens, typography

### Task 0.1: Install Fontsource packages

**Files:**
- Modify: `ui/package.json`

- [ ] **Step 1: Install Fontsource packages**

Run from worktree root:
```sh
pnpm add -F @agentdash/ui @fontsource/newsreader @fontsource-variable/inter-tight @fontsource/jetbrains-mono
```

Expected: three packages added under `ui/package.json` dependencies. `pnpm-lock.yaml` updates.

- [ ] **Step 2: Verify install**

Run:
```sh
pnpm -F @agentdash/ui ls @fontsource/newsreader @fontsource-variable/inter-tight @fontsource/jetbrains-mono
```

Expected: all three listed with versions.

- [ ] **Step 3: Commit**

```sh
git add ui/package.json pnpm-lock.yaml
git commit -m "chore(ui): add Fontsource packages for marketing typography"
```

### Task 0.2: Create marketing namespace and tokens.css

**Files:**
- Create: `ui/src/marketing/tokens.css`

- [ ] **Step 1: Create the file**

Contents (exact):
```css
/*
 * Marketing surface design tokens.
 * Used only by ui/src/marketing/**. Do not import from product UI.
 */
:root {
  --mkt-surface-cream: #faf9f5;
  --mkt-surface-cream-2: #f3efe6;
  --mkt-ink: #1f1e1d;
  --mkt-ink-soft: #54524f;
  --mkt-rule: #e8e3d6;
  --mkt-accent: #cc785c;
  --mkt-accent-ink: #7a3f2a;

  /* spacing scale (8px base) */
  --mkt-space-1: 8px;
  --mkt-space-2: 16px;
  --mkt-space-3: 24px;
  --mkt-space-4: 32px;
  --mkt-space-6: 48px;
  --mkt-space-8: 64px;
  --mkt-space-12: 96px;
  --mkt-space-16: 128px;
  --mkt-space-20: 160px;

  /* container */
  --mkt-container-max: 1200px;
  --mkt-container-gutter: 32px;

  /* motion */
  --mkt-ease: cubic-bezier(0.16, 1, 0.3, 1);
}
```

- [ ] **Step 2: Commit**

```sh
git add ui/src/marketing/tokens.css
git commit -m "feat(marketing): design tokens for cream + coral palette"
```

### Task 0.3: Create fonts.css

**Files:**
- Create: `ui/src/marketing/fonts.css`

- [ ] **Step 1: Create the file**

Contents (exact):
```css
/*
 * Marketing fonts. Imports Fontsource subsets so we ship only Latin glyphs.
 */
@import "@fontsource/newsreader/latin-400.css";
@import "@fontsource/newsreader/latin-500.css";
@import "@fontsource/newsreader/latin-600.css";

@import "@fontsource-variable/inter-tight/index.css";

@import "@fontsource/jetbrains-mono/latin-400.css";
@import "@fontsource/jetbrains-mono/latin-500.css";

:root {
  --mkt-font-serif: "Newsreader", "Times New Roman", serif;
  --mkt-font-sans: "Inter Tight Variable", "Inter Tight", "Inter", system-ui, sans-serif;
  --mkt-font-mono: "JetBrains Mono", ui-monospace, monospace;
}
```

- [ ] **Step 2: Commit**

```sh
git add ui/src/marketing/fonts.css
git commit -m "feat(marketing): self-host Newsreader, Inter Tight, JetBrains Mono"
```

### Task 0.4: Create typography.css

**Files:**
- Create: `ui/src/marketing/typography.css`

- [ ] **Step 1: Create the file**

Contents (exact):
```css
/*
 * Marketing type scale. Only applied within `.mkt-root` so it never leaks.
 */
.mkt-root {
  font-family: var(--mkt-font-sans);
  color: var(--mkt-ink);
  background: var(--mkt-surface-cream);
  font-size: 17px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

.mkt-root .mkt-display-hero {
  font-family: var(--mkt-font-serif);
  font-weight: 500;
  font-size: clamp(48px, 7vw, 80px);
  line-height: 1.05;
  letter-spacing: -0.01em;
}

.mkt-root .mkt-display-section {
  font-family: var(--mkt-font-serif);
  font-weight: 500;
  font-size: clamp(36px, 5vw, 56px);
  line-height: 1.1;
  letter-spacing: -0.005em;
}

.mkt-root .mkt-display-page {
  font-family: var(--mkt-font-serif);
  font-weight: 500;
  font-size: clamp(40px, 6vw, 56px);
  line-height: 1.05;
}

.mkt-root .mkt-mission {
  font-family: var(--mkt-font-serif);
  font-weight: 400;
  font-size: clamp(28px, 4vw, 44px);
  line-height: 1.25;
  max-width: 28ch;
  margin-inline: auto;
  text-align: center;
}

.mkt-root .mkt-body-lg {
  font-size: 19px;
  line-height: 1.55;
}

.mkt-root .mkt-eyebrow {
  font-family: var(--mkt-font-mono);
  font-weight: 500;
  font-size: 12px;
  line-height: 1;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--mkt-ink-soft);
}

.mkt-root .mkt-caption {
  font-size: 14px;
  line-height: 1.4;
  color: var(--mkt-ink-soft);
}

.mkt-root a { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
.mkt-root a:hover { color: var(--mkt-accent-ink); }

.mkt-root *:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 4px;
  border-radius: 2px;
}
```

- [ ] **Step 2: Commit**

```sh
git add ui/src/marketing/typography.css
git commit -m "feat(marketing): type scale and base reset"
```

### Task 0.5: Wire CSS into the app entry

**Files:**
- Modify: `ui/src/main.tsx`

- [ ] **Step 1: Read main.tsx**

```sh
cat ui/src/main.tsx
```

Locate the existing CSS imports (e.g. `import "./index.css"`).

- [ ] **Step 2: Add the three marketing CSS imports**

Below the existing `index.css` import, add:
```ts
import "./marketing/tokens.css";
import "./marketing/fonts.css";
import "./marketing/typography.css";
```

- [ ] **Step 3: Verify dev server starts and dashboard still renders**

```sh
pnpm dev:once
```

Open `http://localhost:3100`. Confirm: the existing dashboard chrome looks identical (no font or color regression). The marketing styles are scoped behind `.mkt-root`, so no leak.

- [ ] **Step 4: Commit**

```sh
git add ui/src/main.tsx
git commit -m "feat(marketing): wire tokens/fonts/typography into entry"
```

---

## Phase 1: Hooks and primitives

### Task 1.1: usePrefersReducedMotion hook (TDD)

**Files:**
- Create: `ui/src/marketing/hooks/usePrefersReducedMotion.ts`
- Test: `ui/src/marketing/hooks/__tests__/usePrefersReducedMotion.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePrefersReducedMotion } from "../usePrefersReducedMotion";

type Listener = (event: { matches: boolean }) => void;

describe("usePrefersReducedMotion", () => {
  let listeners: Listener[] = [];
  let currentMatches = false;

  beforeEach(() => {
    listeners = [];
    currentMatches = false;
    vi.stubGlobal("matchMedia", (q: string) => ({
      media: q,
      get matches() { return currentMatches; },
      addEventListener: (_: string, l: Listener) => listeners.push(l),
      removeEventListener: (_: string, l: Listener) => {
        listeners = listeners.filter((x) => x !== l);
      },
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns false when the user has no reduced-motion preference", () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });

  it("returns true when the media query matches", () => {
    currentMatches = true;
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });

  it("flips when the media query change event fires", () => {
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    act(() => {
      currentMatches = true;
      listeners.forEach((l) => l({ matches: true }));
    });
    expect(result.current).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```sh
pnpm -F @agentdash/ui test usePrefersReducedMotion
```

Expected: test file fails to import — `usePrefersReducedMotion` does not exist.

- [ ] **Step 3: Implement the hook**

Create `ui/src/marketing/hooks/usePrefersReducedMotion.ts`:
```ts
import { useEffect, useState } from "react";

export function usePrefersReducedMotion(): boolean {
  const [prefers, setPrefers] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const listener = (e: MediaQueryListEvent) => setPrefers(e.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  return prefers;
}
```

- [ ] **Step 4: Run test, expect pass**

```sh
pnpm -F @agentdash/ui test usePrefersReducedMotion
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```sh
git add ui/src/marketing/hooks/usePrefersReducedMotion.ts ui/src/marketing/hooks/__tests__/usePrefersReducedMotion.test.ts
git commit -m "feat(marketing): usePrefersReducedMotion hook"
```

### Task 1.2: useDescentProgress hook (TDD)

**Files:**
- Create: `ui/src/marketing/hooks/useDescentProgress.ts`
- Test: `ui/src/marketing/hooks/__tests__/useDescentProgress.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { computeProgress } from "../useDescentProgress";

describe("computeProgress", () => {
  it("returns 0 when the section top is at viewport top (just entering)", () => {
    expect(computeProgress({ top: 0, height: 7000 }, 1000)).toBe(0);
  });

  it("returns ~1 when the section bottom aligns with viewport bottom (last layer settled)", () => {
    // section is 7000 tall; pinning ends when (height - viewport) of scroll has elapsed.
    // top = -(height - viewport) means we've scrolled exactly that amount past the top.
    expect(computeProgress({ top: -(7000 - 1000), height: 7000 }, 1000)).toBeCloseTo(1, 5);
  });

  it("returns 0.5 at the midpoint of the pinned travel", () => {
    // halfway through (height - viewport) of scroll
    expect(computeProgress({ top: -(7000 - 1000) / 2, height: 7000 }, 1000)).toBeCloseTo(0.5, 5);
  });

  it("clamps to 0 when section is below the viewport", () => {
    expect(computeProgress({ top: 500, height: 7000 }, 1000)).toBe(0);
  });

  it("clamps to 1 when section is fully scrolled past", () => {
    expect(computeProgress({ top: -10000, height: 7000 }, 1000)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```sh
pnpm -F @agentdash/ui test useDescentProgress
```

Expected: import fails — `computeProgress` not exported.

- [ ] **Step 3: Implement the hook**

Create `ui/src/marketing/hooks/useDescentProgress.ts`:
```ts
import { useEffect, useRef, useState } from "react";

export function computeProgress(
  rect: { top: number; height: number },
  viewportHeight: number,
): number {
  const travel = rect.height - viewportHeight;
  if (travel <= 0) return 0;
  // top is 0 when section enters viewport from above; goes negative as we scroll past.
  // Progress = how far through `travel` we've scrolled, clamped 0..1.
  const scrolled = -rect.top;
  if (scrolled <= 0) return 0;
  if (scrolled >= travel) return 1;
  return scrolled / travel;
}

export function useDescentProgress(ref: React.RefObject<HTMLElement | null>): number {
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let mounted = true;
    const tick = () => {
      if (!mounted) return;
      const el = ref.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const next = computeProgress(
          { top: rect.top, height: rect.height },
          window.innerHeight,
        );
        setProgress((prev) => (Math.abs(prev - next) < 0.001 ? prev : next));
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      mounted = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [ref]);

  return progress;
}
```

- [ ] **Step 4: Run test, expect pass**

```sh
pnpm -F @agentdash/ui test useDescentProgress
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```sh
git add ui/src/marketing/hooks/useDescentProgress.ts ui/src/marketing/hooks/__tests__/useDescentProgress.test.ts
git commit -m "feat(marketing): useDescentProgress + computeProgress"
```

### Task 1.3: Button component

**Files:**
- Create: `ui/src/marketing/components/Button.tsx`
- Create: `ui/src/marketing/components/Button.css`
- Test: `ui/src/marketing/components/__tests__/Button.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "../Button";

describe("Button", () => {
  it("renders as <a> when given href", () => {
    render(<Button href="/foo">Hello</Button>);
    const el = screen.getByRole("link", { name: "Hello" });
    expect(el).toBeInTheDocument();
    expect(el.getAttribute("href")).toBe("/foo");
  });

  it("renders as <button> when no href", () => {
    render(<Button onClick={() => {}}>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("applies primary variant by default", () => {
    render(<Button href="/x">x</Button>);
    expect(screen.getByRole("link")).toHaveClass("mkt-btn--primary");
  });

  it("applies ghost variant when specified", () => {
    render(<Button href="/x" variant="ghost">x</Button>);
    expect(screen.getByRole("link")).toHaveClass("mkt-btn--ghost");
  });
});
```

- [ ] **Step 2: Run test, expect failure**

```sh
pnpm -F @agentdash/ui test Button
```

Expected: import fails.

- [ ] **Step 3: Create Button.css**

```css
.mkt-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 14px 22px;
  border-radius: 8px;
  font-family: var(--mkt-font-sans);
  font-size: 16px;
  font-weight: 600;
  line-height: 1;
  text-decoration: none;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background-color 160ms var(--mkt-ease), color 160ms var(--mkt-ease), border-color 160ms var(--mkt-ease);
  white-space: nowrap;
}
.mkt-btn--primary {
  background: var(--mkt-accent);
  color: #fff;
}
.mkt-btn--primary:hover { background: var(--mkt-accent-ink); }
.mkt-btn--ghost {
  background: transparent;
  color: var(--mkt-ink);
  border-color: var(--mkt-ink);
}
.mkt-btn--ghost:hover { background: var(--mkt-ink); color: var(--mkt-surface-cream); }
.mkt-btn--link {
  background: transparent;
  color: var(--mkt-ink);
  padding: 0;
  border: none;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.mkt-btn--link:hover { color: var(--mkt-accent-ink); }
```

- [ ] **Step 4: Create Button.tsx**

```tsx
import "./Button.css";
import type { ReactNode, MouseEvent } from "react";

type Variant = "primary" | "ghost" | "link";

interface BaseProps {
  children: ReactNode;
  variant?: Variant;
  className?: string;
}

interface AnchorProps extends BaseProps {
  href: string;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}

interface ButtonProps extends BaseProps {
  href?: undefined;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  type?: "button" | "submit";
}

export function Button(props: AnchorProps | ButtonProps) {
  const variant: Variant = props.variant ?? "primary";
  const cls = ["mkt-btn", `mkt-btn--${variant}`, props.className].filter(Boolean).join(" ");

  if ("href" in props && props.href !== undefined) {
    return (
      <a href={props.href} onClick={props.onClick} className={cls}>
        {props.children}
      </a>
    );
  }
  return (
    <button type={props.type ?? "button"} onClick={props.onClick} className={cls}>
      {props.children}
    </button>
  );
}
```

- [ ] **Step 5: Wire Button.css import & re-run test**

```sh
pnpm -F @agentdash/ui test Button
```

Expected: 4 passed.

- [ ] **Step 6: Commit**

```sh
git add ui/src/marketing/components/Button.tsx ui/src/marketing/components/Button.css ui/src/marketing/components/__tests__/Button.test.tsx
git commit -m "feat(marketing): Button (primary/ghost/link variants)"
```

### Task 1.4: Eyebrow, SectionContainer, QuoteBlock, LogoStrip

**Files:**
- Create: `ui/src/marketing/components/Eyebrow.tsx`
- Create: `ui/src/marketing/components/SectionContainer.tsx`
- Create: `ui/src/marketing/components/QuoteBlock.tsx`
- Create: `ui/src/marketing/components/LogoStrip.tsx`
- Create: `ui/src/marketing/components/SectionContainer.css`
- Create: `ui/src/marketing/components/QuoteBlock.css`
- Create: `ui/src/marketing/components/LogoStrip.css`
- Test: `ui/src/marketing/components/__tests__/primitives.test.tsx`

- [ ] **Step 1: Eyebrow.tsx**

```tsx
import type { ReactNode } from "react";

export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="mkt-eyebrow">{children}</div>;
}
```

- [ ] **Step 2: SectionContainer.css**

```css
.mkt-section {
  padding-block: clamp(96px, 12vh, 160px);
}
.mkt-section--cream-2 { background: var(--mkt-surface-cream-2); }
.mkt-section__inner {
  max-width: var(--mkt-container-max);
  margin-inline: auto;
  padding-inline: var(--mkt-container-gutter);
}
```

- [ ] **Step 3: SectionContainer.tsx**

```tsx
import "./SectionContainer.css";
import type { ReactNode } from "react";

export function SectionContainer({
  children,
  background = "cream",
  id,
  as: Tag = "section",
}: {
  children: ReactNode;
  background?: "cream" | "cream-2";
  id?: string;
  as?: "section" | "div";
}) {
  const cls = ["mkt-section", background === "cream-2" ? "mkt-section--cream-2" : null]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag id={id} className={cls}>
      <div className="mkt-section__inner">{children}</div>
    </Tag>
  );
}
```

- [ ] **Step 4: QuoteBlock.css**

```css
.mkt-quote {
  font-family: var(--mkt-font-serif);
  font-weight: 400;
  font-size: clamp(24px, 3vw, 32px);
  line-height: 1.3;
  text-align: center;
  max-width: 28ch;
  margin-inline: auto;
}
.mkt-quote__attr {
  margin-top: 24px;
  text-align: center;
}
```

- [ ] **Step 5: QuoteBlock.tsx**

```tsx
import "./QuoteBlock.css";

export function QuoteBlock({ quote, attribution }: { quote: string; attribution: string }) {
  return (
    <figure>
      <blockquote className="mkt-quote">"{quote}"</blockquote>
      <figcaption className="mkt-quote__attr mkt-caption">{attribution}</figcaption>
    </figure>
  );
}
```

- [ ] **Step 6: LogoStrip.css**

```css
.mkt-logo-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 32px;
  flex-wrap: wrap;
}
.mkt-logo-strip__item {
  height: 28px;
  opacity: 0.7;
  filter: grayscale(1);
}
.mkt-logo-strip__placeholder {
  height: 28px;
  width: 120px;
  background: var(--mkt-rule);
  border-radius: 4px;
}
```

- [ ] **Step 7: LogoStrip.tsx**

```tsx
import "./LogoStrip.css";

export interface LogoItem {
  name: string;
  src?: string; // when undefined, renders a placeholder rectangle
}

export function LogoStrip({ items }: { items: LogoItem[] }) {
  return (
    <div className="mkt-logo-strip" role="list" aria-label="Customers and partners">
      {items.map((item) => (
        <div key={item.name} role="listitem" aria-label={item.name}>
          {item.src ? (
            <img src={item.src} alt={item.name} className="mkt-logo-strip__item" />
          ) : (
            <div className="mkt-logo-strip__placeholder" />
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 8: Test all four primitives**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Eyebrow } from "../Eyebrow";
import { SectionContainer } from "../SectionContainer";
import { QuoteBlock } from "../QuoteBlock";
import { LogoStrip } from "../LogoStrip";

describe("Eyebrow", () => {
  it("renders its children with the eyebrow class", () => {
    render(<Eyebrow>READY</Eyebrow>);
    const el = screen.getByText("READY");
    expect(el).toHaveClass("mkt-eyebrow");
  });
});

describe("SectionContainer", () => {
  it("renders as <section> by default with cream background class", () => {
    const { container } = render(<SectionContainer><p>hi</p></SectionContainer>);
    const section = container.querySelector("section");
    expect(section).toBeInTheDocument();
    expect(section).toHaveClass("mkt-section");
    expect(section).not.toHaveClass("mkt-section--cream-2");
  });

  it("applies cream-2 class when requested", () => {
    const { container } = render(
      <SectionContainer background="cream-2"><p>hi</p></SectionContainer>,
    );
    expect(container.querySelector("section")).toHaveClass("mkt-section--cream-2");
  });
});

describe("QuoteBlock", () => {
  it("renders quote and attribution", () => {
    render(<QuoteBlock quote="Ship it" attribution="A. Person" />);
    expect(screen.getByText(/Ship it/)).toBeInTheDocument();
    expect(screen.getByText("A. Person")).toBeInTheDocument();
  });
});

describe("LogoStrip", () => {
  it("renders one item per logo, image when src is provided", () => {
    render(<LogoStrip items={[{ name: "ACME", src: "/x.svg" }, { name: "Beta" }]} />);
    expect(screen.getByAltText("ACME")).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
  });
});
```

- [ ] **Step 9: Run tests**

```sh
pnpm -F @agentdash/ui test primitives
```

Expected: 5 passed.

- [ ] **Step 10: Commit**

```sh
git add ui/src/marketing/components/
git commit -m "feat(marketing): Eyebrow, SectionContainer, QuoteBlock, LogoStrip"
```

### Task 1.5: MarketingHeader

**Files:**
- Create: `ui/src/marketing/MarketingHeader.tsx`
- Create: `ui/src/marketing/MarketingHeader.css`

- [ ] **Step 1: MarketingHeader.css**

```css
.mkt-header {
  position: sticky;
  top: 0;
  z-index: 50;
  background: rgba(250, 249, 245, 0.85);
  backdrop-filter: saturate(180%) blur(8px);
  border-bottom: 1px solid var(--mkt-rule);
}
.mkt-header__inner {
  max-width: var(--mkt-container-max);
  margin-inline: auto;
  padding: 16px var(--mkt-container-gutter);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
}
.mkt-header__brand {
  font-family: var(--mkt-font-serif);
  font-weight: 500;
  font-size: 22px;
  text-decoration: none;
  color: var(--mkt-ink);
}
.mkt-header__nav {
  display: flex;
  gap: 32px;
}
.mkt-header__nav a {
  text-decoration: none;
  font-size: 15px;
  color: var(--mkt-ink-soft);
}
.mkt-header__nav a:hover { color: var(--mkt-ink); }
.mkt-header__cta {
  display: flex;
  gap: 12px;
  align-items: center;
}
@media (max-width: 800px) {
  .mkt-header__nav { display: none; }
}
```

- [ ] **Step 2: MarketingHeader.tsx**

```tsx
import "./MarketingHeader.css";
import { Link } from "@/lib/router";
import { Button } from "./components/Button";

export function MarketingHeader() {
  return (
    <header className="mkt-header">
      <div className="mkt-header__inner">
        <Link to="/" className="mkt-header__brand">AgentDash</Link>
        <nav className="mkt-header__nav" aria-label="Primary">
          <Link to="/">Product</Link>
          <Link to="/consulting">Consulting</Link>
          <Link to="/assess">Assessment</Link>
          <Link to="/about">About</Link>
        </nav>
        <div className="mkt-header__cta">
          <Button href="/auth" variant="link">Sign in</Button>
          <Button href="/auth?mode=sign_up">Start free</Button>
        </div>
      </div>
    </header>
  );
}
```

Note: if `Link` from `@/lib/router` does not accept `className`, use a plain `<a>` for the brand instead. Check its type signature first via `pnpm -r typecheck`.

- [ ] **Step 3: Typecheck**

```sh
pnpm -F @agentdash/ui typecheck
```

If `Link` lacks `className` support, replace with `<a href="/" className="mkt-header__brand">AgentDash</a>` and similarly for nav links.

- [ ] **Step 4: Commit**

```sh
git add ui/src/marketing/MarketingHeader.tsx ui/src/marketing/MarketingHeader.css
git commit -m "feat(marketing): MarketingHeader with brand, nav, auth CTAs"
```

### Task 1.6: MarketingFooter

**Files:**
- Create: `ui/src/marketing/MarketingFooter.tsx`
- Create: `ui/src/marketing/MarketingFooter.css`

- [ ] **Step 1: MarketingFooter.css**

```css
.mkt-footer {
  background: var(--mkt-surface-cream-2);
  border-top: 1px solid var(--mkt-rule);
  padding: 80px var(--mkt-container-gutter) 40px;
}
.mkt-footer__inner {
  max-width: var(--mkt-container-max);
  margin-inline: auto;
}
.mkt-footer__cols {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr;
  gap: 48px;
}
.mkt-footer__brand {
  font-family: var(--mkt-font-serif);
  font-size: 22px;
  font-weight: 500;
  margin-bottom: 8px;
}
.mkt-footer__tagline { color: var(--mkt-ink-soft); max-width: 36ch; }
.mkt-footer__col h4 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--mkt-ink-soft);
  margin: 0 0 16px;
  font-family: var(--mkt-font-mono);
  font-weight: 500;
}
.mkt-footer__col ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.mkt-footer__col a { text-decoration: none; color: var(--mkt-ink); }
.mkt-footer__col a:hover { color: var(--mkt-accent-ink); }
.mkt-footer__legal {
  margin-top: 64px;
  padding-top: 24px;
  border-top: 1px solid var(--mkt-rule);
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: var(--mkt-ink-soft);
  flex-wrap: wrap;
  gap: 16px;
}
@media (max-width: 800px) {
  .mkt-footer__cols { grid-template-columns: 1fr 1fr; }
}
```

- [ ] **Step 2: MarketingFooter.tsx**

```tsx
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
```

- [ ] **Step 3: Commit**

```sh
git add ui/src/marketing/MarketingFooter.tsx ui/src/marketing/MarketingFooter.css
git commit -m "feat(marketing): MarketingFooter with three columns + legal"
```

### Task 1.7: MarketingShell

**Files:**
- Create: `ui/src/marketing/MarketingShell.tsx`
- Create: `ui/src/marketing/MarketingShell.css`
- Test: `ui/src/marketing/__tests__/MarketingShell.test.tsx`

- [ ] **Step 1: MarketingShell.css**

```css
.mkt-skip-link {
  position: absolute;
  top: -100px;
  left: 16px;
  background: var(--mkt-ink);
  color: var(--mkt-surface-cream);
  padding: 12px 16px;
  border-radius: 6px;
  text-decoration: none;
  z-index: 100;
}
.mkt-skip-link:focus { top: 12px; }
```

- [ ] **Step 2: MarketingShell.tsx**

```tsx
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
```

- [ ] **Step 3: Test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "@/lib/router";
import { MarketingShell } from "../MarketingShell";

describe("MarketingShell", () => {
  it("renders header, main, and footer", () => {
    render(
      <MemoryRouter>
        <MarketingShell>
          <h1>Hello</h1>
        </MarketingShell>
      </MemoryRouter>,
    );
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("includes a skip-to-content link as the first focusable element", () => {
    render(
      <MemoryRouter>
        <MarketingShell><div /></MarketingShell>
      </MemoryRouter>,
    );
    expect(screen.getByText("Skip to content")).toBeInTheDocument();
  });
});
```

If `MemoryRouter` is not exported from `@/lib/router`, replace the import with whatever the project's router test wrapper is (check existing tests under `ui/src/pages/__tests__/` for the convention).

- [ ] **Step 4: Run test**

```sh
pnpm -F @agentdash/ui test MarketingShell
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```sh
git add ui/src/marketing/MarketingShell.tsx ui/src/marketing/MarketingShell.css ui/src/marketing/__tests__/MarketingShell.test.tsx
git commit -m "feat(marketing): MarketingShell with skip link"
```

---

## Phase 2: Routing scaffold

### Task 2.1: Empty page placeholders

**Files:**
- Create: `ui/src/marketing/pages/Landing.tsx`
- Create: `ui/src/marketing/pages/Consulting.tsx`
- Create: `ui/src/marketing/pages/About.tsx`

- [ ] **Step 1: Landing.tsx (placeholder)**

```tsx
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@/lib/router";
import { authApi } from "../../api/auth";
import { queryKeys } from "../../lib/queryKeys";
import { healthApi } from "../../api/health";
import { MarketingShell } from "../MarketingShell";

export function Landing() {
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
  });

  if (healthQuery.isLoading || (isAuthenticatedMode && sessionQuery.isLoading)) return null;

  // local_trusted mode = no auth boundary; logged-in semantics apply.
  // authenticated mode + session = logged in.
  const loggedIn = !isAuthenticatedMode || Boolean(sessionQuery.data);
  if (loggedIn) return <Navigate to="/companies" replace />;

  return (
    <MarketingShell>
      <h1>Landing — placeholder</h1>
    </MarketingShell>
  );
}
```

Note: redirect target is `/companies` because that route runs through `<UnprefixedBoardRedirect />` which sends the user to their company's dashboard (matches existing `/` index behavior). Verify this is the correct target by checking App.tsx — if `<CompanyRootRedirect />` is exported, you can render it directly instead of navigating.

- [ ] **Step 2: Consulting.tsx (placeholder)**

```tsx
import { MarketingShell } from "../MarketingShell";

export function Consulting() {
  return (
    <MarketingShell>
      <h1>Consulting — placeholder</h1>
    </MarketingShell>
  );
}
```

- [ ] **Step 3: About.tsx (placeholder)**

```tsx
import { MarketingShell } from "../MarketingShell";

export function About() {
  return (
    <MarketingShell>
      <h1>About — placeholder</h1>
    </MarketingShell>
  );
}
```

- [ ] **Step 4: Verify the api/health import path exists**

```sh
ls ui/src/api/health.ts
```

If the path differs, adjust the import in Landing.tsx. (The existing CloudAccessGate in App.tsx uses `healthApi.get()` from `./api/health` per line 110-112.)

- [ ] **Step 5: Commit**

```sh
git add ui/src/marketing/pages/
git commit -m "feat(marketing): page placeholders for /, /consulting, /about"
```

### Task 2.2: Wire routes in App.tsx

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Read the public-route block**

```sh
grep -n "Routes\|<Route path=\"auth\"\|CloudAccessGate" ui/src/App.tsx | head -20
```

- [ ] **Step 2: Add imports at the top of App.tsx**

Near the existing page imports:
```tsx
import { Landing as MarketingLanding } from "./marketing/pages/Landing";
import { Consulting as MarketingConsulting } from "./marketing/pages/Consulting";
import { About as MarketingAbout } from "./marketing/pages/About";
```

- [ ] **Step 3: Add the three public marketing routes BEFORE the `<Route element={<CloudAccessGate />}>` block**

Find the line `<Route path="invite/:token" element={<InviteLandingPage />} />` and add immediately after it:
```tsx
        <Route path="/" element={<MarketingLanding />} />
        <Route path="consulting" element={<MarketingConsulting />} />
        <Route path="about" element={<MarketingAbout />} />
```

- [ ] **Step 4: Remove the now-shadowed gated index route**

Inside the `<Route element={<CloudAccessGate />}>` block, REMOVE:
```tsx
          <Route index element={<CompanyRootRedirect />} />
```

The new public `/` route handles this — when logged in, `<MarketingLanding />` itself navigates to `/companies` (which inside the gate is `<UnprefixedBoardRedirect />`), preserving prior behavior.

- [ ] **Step 5: Typecheck**

```sh
pnpm -F @agentdash/ui typecheck
```

Expected: clean.

- [ ] **Step 6: Manual smoke**

```sh
pnpm dev:once
```

Hit `http://localhost:3100/` (logged out) — expect Landing placeholder. Hit `/consulting`, `/about` — expect placeholders. Sign in (or be logged in already in local_trusted mode) and hit `/` — expect redirect to your company's dashboard (existing behavior preserved).

- [ ] **Step 7: Commit**

```sh
git add ui/src/App.tsx
git commit -m "feat(marketing): mount /, /consulting, /about as public routes"
```

### Task 2.3: E2E smoke test for routing

**Files:**
- Create: `tests/e2e/marketing-routing.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from "@playwright/test";

test.describe("marketing routing", () => {
  test("logged-out / shows the landing page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("/consulting renders", async ({ page }) => {
    await page.goto("/consulting");
    await expect(page.getByRole("heading", { level: 1, name: /consulting/i })).toBeVisible();
  });

  test("/about renders", async ({ page }) => {
    await page.goto("/about");
    await expect(page.getByRole("heading", { level: 1, name: /about/i })).toBeVisible();
  });

  test("clicking Start free in header navigates to /auth?mode=sign_up", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Start free" }).first().click();
    await expect(page).toHaveURL(/\/auth\?mode=sign_up/);
  });
});
```

- [ ] **Step 2: Run**

```sh
pnpm -F @agentdash/ui exec playwright test tests/e2e/marketing-routing.spec.ts
```

If the project's playwright command differs, check `package.json` scripts. Expected: 4 passed.

- [ ] **Step 3: Commit**

```sh
git add tests/e2e/marketing-routing.spec.ts
git commit -m "test(marketing): e2e routing smoke"
```

---

## Phase 3: Layer diagrams

### Task 3.1: Diagram SVG components (7 files, batched)

**Files (each ~40–80 lines):**
- Create: `ui/src/marketing/diagrams/ControlPlaneDiagram.tsx`
- Create: `ui/src/marketing/diagrams/OrchestrationDiagram.tsx`
- Create: `ui/src/marketing/diagrams/WorkspacesDiagram.tsx`
- Create: `ui/src/marketing/diagrams/AgentPrimitivesDiagram.tsx`
- Create: `ui/src/marketing/diagrams/InteropDiagram.tsx`
- Create: `ui/src/marketing/diagrams/TrustSafetyDiagram.tsx`
- Create: `ui/src/marketing/diagrams/ModelServingDiagram.tsx`

Each diagram is a single `<svg>` with `viewBox="0 0 320 200"`, stroke-only line work in `currentColor`, line weight `1.5`, and one filled coral element.

- [ ] **Step 1: ControlPlaneDiagram.tsx (org tree, board node on top)**

```tsx
export function ControlPlaneDiagram() {
  return (
    <svg viewBox="0 0 320 200" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {/* board node */}
      <rect x="120" y="20" width="80" height="32" rx="4" fill="var(--mkt-accent)" stroke="none" />
      <text x="160" y="40" textAnchor="middle" fontSize="12" fill="#fff" fontFamily="var(--mkt-font-mono)">BOARD</text>
      {/* CEO */}
      <line x1="160" y1="52" x2="160" y2="80" />
      <rect x="130" y="80" width="60" height="28" rx="4" />
      <text x="160" y="98" textAnchor="middle" fontSize="11" fill="currentColor">CEO</text>
      {/* execs */}
      <line x1="160" y1="108" x2="160" y2="130" />
      <line x1="80" y1="130" x2="240" y2="130" />
      <line x1="80" y1="130" x2="80" y2="148" />
      <line x1="160" y1="130" x2="160" y2="148" />
      <line x1="240" y1="130" x2="240" y2="148" />
      <rect x="55" y="148" width="50" height="24" rx="4" />
      <rect x="135" y="148" width="50" height="24" rx="4" />
      <rect x="215" y="148" width="50" height="24" rx="4" />
    </svg>
  );
}
```

- [ ] **Step 2: OrchestrationDiagram.tsx (directed graph, three highlighted edges)**

```tsx
export function OrchestrationDiagram() {
  return (
    <svg viewBox="0 0 320 200" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {/* nodes */}
      {[
        { x: 40, y: 40 },
        { x: 160, y: 30 },
        { x: 280, y: 50 },
        { x: 100, y: 110 },
        { x: 220, y: 120 },
        { x: 160, y: 170 },
      ].map((n, i) => (
        <circle key={i} cx={n.x} cy={n.y} r="10" fill="var(--mkt-surface-cream)" />
      ))}
      {/* normal edges */}
      <line x1="40" y1="40" x2="100" y2="110" />
      <line x1="280" y1="50" x2="220" y2="120" />
      <line x1="160" y1="30" x2="220" y2="120" />
      <line x1="100" y1="110" x2="160" y2="170" />
      {/* highlighted edges (coral) */}
      <line x1="160" y1="30" x2="100" y2="110" stroke="var(--mkt-accent)" strokeWidth="2" />
      <line x1="100" y1="110" x2="220" y2="120" stroke="var(--mkt-accent)" strokeWidth="2" />
      <line x1="220" y1="120" x2="160" y2="170" stroke="var(--mkt-accent)" strokeWidth="2" />
    </svg>
  );
}
```

- [ ] **Step 3: WorkspacesDiagram.tsx (7 adapter chips in a grid)**

```tsx
export function WorkspacesDiagram() {
  const labels = ["Claude", "Codex", "Cursor", "Gemini", "Pi", "OpenCode", "OpenClaw"];
  const cols = 4;
  return (
    <svg viewBox="0 0 320 200" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {labels.map((label, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = 20 + col * 75;
        const y = 40 + row * 60;
        const isHighlighted = i === 0;
        return (
          <g key={label}>
            <rect
              x={x}
              y={y}
              width="64"
              height="40"
              rx="6"
              fill={isHighlighted ? "var(--mkt-accent)" : "none"}
              stroke={isHighlighted ? "none" : "currentColor"}
            />
            <text
              x={x + 32}
              y={y + 24}
              textAnchor="middle"
              fontSize="11"
              fill={isHighlighted ? "#fff" : "currentColor"}
              stroke="none"
              fontFamily="var(--mkt-font-sans)"
            >{label}</text>
          </g>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 4: AgentPrimitivesDiagram.tsx (one block exploded into 4 sub-blocks)**

```tsx
export function AgentPrimitivesDiagram() {
  const subs = ["IDENTITY", "MEMORY", "HEARTBEAT", "TOOLS"];
  return (
    <svg viewBox="0 0 320 200" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {/* main agent block */}
      <rect x="20" y="80" width="80" height="40" rx="6" fill="var(--mkt-accent)" stroke="none" />
      <text x="60" y="104" textAnchor="middle" fontSize="11" fill="#fff" fontFamily="var(--mkt-font-mono)">AGENT</text>
      {/* connecting lines */}
      {subs.map((_, i) => (
        <line key={i} x1="100" y1={100} x2="180" y2={30 + i * 47} />
      ))}
      {/* sub-blocks */}
      {subs.map((label, i) => (
        <g key={label}>
          <rect x="180" y={20 + i * 47} width="100" height="30" rx="5" />
          <text x="230" y={39 + i * 47} textAnchor="middle" fontSize="10" fill="currentColor" fontFamily="var(--mkt-font-mono)">{label}</text>
        </g>
      ))}
    </svg>
  );
}
```

- [ ] **Step 5: InteropDiagram.tsx (concentric rings + perimeter chips)**

```tsx
export function InteropDiagram() {
  const chips = [
    { label: "HubSpot", angle: 0 },
    { label: "Slack", angle: 90 },
    { label: "Email", angle: 180 },
    { label: "Webhook", angle: 270 },
  ];
  return (
    <svg viewBox="0 0 320 200" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <circle cx="160" cy="100" r="30" fill="var(--mkt-accent)" stroke="none" />
      <text x="160" y="104" textAnchor="middle" fontSize="11" fill="#fff" fontFamily="var(--mkt-font-mono)">CORE</text>
      <circle cx="160" cy="100" r="60" />
      <circle cx="160" cy="100" r="80" strokeDasharray="2 4" />
      {chips.map((chip) => {
        const rad = (chip.angle * Math.PI) / 180;
        const x = 160 + Math.cos(rad) * 80;
        const y = 100 + Math.sin(rad) * 80;
        return (
          <g key={chip.label}>
            <rect x={x - 30} y={y - 12} width="60" height="24" rx="4" fill="var(--mkt-surface-cream)" />
            <text x={x} y={y + 4} textAnchor="middle" fontSize="10" fill="currentColor">{chip.label}</text>
          </g>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 6: TrustSafetyDiagram.tsx (shield over a ledger)**

```tsx
export function TrustSafetyDiagram() {
  return (
    <svg viewBox="0 0 320 200" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {/* ledger */}
      <rect x="80" y="100" width="160" height="80" rx="4" />
      {[120, 140, 160].map((y) => (
        <line key={y} x1="92" y1={y} x2="228" y2={y} />
      ))}
      {/* shield */}
      <path
        d="M160 20 L200 35 L200 70 Q200 95 160 110 Q120 95 120 70 L120 35 Z"
        fill="var(--mkt-accent)"
        stroke="none"
      />
      <path d="M148 65 L158 75 L175 55" stroke="#fff" strokeWidth="2.5" fill="none" />
    </svg>
  );
}
```

- [ ] **Step 7: ModelServingDiagram.tsx (three model chips below a horizontal rule)**

```tsx
export function ModelServingDiagram() {
  const models = ["Anthropic", "OpenAI", "Your own"];
  return (
    <svg viewBox="0 0 320 200" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {/* boundary line — what's above is AgentDash, below is the model layer */}
      <line x1="20" y1="60" x2="300" y2="60" strokeDasharray="4 4" />
      <text x="20" y="50" fontSize="10" fill="currentColor" fontFamily="var(--mkt-font-mono)">— AGENTDASH —</text>
      <text x="20" y="80" fontSize="10" fill="currentColor" fontFamily="var(--mkt-font-mono)">YOUR INFERENCE LAYER</text>
      {models.map((label, i) => {
        const x = 30 + i * 95;
        const isHighlighted = i === 2;
        return (
          <g key={label}>
            <rect x={x} y={110} width="80" height="50" rx="6" fill={isHighlighted ? "var(--mkt-accent)" : "none"} stroke={isHighlighted ? "none" : "currentColor"} />
            <text x={x + 40} y={140} textAnchor="middle" fontSize="11" fill={isHighlighted ? "#fff" : "currentColor"}>{label}</text>
          </g>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 8: Visual smoke — render all 7 in a scratch route OR run typecheck**

```sh
pnpm -F @agentdash/ui typecheck
```

Expected: clean.

- [ ] **Step 9: Commit**

```sh
git add ui/src/marketing/diagrams/
git commit -m "feat(marketing): SVG diagrams for the 7 architectural layers"
```

---

## Phase 4: Layered descent — the centerpiece

### Task 4.1: Layer data file

**Files:**
- Create: `ui/src/marketing/sections/LayeredDescent.layers.tsx`

- [ ] **Step 1: Create the file**

```tsx
import type { ReactNode } from "react";
import { ControlPlaneDiagram } from "../diagrams/ControlPlaneDiagram";
import { OrchestrationDiagram } from "../diagrams/OrchestrationDiagram";
import { WorkspacesDiagram } from "../diagrams/WorkspacesDiagram";
import { AgentPrimitivesDiagram } from "../diagrams/AgentPrimitivesDiagram";
import { InteropDiagram } from "../diagrams/InteropDiagram";
import { TrustSafetyDiagram } from "../diagrams/TrustSafetyDiagram";
import { ModelServingDiagram } from "../diagrams/ModelServingDiagram";

export interface DescentLayer {
  number: string;
  name: string;
  oneLine: string;
  diagram: ReactNode;
}

export const DESCENT_LAYERS: DescentLayer[] = [
  { number: "01", name: "Control Plane",        oneLine: "Where you run your AI company.",                       diagram: <ControlPlaneDiagram /> },
  { number: "02", name: "Orchestration",        oneLine: "Task graphs, dependencies, scheduling, approvals.",     diagram: <OrchestrationDiagram /> },
  { number: "03", name: "Workspaces & Adapters",oneLine: "The execution environments your agents actually run in.",diagram: <WorkspacesDiagram /> },
  { number: "04", name: "Agent Primitives",     oneLine: "Identity, memory, heartbeat, tools.",                   diagram: <AgentPrimitivesDiagram /> },
  { number: "05", name: "Interop",              oneLine: "How agents reach humans, systems, and each other.",     diagram: <InteropDiagram /> },
  { number: "06", name: "Trust & Safety",       oneLine: "Policies, budgets, audits, kill switch.",               diagram: <TrustSafetyDiagram /> },
  { number: "07", name: "Model Serving",        oneLine: "Inference. Your tokens, your models.",                  diagram: <ModelServingDiagram /> },
];
```

- [ ] **Step 2: Commit**

```sh
git add ui/src/marketing/sections/LayeredDescent.layers.tsx
git commit -m "feat(marketing): descent layer data for the 7-layer scroll"
```

### Task 4.2: LayeredDescent component (with reduced-motion fallback)

**Files:**
- Create: `ui/src/marketing/sections/LayeredDescent.tsx`
- Create: `ui/src/marketing/sections/LayeredDescent.css`
- Test: `ui/src/marketing/sections/__tests__/LayeredDescent.test.tsx`

- [ ] **Step 1: LayeredDescent.css**

```css
.mkt-descent {
  /* 7 layers × 100vh of scroll travel */
  height: 700vh;
  position: relative;
}
.mkt-descent__stage {
  position: sticky;
  top: 0;
  height: 100vh;
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: center;
  gap: 80px;
  padding: 0 var(--mkt-container-gutter);
  max-width: var(--mkt-container-max);
  margin-inline: auto;
  --descent-progress: 0;
  --layer-count: 7;
  --active-index: calc(var(--descent-progress) * (var(--layer-count) - 1));
}
.mkt-descent__rail {
  position: absolute;
  left: 24px;
  top: 50%;
  transform: translateY(-50%);
  display: grid;
  gap: 16px;
  font-family: var(--mkt-font-mono);
  font-size: 11px;
  color: var(--mkt-ink-soft);
}
.mkt-descent__rail-item--active {
  color: var(--mkt-accent);
}
.mkt-descent__slabs {
  position: relative;
  height: 80vh;
  perspective: 1200px;
  transform-style: preserve-3d;
}
.mkt-descent__slab {
  position: absolute;
  inset: 0;
  border: 1px solid var(--mkt-rule);
  background: var(--mkt-surface-cream-2);
  border-radius: 12px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  /* the per-slab JS sets --offset (signed integer relative to active) */
  --offset: 0;
  transform: translateY(calc(var(--offset) * 24px)) rotateX(calc(var(--offset) * 4deg));
  opacity: calc(1 - min(abs(var(--offset)), 3) * 0.25);
  transition: transform 320ms var(--mkt-ease), opacity 320ms var(--mkt-ease);
}
.mkt-descent__slab--active {
  border-color: var(--mkt-accent);
  background: var(--mkt-surface-cream);
  z-index: 10;
}
.mkt-descent__slab-edge {
  height: 4px;
  background: var(--mkt-accent);
  border-radius: 2px;
  width: 48px;
  margin-bottom: 16px;
}
.mkt-descent__panel {
  display: grid;
  gap: 24px;
}
.mkt-descent__panel h3 {
  font-family: var(--mkt-font-serif);
  font-weight: 500;
  font-size: clamp(36px, 5vw, 56px);
  line-height: 1.1;
  margin: 0;
}
.mkt-descent__panel-diagram {
  border: 1px solid var(--mkt-rule);
  border-radius: 8px;
  background: var(--mkt-surface-cream-2);
  padding: 16px;
  color: var(--mkt-ink);
}

/* reduced-motion fallback: no pin, no perspective, vertical stack */
.mkt-descent--reduced {
  height: auto;
}
.mkt-descent--reduced .mkt-descent__stage {
  position: static;
  height: auto;
  display: block;
  padding-block: 64px;
}
.mkt-descent--reduced .mkt-descent__slabs {
  height: auto;
  perspective: none;
}
.mkt-descent--reduced .mkt-descent__slab {
  position: static;
  transform: none;
  opacity: 1;
  margin-bottom: 24px;
  transition: none;
}
.mkt-descent--reduced .mkt-descent__rail { display: none; }
@media (max-width: 800px) {
  .mkt-descent { height: auto; }
  .mkt-descent__stage { position: static; height: auto; display: block; }
  .mkt-descent__slabs { height: auto; perspective: none; }
  .mkt-descent__slab { position: static; transform: none; opacity: 1; margin-bottom: 24px; }
  .mkt-descent__rail { display: none; }
}
```

- [ ] **Step 2: LayeredDescent.tsx**

```tsx
import "./LayeredDescent.css";
import { useEffect, useRef } from "react";
import { DESCENT_LAYERS } from "./LayeredDescent.layers";
import { useDescentProgress } from "../hooks/useDescentProgress";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";

export function LayeredDescent() {
  const reduced = usePrefersReducedMotion();
  const sectionRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // Always subscribe; in reduced-motion mode the value is ignored because CSS
  // overrides the slab positioning (no pin, no perspective, no transforms).
  const progress = useDescentProgress(sectionRef);

  // Active index from progress. Clamp to layer count.
  const lastIndex = DESCENT_LAYERS.length - 1;
  const activeIndex = Math.min(lastIndex, Math.max(0, Math.round(progress * lastIndex)));

  // Write the progress var so CSS can use it for fine-grain effects later.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    el.style.setProperty("--descent-progress", String(progress));
  }, [progress]);

  return (
    <div
      id="layered-descent"
      ref={sectionRef}
      className={`mkt-descent ${reduced ? "mkt-descent--reduced" : ""}`}
      aria-label="The seven layers of the agent stack"
    >
      <div ref={stageRef} className="mkt-descent__stage">
        {!reduced && (
          <ol className="mkt-descent__rail" aria-hidden>
            {DESCENT_LAYERS.map((l, i) => (
              <li
                key={l.number}
                className={i === activeIndex ? "mkt-descent__rail-item--active" : ""}
              >
                {l.number} {i === activeIndex ? l.name : ""}
              </li>
            ))}
          </ol>
        )}

        <div className="mkt-descent__slabs">
          {DESCENT_LAYERS.map((layer, i) => {
            const offset = i - activeIndex;
            const isActive = i === activeIndex;
            return (
              <section
                key={layer.number}
                className={`mkt-descent__slab ${isActive ? "mkt-descent__slab--active" : ""}`}
                style={{ ["--offset" as string]: String(offset) }}
                aria-current={isActive ? "true" : undefined}
              >
                <div className="mkt-descent__slab-edge" aria-hidden />
                <div className="mkt-eyebrow">{layer.number} / 07</div>
                <h3>{layer.name}</h3>
                <p className="mkt-body-lg">{layer.oneLine}</p>
              </section>
            );
          })}
        </div>

        <div className="mkt-descent__panel" aria-hidden>
          <div className="mkt-descent__panel-diagram">
            {DESCENT_LAYERS[activeIndex].diagram}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Test (reduced-motion mode renders all 7 layer names)**

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { LayeredDescent } from "../LayeredDescent";

describe("LayeredDescent (reduced motion)", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders all 7 layer names in the DOM", () => {
    render(<LayeredDescent />);
    const names = [
      "Control Plane",
      "Orchestration",
      "Workspaces & Adapters",
      "Agent Primitives",
      "Interop",
      "Trust & Safety",
      "Model Serving",
    ];
    names.forEach((n) => {
      expect(screen.getByRole("heading", { name: n })).toBeInTheDocument();
    });
  });

  it("uses the reduced-motion class on the wrapper", () => {
    const { container } = render(<LayeredDescent />);
    expect(container.querySelector(".mkt-descent--reduced")).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run test**

```sh
pnpm -F @agentdash/ui test LayeredDescent
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```sh
git add ui/src/marketing/sections/LayeredDescent.tsx ui/src/marketing/sections/LayeredDescent.css ui/src/marketing/sections/__tests__/LayeredDescent.test.tsx
git commit -m "feat(marketing): LayeredDescent with sticky pin + reduced-motion fallback"
```

---

## Phase 5: Landing page sections + composition

### Task 5.1: Hero section

**Files:**
- Create: `ui/src/marketing/sections/Hero.tsx`
- Create: `ui/src/marketing/sections/Hero.css`

- [ ] **Step 1: Hero.css**

```css
.mkt-hero {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 64px;
  align-items: center;
  padding-block: clamp(64px, 10vh, 128px);
}
.mkt-hero__copy { display: grid; gap: 32px; }
.mkt-hero__cta-row { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.mkt-hero__reassure { color: var(--mkt-ink-soft); font-size: 14px; }
.mkt-hero__art {
  border: 1px solid var(--mkt-rule);
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 24px 48px -24px rgba(31, 30, 29, 0.18);
  padding: 24px;
  color: var(--mkt-ink);
}
@media (max-width: 900px) {
  .mkt-hero { grid-template-columns: 1fr; }
}
```

- [ ] **Step 2: Hero.tsx**

```tsx
import "./Hero.css";
import { Eyebrow } from "../components/Eyebrow";
import { Button } from "../components/Button";
import { SectionContainer } from "../components/SectionContainer";

export function Hero() {
  return (
    <SectionContainer>
      <div className="mkt-hero">
        <div className="mkt-hero__copy">
          <Eyebrow>The control plane for your AI company</Eyebrow>
          <h1 className="mkt-display-hero">
            Run an AI workforce the way you'd run a company.
          </h1>
          <p className="mkt-body-lg">
            Goals, agents, budgets, and audit trails — in one control plane your
            board would actually approve of.
          </p>
          <div className="mkt-hero__cta-row">
            <Button href="/auth?mode=sign_up">Start free</Button>
            <Button href="#layered-descent" variant="ghost">See the architecture</Button>
          </div>
          <p className="mkt-hero__reassure">No credit card · Free single-seat tier</p>
        </div>
        <div className="mkt-hero__art" aria-hidden>
          <BriefingCardSvg />
        </div>
      </div>
    </SectionContainer>
  );
}

function BriefingCardSvg() {
  return (
    <svg viewBox="0 0 360 280" fill="none" stroke="currentColor" strokeWidth="1.2" role="img" aria-label="Sample morning briefing">
      <text x="20" y="32" fontSize="14" fill="currentColor" fontFamily="var(--mkt-font-serif)">AgentDash · Morning briefing</text>
      <line x1="20" y1="44" x2="340" y2="44" />
      {[0, 1, 2, 3, 4].map((i) => {
        const y = 70 + i * 36;
        const isHighlighted = i === 1;
        return (
          <g key={i}>
            <circle cx="34" cy={y} r="10" />
            <text x="56" y={y + 4} fontSize="11" fill="currentColor">Agent {i + 1}</text>
            <rect
              x="160"
              y={y - 10}
              width="60"
              height="20"
              rx="10"
              fill={isHighlighted ? "var(--mkt-accent)" : "none"}
              stroke={isHighlighted ? "none" : "currentColor"}
            />
            <text
              x="190"
              y={y + 4}
              textAnchor="middle"
              fontSize="10"
              fill={isHighlighted ? "#fff" : "currentColor"}
            >{isHighlighted ? "ATTN" : "ok"}</text>
            <text x="240" y={y + 4} fontSize="11" fill="currentColor">working: drafting Q3 report…</text>
          </g>
        );
      })}
      <line x1="20" y1="252" x2="340" y2="252" />
      <text x="40" y="272" fontSize="11" fill="currentColor" fontFamily="var(--mkt-font-mono)">$182</text>
      <text x="40" y="278" fontSize="9" fill="currentColor">today</text>
      <text x="160" y="272" fontSize="11" fill="currentColor" fontFamily="var(--mkt-font-mono)">17</text>
      <text x="160" y="278" fontSize="9" fill="currentColor">tasks done</text>
      <text x="280" y="272" fontSize="11" fill="currentColor" fontFamily="var(--mkt-font-mono)">3</text>
      <text x="280" y="278" fontSize="9" fill="currentColor">flagged</text>
    </svg>
  );
}
```

- [ ] **Step 3: Commit**

```sh
git add ui/src/marketing/sections/Hero.tsx ui/src/marketing/sections/Hero.css
git commit -m "feat(marketing): Hero with briefing-card SVG"
```

### Task 5.2: CapabilitiesGrid

**Files:**
- Create: `ui/src/marketing/sections/CapabilitiesGrid.tsx`
- Create: `ui/src/marketing/sections/CapabilitiesGrid.css`

- [ ] **Step 1: CapabilitiesGrid.css**

```css
.mkt-cap-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 48px;
}
.mkt-cap-tile { display: grid; gap: 12px; }
.mkt-cap-tile__icon { color: var(--mkt-ink); }
.mkt-cap-tile__title { font-weight: 600; font-size: 20px; }
.mkt-cap-tile__body { color: var(--mkt-ink-soft); }
@media (max-width: 800px) { .mkt-cap-grid { grid-template-columns: 1fr; } }
```

- [ ] **Step 2: CapabilitiesGrid.tsx**

```tsx
import "./CapabilitiesGrid.css";
import { Factory, GitBranch, ShieldAlert, BookOpen, ScrollText, Boxes } from "lucide-react";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";

const TILES = [
  { Icon: Factory,     title: "Agent Factory",      body: "Spawn from templates, scale up or down." },
  { Icon: GitBranch,   title: "Task Dependencies",  body: "Hierarchical work that traces to the goal." },
  { Icon: ShieldAlert, title: "Budget Hard-Stops",  body: "Spend caps you can defend in a board meeting." },
  { Icon: BookOpen,    title: "Skills Registry",    body: "Teach an agent once, reuse everywhere." },
  { Icon: ScrollText,  title: "Activity Audit",     body: "Every action, every decision, fully logged." },
  { Icon: Boxes,       title: "Multi-Adapter",      body: "Claude, Codex, Cursor, Gemini, Pi, OpenCode, OpenClaw." },
];

export function CapabilitiesGrid() {
  return (
    <SectionContainer>
      <Eyebrow>What's in the box</Eyebrow>
      <h2 className="mkt-display-section" style={{ marginTop: 16, marginBottom: 64 }}>
        Built for the work agents actually do.
      </h2>
      <div className="mkt-cap-grid">
        {TILES.map(({ Icon, title, body }) => (
          <div className="mkt-cap-tile" key={title}>
            <Icon className="mkt-cap-tile__icon" size={24} strokeWidth={1.5} />
            <div className="mkt-cap-tile__title">{title}</div>
            <div className="mkt-cap-tile__body">{body}</div>
          </div>
        ))}
      </div>
    </SectionContainer>
  );
}
```

- [ ] **Step 3: Commit**

```sh
git add ui/src/marketing/sections/CapabilitiesGrid.tsx ui/src/marketing/sections/CapabilitiesGrid.css
git commit -m "feat(marketing): CapabilitiesGrid with 6 tiles"
```

### Task 5.3: HowItWorks

**Files:**
- Create: `ui/src/marketing/sections/HowItWorks.tsx`
- Create: `ui/src/marketing/sections/HowItWorks.css`

- [ ] **Step 1: HowItWorks.css**

```css
.mkt-how-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 48px; }
.mkt-how-step__num {
  font-family: var(--mkt-font-serif);
  font-size: 64px;
  line-height: 1;
  color: var(--mkt-accent);
  margin-bottom: 16px;
}
.mkt-how-step__title { font-weight: 600; font-size: 20px; margin-bottom: 8px; }
.mkt-how-step__body { color: var(--mkt-ink-soft); }
@media (max-width: 800px) { .mkt-how-grid { grid-template-columns: 1fr; } }
```

- [ ] **Step 2: HowItWorks.tsx**

```tsx
import "./HowItWorks.css";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";

const STEPS = [
  { n: "01", title: "Create the company",       body: "Define the goal. AgentDash sets up the org, the budget, and the audit log." },
  { n: "02", title: "Hire the CEO and team",     body: "Pick adapters, define reporting lines, set the heartbeat. We provide sensible defaults." },
  { n: "03", title: "Watch the morning briefing",body: "Every day starts with a one-screen view of what your AI workforce did and what needs you." },
];

export function HowItWorks() {
  return (
    <SectionContainer background="cream-2">
      <Eyebrow>How it works</Eyebrow>
      <h2 className="mkt-display-section" style={{ marginTop: 16, marginBottom: 64 }}>
        Three steps to a running AI company.
      </h2>
      <div className="mkt-how-grid">
        {STEPS.map((s) => (
          <div key={s.n}>
            <div className="mkt-how-step__num">{s.n}</div>
            <div className="mkt-how-step__title">{s.title}</div>
            <div className="mkt-how-step__body">{s.body}</div>
          </div>
        ))}
      </div>
    </SectionContainer>
  );
}
```

- [ ] **Step 3: Commit**

```sh
git add ui/src/marketing/sections/HowItWorks.tsx ui/src/marketing/sections/HowItWorks.css
git commit -m "feat(marketing): HowItWorks with three steps"
```

### Task 5.4: ConsultingBand

**Files:**
- Create: `ui/src/marketing/sections/ConsultingBand.tsx`
- Create: `ui/src/marketing/sections/ConsultingBand.css`

- [ ] **Step 1: ConsultingBand.css**

```css
.mkt-cb { display: grid; grid-template-columns: 1.2fr 1fr; gap: 64px; align-items: center; }
.mkt-cb__copy { display: grid; gap: 24px; }
.mkt-cb__art { color: var(--mkt-ink); }
@media (max-width: 800px) { .mkt-cb { grid-template-columns: 1fr; } }
```

- [ ] **Step 2: ConsultingBand.tsx**

```tsx
import "./ConsultingBand.css";
import { SectionContainer } from "../components/SectionContainer";
import { Button } from "../components/Button";

export function ConsultingBand() {
  return (
    <SectionContainer background="cream-2">
      <div className="mkt-cb">
        <div className="mkt-cb__copy">
          <h2 className="mkt-display-section">Want this installed for you?</h2>
          <p className="mkt-body-lg" style={{ color: "var(--mkt-ink-soft)" }}>
            Our consulting practice deploys AgentDash inside enterprises — diagnose
            the highest-impact pain points, design the agent org, ship the first
            workforce in production, and stay through the first quarter of
            operation.
          </p>
          <div>
            <Button href="/consulting" variant="ghost">Talk to our consulting team</Button>
          </div>
        </div>
        <div className="mkt-cb__art" aria-hidden>
          <OrgChartSvg />
        </div>
      </div>
    </SectionContainer>
  );
}

function OrgChartSvg() {
  return (
    <svg viewBox="0 0 360 280" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {/* CEO node, coral */}
      <rect x="150" y="20" width="60" height="36" rx="6" fill="var(--mkt-accent)" stroke="none" />
      <text x="180" y="42" textAnchor="middle" fontSize="12" fill="#fff">CEO</text>
      {/* execs */}
      <line x1="180" y1="56" x2="180" y2="80" />
      <line x1="80" y1="80" x2="280" y2="80" />
      <line x1="80" y1="80" x2="80" y2="100" />
      <line x1="180" y1="80" x2="180" y2="100" />
      <line x1="280" y1="80" x2="280" y2="100" />
      {[
        { x: 60, label: "CTO" },
        { x: 160, label: "CMO" },
        { x: 260, label: "CFO" },
      ].map((n) => (
        <g key={n.label}>
          <rect x={n.x} y="100" width="40" height="28" rx="4" />
          <text x={n.x + 20} y="118" textAnchor="middle" fontSize="11" fill="currentColor">{n.label}</text>
        </g>
      ))}
      {/* reports */}
      {[60, 160, 260].map((x) => (
        <g key={x}>
          <line x1={x + 20} y1="128" x2={x + 20} y2="160" />
          <line x1={x - 8} y1="160" x2={x + 48} y2="160" />
          <line x1={x - 8} y1="160" x2={x - 8} y2="180" />
          <line x1={x + 48} y1="160" x2={x + 48} y2="180" />
          <rect x={x - 24} y="180" width="32" height="22" rx="3" />
          <rect x={x + 32} y="180" width="32" height="22" rx="3" />
        </g>
      ))}
    </svg>
  );
}
```

- [ ] **Step 3: Commit**

```sh
git add ui/src/marketing/sections/ConsultingBand.tsx ui/src/marketing/sections/ConsultingBand.css
git commit -m "feat(marketing): ConsultingBand with org-chart line drawing"
```

### Task 5.5: FinalCTA

**Files:**
- Create: `ui/src/marketing/sections/FinalCTA.tsx`
- Create: `ui/src/marketing/sections/FinalCTA.css`

- [ ] **Step 1: FinalCTA.css**

```css
.mkt-final {
  text-align: center;
  display: grid;
  gap: 32px;
  justify-items: center;
}
.mkt-final__cta-row { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; }
```

- [ ] **Step 2: FinalCTA.tsx**

```tsx
import "./FinalCTA.css";
import { SectionContainer } from "../components/SectionContainer";
import { Button } from "../components/Button";

export function FinalCTA() {
  return (
    <SectionContainer>
      <div className="mkt-final">
        <h2 className="mkt-display-section">Start running your AI company.</h2>
        <div className="mkt-final__cta-row">
          <Button href="/auth?mode=sign_up">Start free</Button>
          <Button href="mailto:consulting@agentdash.com" variant="ghost">Talk to sales</Button>
        </div>
      </div>
    </SectionContainer>
  );
}
```

- [ ] **Step 3: Commit**

```sh
git add ui/src/marketing/sections/FinalCTA.tsx ui/src/marketing/sections/FinalCTA.css
git commit -m "feat(marketing): FinalCTA with twin CTAs"
```

### Task 5.6: Compose Landing.tsx

**Files:**
- Modify: `ui/src/marketing/pages/Landing.tsx`

- [ ] **Step 1: Replace placeholder body with composed sections**

```tsx
import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@/lib/router";
import { authApi } from "../../api/auth";
import { queryKeys } from "../../lib/queryKeys";
import { healthApi } from "../../api/health";
import { MarketingShell } from "../MarketingShell";
import { Hero } from "../sections/Hero";
import { LayeredDescent } from "../sections/LayeredDescent";
import { CapabilitiesGrid } from "../sections/CapabilitiesGrid";
import { HowItWorks } from "../sections/HowItWorks";
import { ConsultingBand } from "../sections/ConsultingBand";
import { FinalCTA } from "../sections/FinalCTA";
import { SectionContainer } from "../components/SectionContainer";
import { LogoStrip } from "../components/LogoStrip";
import { QuoteBlock } from "../components/QuoteBlock";

const PLACEHOLDER_LOGOS = [
  { name: "Logo 1" },
  { name: "Logo 2" },
  { name: "Logo 3" },
  { name: "Logo 4" },
  { name: "Logo 5" },
];

export function Landing() {
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const isAuthenticatedMode = healthQuery.data?.deploymentMode === "authenticated";
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: isAuthenticatedMode,
    retry: false,
  });

  if (healthQuery.isLoading || (isAuthenticatedMode && sessionQuery.isLoading)) return null;
  const loggedIn = !isAuthenticatedMode || Boolean(sessionQuery.data);
  if (loggedIn) return <Navigate to="/companies" replace />;

  return (
    <MarketingShell>
      <Hero />
      <SectionContainer>
        <LogoStrip items={PLACEHOLDER_LOGOS} />
      </SectionContainer>
      <SectionContainer background="cream-2">
        <QuoteBlock
          quote="The first week our agents shipped, we caught up on six months of backlog. By month two, the board stopped asking how we'd staff the new initiative."
          attribution="— Placeholder: replace with a real operator quote"
        />
      </SectionContainer>
      <LayeredDescent />
      <CapabilitiesGrid />
      <HowItWorks />
      <ConsultingBand />
      <FinalCTA />
    </MarketingShell>
  );
}
```

- [ ] **Step 2: Verify**

```sh
pnpm -F @agentdash/ui typecheck && pnpm dev:once
```

Open `/` logged out — confirm hero loads, scroll smoothly through the descent (all 7 layers reveal one at a time), capabilities grid appears, footer renders.

- [ ] **Step 3: Commit**

```sh
git add ui/src/marketing/pages/Landing.tsx
git commit -m "feat(marketing): compose Landing page from sections"
```

---

## Phase 6: Consulting page

### Task 6.1: ConsultingPhases

**Files:**
- Create: `ui/src/marketing/sections/ConsultingPhases.tsx`
- Create: `ui/src/marketing/sections/ConsultingPhases.css`

- [ ] **Step 1: ConsultingPhases.css**

```css
.mkt-phases { display: grid; gap: 64px; max-width: 760px; }
.mkt-phase { display: grid; grid-template-columns: 80px 1fr; gap: 32px; padding-bottom: 48px; border-bottom: 1px solid var(--mkt-rule); }
.mkt-phase:last-child { border-bottom: none; }
.mkt-phase__num { font-family: var(--mkt-font-serif); font-weight: 500; font-size: 56px; line-height: 1; color: var(--mkt-accent); }
.mkt-phase__name { font-family: var(--mkt-font-serif); font-weight: 500; font-size: 32px; line-height: 1.1; margin-bottom: 12px; }
.mkt-phase__body { color: var(--mkt-ink-soft); margin-bottom: 12px; }
.mkt-phase__meta { display: flex; gap: 24px; font-family: var(--mkt-font-mono); font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--mkt-ink-soft); }
```

- [ ] **Step 2: ConsultingPhases.tsx**

```tsx
import "./ConsultingPhases.css";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";

const PHASES = [
  { n: "01", name: "Diagnose",   window: "2 weeks",   outcome: "Process map · pain ledger · readiness signal",
    body: "We sit with the team for two weeks. We map what actually happens day-to-day, document the points where work stalls, and produce a readiness signal that says where agents will land first." },
  { n: "02", name: "Design",     window: "2 weeks",   outcome: "Org chart · task hierarchy · guardrails",
    body: "We design the agent org chart, the task hierarchy that traces to a real business goal, and the guardrails — budget caps, approval gates, and the kill switch." },
  { n: "03", name: "Deploy",     window: "4 weeks",   outcome: "Agents in production · board oversight wired",
    body: "We ship the first agents into production. Real work. Real cost. Board oversight is wired in from day one — every action is logged and reviewable." },
  { n: "04", name: "Operate",    window: "Ongoing",   outcome: "Weekly review · scope expansion · handoff",
    body: "We run weekly reviews with the team that owns the workforce, expand scope as confidence builds, and eventually hand the keys back." },
];

export function ConsultingPhases() {
  return (
    <SectionContainer>
      <Eyebrow>How we work</Eyebrow>
      <h2 className="mkt-display-section" style={{ marginTop: 16, marginBottom: 64 }}>
        Four phases, not features.
      </h2>
      <div className="mkt-phases">
        {PHASES.map((p) => (
          <div key={p.n} className="mkt-phase">
            <div className="mkt-phase__num">{p.n}</div>
            <div>
              <h3 className="mkt-phase__name">{p.name}</h3>
              <p className="mkt-phase__body">{p.body}</p>
              <div className="mkt-phase__meta">
                <span>{p.window}</span>
                <span>{p.outcome}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </SectionContainer>
  );
}
```

- [ ] **Step 3: Commit**

```sh
git add ui/src/marketing/sections/ConsultingPhases.tsx ui/src/marketing/sections/ConsultingPhases.css
git commit -m "feat(marketing): ConsultingPhases (4 phases)"
```

### Task 6.2: ResearchBriefs

**Files:**
- Create: `ui/src/marketing/sections/ResearchBriefs.tsx`
- Create: `ui/src/marketing/sections/ResearchBriefs.css`

- [ ] **Step 1: ResearchBriefs.css**

```css
.mkt-briefs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px; }
.mkt-brief {
  border: 1px solid var(--mkt-rule);
  border-radius: 8px;
  padding: 24px;
  display: grid;
  gap: 12px;
  background: var(--mkt-surface-cream);
  transition: background-color 160ms var(--mkt-ease);
  text-decoration: none;
  color: inherit;
}
.mkt-brief:hover { background: var(--mkt-surface-cream-2); }
.mkt-brief__tag { font-family: var(--mkt-font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--mkt-ink-soft); }
.mkt-brief__title { font-family: var(--mkt-font-serif); font-weight: 500; font-size: 22px; line-height: 1.2; }
.mkt-brief__abstract { color: var(--mkt-ink-soft); font-size: 15px; }
.mkt-brief__cta { color: var(--mkt-accent-ink); font-size: 14px; }
@media (max-width: 800px) { .mkt-briefs { grid-template-columns: 1fr; } }
```

- [ ] **Step 2: ResearchBriefs.tsx**

```tsx
import "./ResearchBriefs.css";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";

const BRIEFS = [
  { tag: "FRAMEWORK", title: "The seven layers of the enterprise agent stack",
    abstract: "A taxonomy for what's in scope when you say 'agentify the enterprise.'" },
  { tag: "SYNTHESIS", title: "Why agent pilots stall in month two",
    abstract: "Patterns across the dozen pilots we've watched go quiet between week six and week ten." },
  { tag: "INDUSTRY", title: "Cross-industry agentification — what actually moved",
    abstract: "Where measurable productivity shifted, where it didn't, and what predicts which side you land on." },
  { tag: "FRAMEWORK", title: "Readiness signals we look for in the first call",
    abstract: "The five questions we ask in the first thirty minutes that decide whether a pilot is worth running." },
];

export function ResearchBriefs() {
  return (
    <SectionContainer background="cream-2" id="research">
      <Eyebrow>Research</Eyebrow>
      <h2 className="mkt-display-section" style={{ marginTop: 16, marginBottom: 64 }}>
        What we've learned mapping the agent factory landscape.
      </h2>
      <div className="mkt-briefs">
        {BRIEFS.map((b) => (
          <a key={b.title} href="#" className="mkt-brief">
            <div className="mkt-brief__tag">{b.tag}</div>
            <div className="mkt-brief__title">{b.title}</div>
            <div className="mkt-brief__abstract">{b.abstract}</div>
            <div className="mkt-brief__cta">Read brief →</div>
          </a>
        ))}
      </div>
    </SectionContainer>
  );
}
```

- [ ] **Step 3: Commit**

```sh
git add ui/src/marketing/sections/ResearchBriefs.tsx ui/src/marketing/sections/ResearchBriefs.css
git commit -m "feat(marketing): ResearchBriefs (4 placeholder cards)"
```

### Task 6.3: ReadinessBand

**Files:**
- Create: `ui/src/marketing/sections/ReadinessBand.tsx`
- Create: `ui/src/marketing/sections/ReadinessBand.css`

- [ ] **Step 1: ReadinessBand.css**

```css
.mkt-readiness { display: grid; grid-template-columns: 1.4fr 1fr; gap: 64px; align-items: center; }
@media (max-width: 800px) { .mkt-readiness { grid-template-columns: 1fr; } }
```

- [ ] **Step 2: ReadinessBand.tsx**

```tsx
import "./ReadinessBand.css";
import { SectionContainer } from "../components/SectionContainer";
import { Button } from "../components/Button";

export function ReadinessBand() {
  return (
    <SectionContainer>
      <div className="mkt-readiness">
        <div>
          <h2 className="mkt-display-section">Where does your company sit on the readiness curve?</h2>
          <p className="mkt-body-lg" style={{ color: "var(--mkt-ink-soft)", marginTop: 24 }}>
            We built a 20-minute structured intake for our own engagements. It produces a written readiness brief
            with the three pilots most likely to land in your first quarter.
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <Button href="/assess">Run the assessment</Button>
        </div>
      </div>
    </SectionContainer>
  );
}
```

- [ ] **Step 3: Commit**

```sh
git add ui/src/marketing/sections/ReadinessBand.tsx ui/src/marketing/sections/ReadinessBand.css
git commit -m "feat(marketing): ReadinessBand linking to /assess"
```

### Task 6.4: EngagementCards

**Files:**
- Create: `ui/src/marketing/sections/EngagementCards.tsx`
- Create: `ui/src/marketing/sections/EngagementCards.css`

- [ ] **Step 1: EngagementCards.css**

```css
.mkt-eng { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; }
.mkt-eng-card {
  border: 1px solid var(--mkt-rule);
  border-radius: 12px;
  padding: 40px;
  background: var(--mkt-surface-cream);
}
.mkt-eng-card__name { font-family: var(--mkt-font-serif); font-weight: 500; font-size: 32px; margin-bottom: 16px; }
.mkt-eng-card__body { color: var(--mkt-ink-soft); }
@media (max-width: 800px) { .mkt-eng { grid-template-columns: 1fr; } }
```

- [ ] **Step 2: EngagementCards.tsx**

```tsx
import "./EngagementCards.css";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";

export function EngagementCards() {
  return (
    <SectionContainer background="cream-2">
      <Eyebrow>Engagement</Eyebrow>
      <h2 className="mkt-display-section" style={{ marginTop: 16, marginBottom: 48 }}>
        Two ways to work with us.
      </h2>
      <div className="mkt-eng">
        <div className="mkt-eng-card">
          <div className="mkt-eng-card__name">Pilot</div>
          <div className="mkt-eng-card__body">4–6 weeks, fixed scope, fixed price. Goal: prove the workforce shipping real work in production.</div>
        </div>
        <div className="mkt-eng-card">
          <div className="mkt-eng-card__name">Production</div>
          <div className="mkt-eng-card__body">Quarterly retainer, expanding scope, embedded with your team. Goal: build the operating muscle to run agents long-term.</div>
        </div>
      </div>
    </SectionContainer>
  );
}
```

- [ ] **Step 3: Commit**

```sh
git add ui/src/marketing/sections/EngagementCards.tsx ui/src/marketing/sections/EngagementCards.css
git commit -m "feat(marketing): EngagementCards (Pilot vs Production)"
```

### Task 6.5: Compose Consulting.tsx

**Files:**
- Modify: `ui/src/marketing/pages/Consulting.tsx`

- [ ] **Step 1: Replace placeholder**

```tsx
import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { ConsultingPhases } from "../sections/ConsultingPhases";
import { ResearchBriefs } from "../sections/ResearchBriefs";
import { ReadinessBand } from "../sections/ReadinessBand";
import { EngagementCards } from "../sections/EngagementCards";

export function Consulting() {
  return (
    <MarketingShell>
      <SectionContainer>
        <Eyebrow>Consulting practice</Eyebrow>
        <h1 className="mkt-display-page" style={{ marginTop: 16, marginBottom: 32, maxWidth: "18ch" }}>
          We install AI workforces inside enterprises.
        </h1>
        <div style={{ display: "grid", gap: 24, maxWidth: "60ch", color: "var(--mkt-ink-soft)" }}>
          <p className="mkt-body-lg">
            Most enterprise AI pilots stall after the demo. The slideware is excellent.
            The integration is a slog. The first six months disappear.
          </p>
          <p className="mkt-body-lg">
            We run a structured deployment, not a slideware engagement. We sit with
            your team, ship agents into production within the first quarter, and stay
            through the first quarter of operation so the workforce becomes
            something the team owns — not a project we have to babysit.
          </p>
        </div>
      </SectionContainer>
      <ConsultingPhases />
      <ResearchBriefs />
      <ReadinessBand />
      <EngagementCards />
      <SectionContainer>
        <h2 className="mkt-display-section" style={{ textAlign: "center" }}>Tell us what you're trying to build.</h2>
        <p style={{ textAlign: "center", marginTop: 24 }}>
          <a href="mailto:consulting@agentdash.com">consulting@agentdash.com</a>
        </p>
      </SectionContainer>
    </MarketingShell>
  );
}
```

- [ ] **Step 2: Verify in browser**

```sh
pnpm dev:once
```

Open `/consulting` — confirm hero, four phases, four research cards, readiness band CTA navigates to `/assess`, engagement cards, contact line.

- [ ] **Step 3: Commit**

```sh
git add ui/src/marketing/pages/Consulting.tsx
git commit -m "feat(marketing): compose Consulting page"
```

---

## Phase 7: About page

### Task 7.1: AboutMission

**Files:**
- Create: `ui/src/marketing/sections/AboutMission.tsx`

- [ ] **Step 1: Create**

```tsx
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";

// FILL IN: mission — paragraph supplied by the user. Placeholder copy below.
const MISSION = "AgentDash exists so that any company can run an AI workforce with the same clarity, accountability, and safety it expects from its human teams.";

export function AboutMission() {
  return (
    <SectionContainer>
      <div style={{ textAlign: "center", marginBottom: 48 }}>
        <Eyebrow>Our mission</Eyebrow>
      </div>
      <p className="mkt-mission">{MISSION}</p>
    </SectionContainer>
  );
}
```

- [ ] **Step 2: Commit**

```sh
git add ui/src/marketing/sections/AboutMission.tsx
git commit -m "feat(marketing): AboutMission section (placeholder copy)"
```

### Task 7.2: AboutFounder

**Files:**
- Create: `ui/src/marketing/sections/AboutFounder.tsx`
- Create: `ui/src/marketing/sections/AboutFounder.css`

- [ ] **Step 1: AboutFounder.css**

```css
.mkt-founder-card {
  background: var(--mkt-surface-cream-2);
  border: 1px solid var(--mkt-rule);
  border-radius: 16px;
  padding: 80px 64px;
  max-width: 960px;
  margin-inline: auto;
}
.mkt-founder-card__title {
  text-align: center;
  font-family: var(--mkt-font-serif);
  font-weight: 600;
  font-size: 56px;
  margin-bottom: 56px;
}
.mkt-founder { display: grid; grid-template-columns: auto 1fr; gap: 48px; align-items: center; }
.mkt-founder__portrait {
  width: 160px;
  height: 160px;
  border-radius: 999px;
  border: 4px solid var(--mkt-accent);
  background: var(--mkt-rule);
  object-fit: cover;
  display: block;
}
.mkt-founder__name { font-family: var(--mkt-font-sans); font-weight: 600; font-size: 28px; margin-bottom: 16px; }
.mkt-founder__bio { color: var(--mkt-ink-soft); font-size: 17px; line-height: 1.55; margin-bottom: 16px; }
.mkt-founder__linkedin { display: inline-flex; align-items: center; gap: 8px; color: var(--mkt-accent-ink); text-decoration: none; }
.mkt-founder__linkedin:hover { text-decoration: underline; }
@media (max-width: 700px) {
  .mkt-founder-card { padding: 48px 24px; }
  .mkt-founder { grid-template-columns: 1fr; text-align: center; }
  .mkt-founder__portrait { margin-inline: auto; }
}
```

- [ ] **Step 2: AboutFounder.tsx**

```tsx
import "./AboutFounder.css";
import { Linkedin } from "lucide-react";
import { SectionContainer } from "../components/SectionContainer";

// FILL IN: founder.{name|portrait|bio|linkedin} — supplied by the user.
const FOUNDER = {
  name: "[Founder Name]",
  portrait: "", // empty string renders the placeholder ring
  bio: "[Title] of AgentDash | [Background line, modeled on yarda's: e.g., 'Former Google & Consulting professional focused on giving every company the operating clarity to run AI agents safely.']",
  linkedin: "https://www.linkedin.com/in/",
};

export function AboutFounder() {
  return (
    <SectionContainer>
      <div className="mkt-founder-card">
        <div className="mkt-founder-card__title">Who We Are</div>
        <div className="mkt-founder">
          {FOUNDER.portrait ? (
            <img src={FOUNDER.portrait} alt={FOUNDER.name} className="mkt-founder__portrait" />
          ) : (
            <div className="mkt-founder__portrait" aria-label="Portrait placeholder" />
          )}
          <div>
            <div className="mkt-founder__name">{FOUNDER.name}</div>
            <p className="mkt-founder__bio">{FOUNDER.bio}</p>
            <a href={FOUNDER.linkedin} className="mkt-founder__linkedin" target="_blank" rel="noreferrer">
              <Linkedin size={18} strokeWidth={1.5} aria-hidden /> Follow on LinkedIn
            </a>
          </div>
        </div>
      </div>
    </SectionContainer>
  );
}
```

- [ ] **Step 3: Commit**

```sh
git add ui/src/marketing/sections/AboutFounder.tsx ui/src/marketing/sections/AboutFounder.css
git commit -m "feat(marketing): AboutFounder card (placeholders for user content)"
```

### Task 7.3: Compose About.tsx

**Files:**
- Modify: `ui/src/marketing/pages/About.tsx`

- [ ] **Step 1: Replace placeholder**

```tsx
import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { AboutMission } from "../sections/AboutMission";
import { AboutFounder } from "../sections/AboutFounder";

export function About() {
  return (
    <MarketingShell>
      <SectionContainer>
        <Eyebrow>About</Eyebrow>
        <h1 className="mkt-display-page" style={{ marginTop: 16 }}>Why AgentDash exists.</h1>
      </SectionContainer>
      <AboutMission />
      <AboutFounder />
      <SectionContainer>
        <p style={{ textAlign: "center", color: "var(--mkt-ink-soft)" }}>
          Press, partnerships, careers — <a href="mailto:hello@agentdash.com">hello@agentdash.com</a>
        </p>
      </SectionContainer>
    </MarketingShell>
  );
}
```

- [ ] **Step 2: Verify in browser**

```sh
pnpm dev:once
```

Open `/about` — confirm hero, mission paragraph (centered serif), founder card with placeholder ring + name + bio + LinkedIn, contact line.

- [ ] **Step 3: Commit**

```sh
git add ui/src/marketing/pages/About.tsx
git commit -m "feat(marketing): compose About page"
```

---

## Phase 8: Assess + Auth restyle

### Task 8.1: Wrap AssessPage in MarketingShell + restyle

**Files:**
- Modify: `ui/src/pages/AssessPage.tsx`

- [ ] **Step 1: Read the existing render block**

```sh
grep -n "return (" ui/src/pages/AssessPage.tsx | head -5
```

Locate the top-level `return (` of the `AssessPage` component.

- [ ] **Step 2: Wrap the rendered tree in `<MarketingShell>`**

Add at the top of the file:
```tsx
import { MarketingShell } from "../marketing/MarketingShell";
```

Wrap the existing top-level returned JSX:
```tsx
return (
  <MarketingShell>
    <div className="mkt-root">
      {/* existing AssessPage content */}
    </div>
  </MarketingShell>
);
```

(The `mkt-root` class is already on `MarketingShell`'s outermost div, so the inner one is redundant — remove if duplicate.)

- [ ] **Step 3: Sweep className strings to swap dashboard tokens for marketing tokens**

For each occurrence in AssessPage.tsx:
- `bg-background`, `bg-white`, `bg-card` → `style={{ background: "var(--mkt-surface-cream)" }}` or `var(--mkt-surface-cream-2)` for raised cards
- `border-border` → `style={{ borderColor: "var(--mkt-rule)" }}`
- `text-foreground` / `text-muted-foreground` → `var(--mkt-ink)` / `var(--mkt-ink-soft)`
- shadcn `<Button>` (from `@/components/ui/button`) → marketing `<Button>` from `../marketing/components/Button`
- Phase title `<h1>`/`<h2>` → add `className="mkt-display-section"`

Do this minimally — preserve the layout, swap the surface only.

- [ ] **Step 4: Verify the 6 phases still render**

Run dev server, navigate `/assess`, walk through Start → Confirm → Form → DeepDive → Generating → Report. Each phase should render without console errors and visually inherit the cream + serif aesthetic.

- [ ] **Step 5: Commit**

```sh
git add ui/src/pages/AssessPage.tsx
git commit -m "feat(marketing): restyle AssessPage on the marketing shell"
```

### Task 8.2: Wrap AssessHistoryPage

**Files:**
- Modify: `ui/src/pages/AssessHistoryPage.tsx`

- [ ] **Step 1: Same wrap-and-sweep treatment as 8.1**

Apply identical changes: import `MarketingShell`, wrap the return, sweep classNames.

- [ ] **Step 2: Verify**

Hit `/assess/history` — table rows render on cream, dividers are hairlines, fonts are serif/sans per spec.

- [ ] **Step 3: Commit**

```sh
git add ui/src/pages/AssessHistoryPage.tsx
git commit -m "feat(marketing): restyle AssessHistoryPage on the marketing shell"
```

### Task 8.3: Restyle MarkdownBody for marketing surface

**Files:**
- Modify: `ui/src/components/MarkdownBody.tsx`
- Create (if missing): `ui/src/components/MarkdownBody.marketing.css`

- [ ] **Step 1: Read MarkdownBody to understand its styling boundary**

```sh
cat ui/src/components/MarkdownBody.tsx
```

If it already uses `.markdown-body` (or similar class), we can scope marketing styles by adding `.mkt-root .markdown-body { ... }`.

- [ ] **Step 2: Create MarkdownBody.marketing.css**

```css
.mkt-root .markdown-body {
  font-family: var(--mkt-font-sans);
  color: var(--mkt-ink);
  font-size: 17px;
  line-height: 1.65;
}
.mkt-root .markdown-body h1,
.mkt-root .markdown-body h2,
.mkt-root .markdown-body h3 {
  font-family: var(--mkt-font-serif);
  font-weight: 500;
  color: var(--mkt-ink);
}
.mkt-root .markdown-body h1 { font-size: 40px; line-height: 1.1; margin: 48px 0 16px; }
.mkt-root .markdown-body h2 { font-size: 28px; line-height: 1.15; margin: 40px 0 12px; }
.mkt-root .markdown-body h3 { font-size: 20px; line-height: 1.2; margin: 32px 0 8px; }
.mkt-root .markdown-body a { color: var(--mkt-accent-ink); }
.mkt-root .markdown-body code { background: var(--mkt-surface-cream-2); padding: 2px 6px; border-radius: 4px; font-family: var(--mkt-font-mono); font-size: 0.9em; }
.mkt-root .markdown-body pre { background: var(--mkt-surface-cream-2); padding: 16px; border-radius: 8px; overflow-x: auto; }
.mkt-root .markdown-body pre code { background: transparent; padding: 0; }
.mkt-root .markdown-body ul, .mkt-root .markdown-body ol { margin: 16px 0; padding-left: 24px; }
```

If MarkdownBody renders into a different class name, replace `.markdown-body` accordingly.

- [ ] **Step 3: Import the CSS**

In `MarkdownBody.tsx`, add at the top:
```tsx
import "./MarkdownBody.marketing.css";
```

(The styles are scoped behind `.mkt-root`, so they only apply when MarkdownBody renders inside the marketing shell.)

- [ ] **Step 4: Visual check**

Run a full Assess flow → Report phase. The rendered markdown should now use serif headings + sans body + cream code blocks.

- [ ] **Step 5: Commit**

```sh
git add ui/src/components/MarkdownBody.tsx ui/src/components/MarkdownBody.marketing.css
git commit -m "feat(marketing): MarkdownBody typography on marketing shell"
```

### Task 8.4: Light Auth restyle

**Files:**
- Modify: `ui/src/pages/Auth.tsx`

- [ ] **Step 1: Wrap in `<div className="mkt-root">`**

Just inside the top-level returned JSX of `AuthPage`, wrap the contents:
```tsx
return (
  <div className="mkt-root" style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}>
    {/* existing content */}
  </div>
);
```

- [ ] **Step 2: Restyle the heading to serif**

Replace the existing primary heading with:
```tsx
<h1 className="mkt-display-section">{mode === "sign_in" ? "Sign in to AgentDash" : "Create your AgentDash account"}</h1>
```

- [ ] **Step 3: Swap shadcn Buttons for marketing Buttons**

Replace `import { Button } from "@/components/ui/button"` with `import { Button } from "../marketing/components/Button"` and adjust API to match (the marketing Button uses `href` for anchors and `onClick` for buttons; submit buttons still need `type="submit"`).

- [ ] **Step 4: Verify**

Visit `/auth`. Confirm cream background, serif heading, coral primary submit. Sign-up disable behavior (when `disableSignUp` is true) is unchanged.

- [ ] **Step 5: Commit**

```sh
git add ui/src/pages/Auth.tsx
git commit -m "feat(marketing): light Auth restyle on cream + serif"
```

---

## Phase 9: E2E + verification

### Task 9.1: E2E — descent renders all 7 layer names

**Files:**
- Create: `tests/e2e/marketing-descent.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from "@playwright/test";

test.describe("layered descent", () => {
  test("all 7 layer names appear in the DOM after scrolling", async ({ page }) => {
    await page.goto("/");
    await page.locator("#layered-descent").scrollIntoViewIfNeeded();
    // Scroll past the descent so every layer has been activated at least once.
    await page.evaluate(() => window.scrollBy(0, 7000));
    const expected = [
      "Control Plane", "Orchestration", "Workspaces & Adapters",
      "Agent Primitives", "Interop", "Trust & Safety", "Model Serving",
    ];
    for (const name of expected) {
      await expect(page.getByRole("heading", { name })).toBeAttached();
    }
  });

  test("clicking 'See the architecture' anchors to #layered-descent", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "See the architecture" }).click();
    await expect(page).toHaveURL(/#layered-descent$/);
  });
});
```

- [ ] **Step 2: Run**

```sh
pnpm -F @agentdash/ui exec playwright test tests/e2e/marketing-descent.spec.ts
```

Expected: 2 passed.

- [ ] **Step 3: Commit**

```sh
git add tests/e2e/marketing-descent.spec.ts
git commit -m "test(marketing): e2e descent layer enumeration + anchor"
```

### Task 9.2: E2E — consulting flows

**Files:**
- Create: `tests/e2e/marketing-consulting.spec.ts`

- [ ] **Step 1: Write**

```ts
import { test, expect } from "@playwright/test";

test("consulting → run the assessment lands on /assess", async ({ page }) => {
  await page.goto("/consulting");
  await page.getByRole("link", { name: "Run the assessment" }).click();
  await expect(page).toHaveURL(/\/assess$/);
});

test("consulting page contains all 4 phase names", async ({ page }) => {
  await page.goto("/consulting");
  for (const name of ["Diagnose", "Design", "Deploy", "Operate"]) {
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
});
```

- [ ] **Step 2: Run**

```sh
pnpm -F @agentdash/ui exec playwright test tests/e2e/marketing-consulting.spec.ts
```

Expected: 2 passed.

- [ ] **Step 3: Commit**

```sh
git add tests/e2e/marketing-consulting.spec.ts
git commit -m "test(marketing): e2e consulting page checks"
```

### Task 9.3: E2E — about page renders

**Files:**
- Create: `tests/e2e/marketing-about.spec.ts`

- [ ] **Step 1: Write**

```ts
import { test, expect } from "@playwright/test";

test("about page renders mission and founder card", async ({ page }) => {
  await page.goto("/about");
  await expect(page.getByRole("heading", { level: 1, name: /why agentdash exists/i })).toBeVisible();
  await expect(page.getByText(/Who We Are/i)).toBeVisible();
});
```

- [ ] **Step 2: Run**

```sh
pnpm -F @agentdash/ui exec playwright test tests/e2e/marketing-about.spec.ts
```

Expected: 1 passed.

- [ ] **Step 3: Commit**

```sh
git add tests/e2e/marketing-about.spec.ts
git commit -m "test(marketing): e2e about page renders"
```

### Task 9.4: Final verification

- [ ] **Step 1: Full verification**

```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

All three must pass clean.

- [ ] **Step 2: Manual scroll smoke (cannot be automated)**

Open `/` in macOS Chrome, Safari, Firefox. Scroll through the descent on a trackpad. Each layer must:
- pin smoothly for one viewport-worth of scroll
- never trap the scroll (you can always scroll past)
- stay at sustained 60fps with DevTools 4× CPU throttle

If any browser exhibits trapped scroll or visible jank, swap the descent for the Approach 3 fallback (no pinning, only parallax) — guarded behind a CSS class on `.mkt-descent` per spec §17.

- [ ] **Step 3: Reduced-motion check**

Set Chrome DevTools → Rendering → "Emulate CSS prefers-reduced-motion: reduce". Reload `/`. Descent should render as a static stack with all 7 layers visible at full opacity and no perspective.

- [ ] **Step 4: Lighthouse**

```sh
pnpm dev:once
# in another terminal:
npx lighthouse http://localhost:3100/ --only-categories=performance,accessibility --view --quiet --chrome-flags="--headless"
```

Expected: a11y ≥ 95, perf ≥ 90.

- [ ] **Step 5: Final commit if any small fixes were needed**

```sh
git add -A
git commit -m "chore(marketing): final verification adjustments"
```

---

## Self-review notes (for reviewers reading the plan)

- All tasks are TDD where the unit is testable (hooks, primitives, descent in reduced-motion mode). Visual sections (Hero, Cards) are written then smoke-checked in the browser — pure-visual TDD is wasteful here and the plan is honest about that.
- File-layout boundary rule (§11 of the spec): every new component lives under `ui/src/marketing/` and imports nothing from `components/ui/*`. Reviewers should reject any task implementation that violates this.
- Placeholder content is concentrated in three places — Mission (§7.1), Founder card (§7.2), Logos & Quote (§5.6). Each placeholder is grep-able (`FILL IN:` comment or `Placeholder:` text). The spec's §19 list is the merge-blocking checklist.
- The redirect target for logged-in users hitting `/` is `/companies` (which already routes through `<UnprefixedBoardRedirect />` to the user's company dashboard). This preserves prior `/` behavior exactly.
- Phases 0–2 are foundational; Phase 9 is verification. Phases 3–8 can be parallelized across multiple subagents if executed via `subagent-driven-development`.

---

**End of plan.**
